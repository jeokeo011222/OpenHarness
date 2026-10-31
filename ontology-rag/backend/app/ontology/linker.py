"""实体链接：把用户口语、缩写、别名对齐到本体 IRI。

两段式，职责严格分开：

1. **抽取**（可选，DeepSeek Flash）：从文本里找出"哪些词是业务概念"。
   模型只输出**表面形式**，输出结构里根本没有 IRI 字段——它无法凭空
   指定一个不存在的本体类。这是本模块最重要的一条约束：
   让模型做它擅长的（分词、识别业务词），不让它做需要被校验的（映射）。
2. **对齐**（确定性，纯词表）：表面形式 → 规范化 → 最长别名匹配 →
   字符相似度兜底 → 本地名匹配。命中就给 IRI，不命中就明说未对齐。

第 2 步永远由本进程执行，因此同义词、别名、大小写、全半角的处理
全部可复现；关掉模型也能跑（`LLM_PROVIDER=offline` 或 `use_llm=False`）。

不做"猜一个最像的"式放开：低于阈值的候选直接标记 unknown，交给下游追问。
"""

from __future__ import annotations

import difflib
import json
import re
from dataclasses import dataclass, field
from typing import Any, Protocol, Sequence

from ..schemas import EntityMention
from .model import TOP, OntologyModel, normalize_term

# 从模型回复里抠出 JSON 对象（容忍 ```json 围栏与前后废话）
_JSON_RE = re.compile(r"\{.*\}", re.DOTALL)

EXTRACT_SYSTEM = """你是业务术语抽取器。从用户问题中找出属于给定本体词表的业务概念。

规则：
1. 只输出你的词表里出现过或以同义说法表达的概念，不要臆造新概念。
2. 只抽取名词性业务概念（对象、单据、字段、指标），不抽动词、疑问词、金额数字。
3. 每个概念给出原文里出现的**表面形式**（原样截取，不要改写、不要翻译）。
4. 不确定的一律不输出。宁缺毋滥。

只输出 JSON，不要任何解释：
{"mentions": [{"surface": "原文片段", "kind": "class|property|individual"}]}
"""


class ModelGateway(Protocol):
    """避免与 `app.llm` 形成循环依赖的最小协议。"""

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
    ) -> tuple[Any, Any]: ...


@dataclass(slots=True)
class EntityLinkResult:
    """一次实体链接的完整结果。"""

    mentions: list[EntityMention]
    normalized_text: str
    extractor: str
    unmapped: list[str] = field(default_factory=list)


class EntityLinker:
    """基于本体同义词表的确定性链接器。"""

    # 字符相似度兜底阈值：低于它就判定为未识别，避免把噪声映射成业务概念
    FUZZY_THRESHOLD = 0.86

    def __init__(self, ontology: OntologyModel) -> None:
        self.ontology = ontology
        self._aliases = ontology.aliases()
        # 长别名优先，避免"付款"抢先匹配掉"付款申请"
        self._ordered = sorted(self._aliases.items(), key=lambda item: len(item[0]), reverse=True)

    def link(self, text: str, *, domain: str | None = None) -> tuple[list[EntityMention], str]:
        """返回识别到的实体与归一化文本。"""
        normalized = normalize_term(text)
        mentions: list[EntityMention] = []
        consumed: list[tuple[int, int]] = []
        lowered = text.lower()

        for alias, (iri, kind) in self._ordered:
            if len(alias) < 2:
                continue
            start = lowered.find(alias.lower())
            if start < 0:
                continue
            end = start + len(alias)
            if any(not (end <= s or start >= e) for s, e in consumed):
                continue
            consumed.append((start, end))
            if domain is not None and kind == "class":
                # 域过滤按本体自己声明的命名空间走：写死三个内置前缀的话，
                # 本体中心新发布的域会被整体过滤成空集，症状是"发布了却检索不到"。
                # 域名未知时返回空元组，此时不过滤——宁可多召回让兼容性再筛一遍，
                # 也不要因为一个拼错的域名把候选全部抹掉。
                allowed = self.ontology.namespaces_for(domain)
                if allowed and not iri.startswith((*allowed, str(TOP))):
                    continue
            mentions.append(
                EntityMention(
                    surface=text[start:end],
                    normalized=normalize_term(text[start:end]),
                    iri=iri,
                    kind=kind,  # type: ignore[arg-type]
                    confidence=1.0,
                    source="lexicon",
                    alias=alias,
                )
            )

        if not mentions:
            fallback = self._fuzzy(normalized)
            if fallback is not None:
                mentions.append(fallback)

        mentions.sort(key=lambda m: len(m.surface), reverse=True)
        return mentions, normalized

    def align(self, surface: str, *, domain: str | None = None) -> EntityMention | None:
        """把单个表面形式对齐到 IRI；对不上返回 None（不猜）。"""
        normalized = normalize_term(surface)
        if not normalized:
            return None
        hit = self._aliases.get(normalized)
        if hit is not None:
            iri, kind = hit
            return EntityMention(
                surface=surface,
                normalized=normalized,
                iri=iri,
                kind=kind,  # type: ignore[arg-type]
                confidence=1.0,
                source="llm",
                alias=normalized,
            )
        fuzzy = self._fuzzy(normalized)
        if fuzzy is not None:
            fuzzy.surface = surface
            fuzzy.source = "llm"
            return fuzzy
        return None

    def _fuzzy(self, normalized: str) -> EntityMention | None:
        """整体相似度兜底：只在整个查询很短时启用，避免长句误配。"""
        if not normalized or len(normalized) > 12:
            return None
        best: tuple[float, str, str, str] | None = None
        for alias, (iri, kind) in self._aliases.items():
            if len(alias) < 2:
                continue
            ratio = difflib.SequenceMatcher(a=normalized, b=alias).ratio()
            if ratio >= self.FUZZY_THRESHOLD and (best is None or ratio > best[0]):
                best = (ratio, iri, kind, alias)
        if best is None:
            return None
        return EntityMention(
            surface=normalized,
            normalized=normalized,
            iri=best[1],
            kind=best[2],  # type: ignore[arg-type]
            confidence=round(best[0], 4),
            source="lexicon",
            alias=best[3],
        )


