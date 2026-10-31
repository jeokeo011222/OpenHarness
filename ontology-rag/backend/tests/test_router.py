"""模型路由、缓存与预算熔断测试。"""

from __future__ import annotations

import asyncio

import pytest

from app.container import Container
from app.errors import BudgetExceededError
from app.llm import ModelRouter, ResponseCache, TokenBudget
from app.ports import LLMResult


def test_router_prefers_flash_for_extraction(container: Container) -> None:
    """抽取类任务走 Flash，控制单位成本。"""
    choice = ModelRouter(container.settings).choose(task="extract", query="抽取合同主体")
    assert choice.model == container.settings.llm_model_flash
    assert choice.complexity == "simple"


def test_router_escalates_for_business_reasoning(container: Container) -> None:
    """超付判定属于强推理，路由到更强模型。"""
    router = ModelRouter(container.settings)
    assert router.choose(task="answer", query="这笔付款是否超付？").model == container.settings.llm_model_strong
    assert router.choose(task="nl2sparql", query="查询合同金额").model == container.settings.llm_model_strong


def test_cache_is_tenant_scoped(container: Container) -> None:
    """缓存键含租户，避免跨租户命中同一答案。"""
    cache = ResponseCache(ttl_seconds=60, max_entries=8)
    key_a = ResponseCache.key("demo", "m", "sys", "user")
    key_b = ResponseCache.key("other", "m", "sys", "user")
    assert key_a != key_b
    cache.set(key_a, LLMResult("答案", 10, 5, "m"))
    assert cache.get(key_a).text == "答案"
    assert cache.get(key_a).prompt_tokens == 0, "缓存命中不应重复计费"
    assert cache.get(key_b) is None


def test_task_budget_limit(container: Container) -> None:
    """单任务预估超限直接拒绝，不发上游请求。"""
    budget = TokenBudget(container.settings, container.audit)
    with pytest.raises(BudgetExceededError):
        asyncio.run(budget.ensure("demo", estimated_tokens=container.settings.task_token_limit + 1))


def test_daily_budget_fuse(container: Container) -> None:
    """当日累计超预算即熔断。"""
    budget = TokenBudget(container.settings, container.audit)
    asyncio.run(
        container.audit.append(
            {
                "trace_id": "budget-1",
                "tenant_id": "demo",
                "question": "预热",
                "prompt_tokens": 600,
                "completion_tokens": 500,
            }
        )
    )
    with pytest.raises(BudgetExceededError):
        asyncio.run(budget.ensure("demo", estimated_tokens=200))
