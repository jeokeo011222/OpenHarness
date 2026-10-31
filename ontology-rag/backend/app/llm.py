"""模型路由 / 缓存 / 预算熔断。

路由原则（写死在代码里，不接受运行期偷偷改模型）：
- 简单抽取、摘要、分块打标 —— DeepSeek 4.1 Flash
- NL2SPARQL、多跳业务推理、冲突裁定 —— 更强模型
理由：前者量大且模式固定，后者错一次就要人工返工，单位成本完全不同。
"""

from __future__ import annotations

import hashlib
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any

from .errors import BudgetExceededError, ModelUnavailableError
from .ports import LLMClient, LLMResult
from .settings import Settings

# 触发强模型的关键词：问"为什么/是否/冲突/对比"这类需要跨条款推理的问题
_COMPLEX_HINTS = (
    "为什么",
    "是否",
    "冲突",
    "对比",
    "比较",
    "校验",
    "推算",
    "核算",
    "链路",
    "超付",
    "剩余应付",
    "边界",
    "合规吗",
    "能不能付",
    "should",
    "conflict",
)

# 固定走 Flash 的任务：模式固定、量大、单次出错代价低。
# 必须硬钉住——否则用户问题里只要出现"是否"，实体抽取也会被
# `_COMPLEX_HINTS` 带去强模型，成本翻十倍而效果不变。
_FLASH_ONLY_TASKS = frozenset({"extract", "chunk_label", "summarize"})


@dataclass(frozen=True, slots=True)
class ModelChoice:
    """一次路由决策及其理由（理由要进审计，便于复盘成本）。"""

    model: str
    task: str
    complexity: str
    reason: str


class ModelRouter:
    """按任务类型与查询复杂度选择模型。"""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def choose(self, *, task: str, query: str = "", complexity: str = "simple") -> ModelChoice:
        """返回模型与决策理由。"""
        if task in _FLASH_ONLY_TASKS:
            return ModelChoice(
                self.settings.llm_model_flash,
                task,
                "simple",
                f"Flash：任务={task} 属固定路由表，不受查询措辞影响",
            )
        lowered = query.lower()
        hit = next((hint for hint in _COMPLEX_HINTS if hint in lowered), None)
        if task in {"nl2sparql", "reasoning", "conflict"} or complexity == "complex" or hit:
            reason = f"强模型：任务={task}，复杂度={complexity}" + (f"，命中线索「{hit}」" if hit else "")
            return ModelChoice(self.settings.llm_model_strong, task, "complex", reason)
        return ModelChoice(
            self.settings.llm_model_flash,
            task,
            "simple",
            f"Flash：任务={task}，模式固定、吞吐优先",
        )


class ResponseCache:
    """进程内 TTL + LRU 缓存。相同租户相同提示词不重复付费。"""

    def __init__(self, *, ttl_seconds: int, max_entries: int) -> None:
        self.ttl_seconds = ttl_seconds
        self.max_entries = max_entries
        self._store: OrderedDict[str, tuple[float, LLMResult]] = OrderedDict()

    @staticmethod
    def key(tenant_id: str, model: str, system: str, user: str) -> str:
        """缓存键包含租户，避免跨租户命中。"""
        digest = hashlib.sha256(f"{tenant_id}\x00{model}\x00{system}\x00{user}".encode("utf-8")).hexdigest()
        return digest

    def get(self, key: str) -> LLMResult | None:
        """命中则返回副本并刷新 LRU 顺序。"""
        item = self._store.get(key)
        if item is None:
            return None
        expires_at, result = item
        if expires_at < time.monotonic():
            self._store.pop(key, None)
            return None
        self._store.move_to_end(key)
        return LLMResult(result.text, 0, 0, result.model, cached=True)

    def set(self, key: str, result: LLMResult) -> None:
        """写入并淘汰最旧条目。"""
        self._store[key] = (time.monotonic() + self.ttl_seconds, result)
        self._store.move_to_end(key)
        while len(self._store) > self.max_entries:
            self._store.popitem(last=False)


class CircuitBreaker:
    """连续失败熔断，避免上游故障时拖垮整条链路。"""

    def __init__(self, *, threshold: int, reset_seconds: float) -> None:
        self.threshold = threshold
        self.reset_seconds = reset_seconds
        self._failures = 0
        self._opened_at = 0.0

    def before_call(self) -> None:
        """熔断打开期间直接拒绝。"""
        if self._failures >= self.threshold and (time.monotonic() - self._opened_at) < self.reset_seconds:
            raise ModelUnavailableError(
                "模型连续失败，已熔断",
                details={"failures": self._failures, "reset_seconds": self.reset_seconds},
            )

    def record_success(self) -> None:
        """成功即复位。"""
        self._failures = 0

    def record_failure(self) -> None:
        """累计失败次数。"""
        self._failures += 1
        if self._failures >= self.threshold:
            self._opened_at = time.monotonic()


class TokenBudget:
    """按租户的日预算与单任务上限。"""

    def __init__(self, settings: Settings, audit: Any) -> None:
        self.settings = settings
        self.audit = audit

    async def ensure(self, tenant_id: str, *, estimated_tokens: int) -> None:
        """调用前检查：超预算直接拒绝，不发请求。"""
        if estimated_tokens > self.settings.task_token_limit:
            raise BudgetExceededError(
                f"单任务预估 token {estimated_tokens} 超过上限 {self.settings.task_token_limit}",
                details={"estimated_tokens": estimated_tokens},
            )
        usage = await self.audit.usage(tenant_id, days=1)
        if int(usage.get("total_tokens", 0)) + estimated_tokens > self.settings.daily_token_budget:
            raise BudgetExceededError(
                "租户当日 token 预算已耗尽",
                details={"used": usage.get("total_tokens", 0), "budget": self.settings.daily_token_budget},
            )


class LLMService:
    """对管线暴露的唯一模型入口：路由 + 缓存 + 熔断 + 计量。"""

    def __init__(
        self,
        client: LLMClient,
        router: ModelRouter,
        cache: ResponseCache,
        budget: TokenBudget,
        breaker: CircuitBreaker,
        settings: Settings,
    ) -> None:
        self.client = client
        self.router = router
        self.cache = cache
        self.budget = budget
        self.breaker = breaker
        self.settings = settings

    async def complete(
        self,
        *,
        tenant_id: str,
        task: str,
        system: str,
        user: str,
        query: str = "",
        complexity: str = "simple",
        temperature: float = 0.0,
        max_tokens: int = 2048,
    ) -> tuple[LLMResult, ModelChoice]:
        """执行一次受控调用。"""
        choice = self.router.choose(task=task, query=query, complexity=complexity)
        cache_key = ResponseCache.key(tenant_id, choice.model, system, user)
        cached = self.cache.get(cache_key)
        if cached is not None:
            return cached, choice

        estimated = max(1, (len(system) + len(user)) // 4) + max_tokens
        await self.budget.ensure(tenant_id, estimated_tokens=estimated)

        self.breaker.before_call()
        try:
            result = await self.client.complete(
                model=choice.model,
                system=system,
                user=user,
                temperature=temperature,
                max_tokens=max_tokens,
                timeout=self.settings.llm_timeout_seconds,
            )
        except Exception:
            self.breaker.record_failure()
            raise
        self.breaker.record_success()
        self.cache.set(cache_key, result)
        return result, choice