class HybridEntityLinker:
    """词表 + 模型的两段式链接器。

    模型不可用（无密钥/熔断/超时/输出非法）时自动退回纯词表，
    并在 `extractor` 字段里如实标注本次用了什么——
    调用方据此判断"这次结果有没有模型参与"，而不是靠猜。
    """

    def __init__(
        self,
        ontology: OntologyModel,
        gateway: ModelGateway | None = None,
        *,
        vocab_limit: int = 240,
        fuzzy_threshold: float | None = None,
    ) -> None:
        self.ontology = ontology
        self.lexicon = EntityLinker(ontology)
        self.gateway = gateway
        self.vocab_limit = max(20, vocab_limit)
        if fuzzy_threshold is not None:
            self.lexicon.FUZZY_THRESHOLD = fuzzy_threshold
        self._vocab = self._build_vocab()

    # ------------------------------ 词表 ------------------------------

    def _build_vocab(self) -> list[str]:
        """构造给模型看的本体词表（类与属性的中文标签 + 别名）。

        只给"概念词"，不给 IRI：模型看到的越少，能编造的空间越小。
        """
        terms: list[str] = []
        seen: set[str] = set()
        for info in self.ontology.classes.values():
            for term in info.terms:
                if len(term) >= 2 and term not in seen:
                    seen.add(term)
                    terms.append(term)
        for info in self.ontology.properties.values():
            for term in info.terms:
                if len(term) >= 2 and term not in seen:
                    seen.add(term)
                    terms.append(term)
        for alias in self.ontology.aliases():
            if len(alias) >= 2 and alias not in seen:
                seen.add(alias)
                terms.append(alias)
        return terms[: self.vocab_limit]

    # ------------------------------ 主流程 ------------------------------

    async def link(
        self,
        text: str,
        *,
        tenant_id: str = "demo",
        domain: str | None = None,
        use_llm: bool = True,
    ) -> EntityLinkResult:
        """先词表、再模型补充、最后合并。"""
        base, normalized = self.lexicon.link(text, domain=domain)
        if not use_llm or self.gateway is None:
            return EntityLinkResult(base, normalized, "lexicon")

        try:
            surfaces = await self._extract(text, tenant_id=tenant_id)
        except Exception:  # noqa: BLE001 - 模型侧任何失败都退回词表，不阻断
            return EntityLinkResult(base, normalized, "lexicon")

        if not surfaces:
            return EntityLinkResult(base, normalized, "llm+lexicon")

        mentions = list(base)
        covered = {normalize_term(item.surface) for item in base}
        unmapped: list[str] = []
        for surface in surfaces:
            key = normalize_term(surface)
            if len(key) < 2 or key in covered:
                continue
            aligned = self.lexicon.align(surface, domain=domain)
            if aligned is None:
                unmapped.append(surface)
                continue
            covered.add(key)
            mentions.append(aligned)

        mentions.sort(key=lambda item: (-len(item.surface), item.iri or ""))
        return EntityLinkResult(mentions, normalized, "llm+lexicon", unmapped)

    async def _extract(self, text: str, *, tenant_id: str) -> list[str]:
        """调用 Flash 抽取候选表面形式。"""
        if self.gateway is None:
            return []
        vocab = "、".join(self._vocab)
        user = f"本体词表：{vocab}\n\n用户问题：{text}\n\n输出 JSON。"
        result, _ = await self.gateway.complete(
            tenant_id=tenant_id,
            task="extract",
            system=EXTRACT_SYSTEM,
            user=user,
            # 抽取任务固定走 Flash：传空字符串避免用户措辞把路由带去强模型
            query="",
            temperature=0.0,
            max_tokens=512,
        )
        return self._parse_surfaces(getattr(result, "text", ""))


def _parse_surfaces(payload: str) -> list[str]:
    """从模型回复里取出表面形式列表。结构不对就当作没抽到。"""
    if not payload:
        return []
    match = _JSON_RE.search(payload)
    if match is None:
        return []
    try:
        parsed = json.loads(match.group(0))
    except json.JSONDecodeError:
        return []
    raw = parsed.get("mentions") if isinstance(parsed, dict) else None
    if not isinstance(raw, list):
        return []
    surfaces: list[str] = []
    for item in raw:
        if isinstance(item, dict):
            surface = item.get("surface")
            if isinstance(surface, str) and surface.strip():
                surfaces.append(surface.strip())
        elif isinstance(item, str) and item.strip():
            surfaces.append(item.strip())
    return surfaces[:32]


def surfaces_to_mentions(
    surfaces: Sequence[str], linker: EntityLinker, *, domain: str | None = None
) -> tuple[list[EntityMention], list[str]]:
    """把一组表面形式对齐成 mention 列表与未对齐清单。"""
    mentions: list[EntityMention] = []
    unmapped: list[str] = []
    for surface in surfaces:
        aligned = linker.align(surface, domain=domain)
        if aligned is None:
            unmapped.append(surface)
        else:
            mentions.append(aligned)
    return mentions, unmapped
