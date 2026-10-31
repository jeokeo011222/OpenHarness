"""打分函数：三级检索里所有数值口径的唯一定义处。

分开成纯函数而不是散在服务里，是因为排序一旦出问题，最先要回答的问题是
"这个 0.73 是怎么算出来的"。所有函数满足三条性质：

  * **有界**：每个通道的输出都落在 [0, 1]，否则权重配比（0.6/0.25/0.15）失去意义；
  * **单调**：输入变好，输出不会变差——否则调参无法推断；
  * **可解释**：每个因子都有名字，写进 `ScoredChunk.breakdown`。

三个刻意的设计选择：

1. 关键词用**饱和函数** `x/(x+k)` 而非 `x/max` 归一。BM25 与 `ts_rank_cd` 量纲不同，
   `x/max` 会被单个离群值压平（一条命中 20 次的条款能让其余全部趋近 0），
   饱和函数对离群不敏感，且换成另一种关键词后端时不需要重新标定。
2. 向量分数**先减基线再打折**。余弦 0.3 以下是噪声，直接当 0；高于基线部分
   乘 `vector_trust`(<1)，保证"同分时向量永远排在图谱之后"——这是"向量只作补充"
   的量化表达，而不是靠注释约束。
3. 文档优先级**只在最终排序乘一次**。优先级是证据来源的属性，不是检索通道的属性；
   在通道内也乘一遍的话，"低优先级条款同时被图谱和关键词命中"会被罚两次，
   这是融合排序最常见的失真来源。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Iterable, Mapping

from ..ontology.model import normalize_term
from .contract import local_of

# 文档优先级 -> 权重：现行制度 > 客户台账/合同 > 国标 > 历史资料
DEFAULT_PRIORITY_WEIGHTS: Mapping[int, float] = {10: 1.0, 20: 0.94, 30: 0.88, 40: 0.55}
# 来源未知时的保守权重：低于"合同/台账"，高于"历史资料"
UNKNOWN_PRIORITY_WEIGHT = 0.80

# 证据链深度 -> 路径强度。0：实体自带 chunkId；1：一跳；2：两跳（实例->条款->分块）
DEPTH_STRENGTH: Mapping[int, float] = {0: 1.0, 1: 0.92, 2: 0.84}
DEFAULT_DEPTH_STRENGTH = 0.75


@dataclass(frozen=True, slots=True)
class ScoringConfig:
    """全部可调参数集中在这里，改动必须同时改测试。"""

    weight_graph: float = 0.60
    weight_keyword: float = 0.25
    weight_vector: float = 0.15
    # 关键词饱和点：分数等于该值时映射到 0.5。BM25 典型命中在 3~12
    keyword_half_saturation: float = 6.0
    # 关键词分里"排序分"与"词覆盖率"的占比
    keyword_rank_share: float = 0.65
    # 向量相似度基线，低于它的相似度视为噪声
    vector_floor: float = 0.30
    # 向量信任折扣：<1 表示同分情况下让位于图谱与关键词
    vector_trust: float = 0.85
    # 本体重合度加成：每命中一个类 +10%，属性按 0.5 计
    ontology_bonus: float = 0.10
    # 加成项上限，防止标签多的长分块靠"标签堆叠"反超
    ontology_overlap_cap: float = 3.0
    # 交叉验证加分：同一分块被多个通道命中时的小额奖励
    cross_validation_bonus: float = 0.05
    # 临期降权窗口与幅度
    freshness_window_days: int = 30
    freshness_penalty: float = 0.10
    priority_weights: Mapping[int, float] = field(
        default_factory=lambda: dict(DEFAULT_PRIORITY_WEIGHTS)
    )

    @classmethod
    def from_settings(cls, settings: object) -> "ScoringConfig":
        """从 `Settings` 装配。只取存在的字段，便于单测直接构造最小配置。"""
        return cls(
            weight_graph=float(getattr(settings, "weight_graph", 0.60)),
            weight_keyword=float(getattr(settings, "weight_keyword", 0.25)),
            weight_vector=float(getattr(settings, "weight_vector", 0.15)),
            keyword_half_saturation=float(getattr(settings, "retrieval_keyword_half_saturation", 6.0)),
            vector_floor=float(getattr(settings, "retrieval_vector_floor", 0.30)),
            vector_trust=float(getattr(settings, "retrieval_vector_trust", 0.85)),
            ontology_bonus=float(getattr(settings, "retrieval_ontology_bonus", 0.10)),
            cross_validation_bonus=float(getattr(settings, "retrieval_cross_validation_bonus", 0.05)),
            freshness_window_days=int(getattr(settings, "retrieval_freshness_window_days", 30)),
            freshness_penalty=float(getattr(settings, "retrieval_freshness_penalty", 0.10)),
        )

    def weights(self) -> dict[str, float]:
        """权重字典（写进审计，保证"当时用的什么配比"可回放）。"""
        return {"graph": self.weight_graph, "keyword": self.weight_keyword, "vector": self.weight_vector}


# ------------------------------ 基础变换 ------------------------------


def saturate(value: float, half_saturation: float) -> float:
    """`x / (x + k)`：0 -> 0，k -> 0.5，无穷 -> 1。

    对离群值不敏感：一条命中 100 次的条款得 0.94，命中 10 次的得 0.63，
    不会出现"第一名 0.99、其余 0.02"的塌缩。
    """
    if value <= 0:
        return 0.0
    if half_saturation <= 0:
        return 1.0
    return value / (value + half_saturation)


def path_strength(depth: int | None) -> float:
    """证据链路径强度。深度未知时取保守值，不假定"命中即满分"。"""
    if depth is None:
        return DEFAULT_DEPTH_STRENGTH
    return DEPTH_STRENGTH.get(int(depth), DEFAULT_DEPTH_STRENGTH)


# ------------------------------ 三级通道分数 ------------------------------


def graph_score(depth: int | None, property_coverage: float) -> float:
    """图谱通道分数。

    = 0.7 × 路径强度 + 0.3 × 事实完整度

    路径强度衡量"证据离实体有多近"；事实完整度是约束要求的属性被真正取回的比例——
    只取到金额、取不到质保金比例的实体，回答"是否超付"的证据就是不完整的，
    该在排序上让位给数据齐全的分块。两项都由图结构决定，与 SPARQL 返回顺序无关，
    因此不会造成排序抖动。
    """
    coverage = max(0.0, min(1.0, property_coverage))
    return 0.70 * path_strength(depth) + 0.30 * coverage


def term_coverage(text: str, terms: Iterable[str]) -> float:
    """查询词在原文中的覆盖率：命中的词数 / 查询词总数。

    用**归一化后的子串匹配**而不是分词：中文条款里"付款申请"与"付款申请金额"
    必须算命中，按空格分词会漏掉。这是"匹配条款原文"这一诉求的最小实现。
    """
    normalized_terms = {normalize_term(term) for term in terms if term}
    normalized_terms.discard("")
    if not normalized_terms:
        return 0.0
    haystack = normalize_term(text)
    matched = sum(1 for term in normalized_terms if term in haystack)
    return matched / len(normalized_terms)


def keyword_score(rank_score: float, coverage: float, config: ScoringConfig) -> float:
    """关键词通道分数。

    = rank_share × saturate(后端排序分) + (1 - rank_share) × 词覆盖率

    两者都要：排序分反映词频与稀有度（"超付"比"合同"更有区分度），
    覆盖率反映**讲了几个方面**。只用排序分会把"某个词反复出现"的条款推到第一，
    只用覆盖率则退化成布尔匹配、丢掉排序信息。
    """
    share = max(0.0, min(1.0, config.keyword_rank_share))
    rank = saturate(rank_score, config.keyword_half_saturation)
    return share * rank + (1.0 - share) * max(0.0, min(1.0, coverage))


def vector_score(similarity: float, config: ScoringConfig) -> float:
    """向量通道分数：先去基线，再乘信任折扣。

    余弦相似度在不同模型上分布不同，但"低分段是噪声"这一点是共性；
    基线以下的相似度不进入候选（返回 0，由调用方丢弃），
    基线以上线性拉伸到 [0, vector_trust]。
    """
    if similarity <= config.vector_floor:
        return 0.0
    span = 1.0 - config.vector_floor
    if span <= 0:
        return 0.0
    scaled = (similarity - config.vector_floor) / span
    return max(0.0, min(1.0, scaled)) * config.vector_trust


# ------------------------------ 融合与业务加权 ------------------------------


def fuse(contributions: Iterable[tuple[str, float]], config: ScoringConfig) -> tuple[float, dict[str, float]]:
    """按固定权重相加，并对"多通道同时命中"给一次小额加分。

    加分幅度（默认 0.05）刻意小于任何单通道权重：它表达的是"两条独立通道
    互相印证"这一事实，不能让命中次数反过来支配排序。
    """
    weights = config.weights()
    total = 0.0
    breakdown: dict[str, float] = {}
    tiers = 0
    for tier, score in contributions:
        weight = weights.get(tier, 0.0)
        if weight <= 0:
            continue
        contribution = weight * max(0.0, min(1.0, score))
        total += contribution
        breakdown[tier] = round(contribution, 6)
        tiers += 1
    if tiers > 1:
        bonus = config.cross_validation_bonus * (tiers - 1)
        breakdown["cross_validation"] = round(bonus, 6)
        total += bonus
    return min(1.0, total), breakdown


def ontology_overlap(
    chunk_classes: Iterable[str],
    chunk_properties: Iterable[str],
    query_classes: Iterable[str],
    query_properties: Iterable[str],
) -> float:
    """本体重合度：类按 1 计，属性按 0.5 计。

    属性权重低于类，是因为一个类往往对应多个属性——按 1 计会让"标签多的分块"
    仅凭属性堆叠就反超真正命中目标类的分块。
    """
    classes = {local_of(item) for item in chunk_classes if item}
    properties = {local_of(item) for item in chunk_properties if item}
    wanted_classes = {local_of(item) for item in query_classes if item}
    wanted_properties = {local_of(item) for item in query_properties if item}
    hits = len(classes & wanted_classes) + 0.5 * len(properties & wanted_properties)
    return hits


def ontology_factor(overlap: float, config: ScoringConfig) -> float:
    """重合度 -> 乘性因子，带封顶。"""
    capped = max(0.0, min(config.ontology_overlap_cap, overlap))
    return 1.0 + config.ontology_bonus * capped


def doc_weight(priority: int, today: date, chunk_effective_to: date | None, config: ScoringConfig) -> float:
    """文档优先级权重（含临期降权）。

    临期降权只作用于"30 天内到期"的现行文件：它在提示"别把即将失效的口径
    当作长期依据"，而不是直接排除——排除是时效过滤的职责，不是打分的职责。
    """
    weight = config.priority_weights.get(int(priority), UNKNOWN_PRIORITY_WEIGHT)
    if chunk_effective_to is not None:
        remaining = (chunk_effective_to - today).days
        if 0 <= remaining <= config.freshness_window_days:
            weight *= 1.0 - config.freshness_penalty
    return weight


def finalize(
    base: float,
    *,
    overlap: float,
    chunk: object,
    today: date,
    config: ScoringConfig,
) -> tuple[float, dict[str, float]]:
    """最终排序分 = 融合分 × 本体重合加成 × 文档优先级。

    文档优先级只在这里出现一次（见模块注释第 3 点）。
    """
    factor = ontology_factor(overlap, config)
    priority = doc_weight(
        int(getattr(chunk, "priority", 30)),
        today,
        getattr(chunk, "effective_to", None),
        config,
    )
    score = max(0.0, base) * factor * priority
    return score, {
        "base": round(base, 6),
        "overlap": round(overlap, 3),
        "ontology_factor": round(factor, 6),
        "doc_weight": round(priority, 6),
    }
