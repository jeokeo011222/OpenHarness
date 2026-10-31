"""本体制导三级混合检索。

对外只暴露四样东西：输入契约 `StructuredQuery`、执行服务 `HybridRetrievalService`、
打分函数 `scoring`、兼容性判定 `OntologyCompatibility`。
"""

from __future__ import annotations

from .compat import CompatVerdict, OntologyCompatibility
from .constraints import ConstraintSpec, known_names, properties_for, spec_for, target_classes_for
from .contract import ConstraintRef, EntityRef, StructuredQuery, TimeRange, local_of
from .planner import PlannedQuery, SparqlPlanner
from .scoring import ScoringConfig
from .service import HybridRetrievalService, RetrievalResult, TierReport

__all__ = [
    "CompatVerdict",
    "ConstraintRef",
    "ConstraintSpec",
    "EntityRef",
    "HybridRetrievalService",
    "OntologyCompatibility",
    "PlannedQuery",
    "RetrievalResult",
    "ScoringConfig",
    "SparqlPlanner",
    "StructuredQuery",
    "TierReport",
    "TimeRange",
    "known_names",
    "local_of",
    "properties_for",
    "spec_for",
    "target_classes_for",
]
