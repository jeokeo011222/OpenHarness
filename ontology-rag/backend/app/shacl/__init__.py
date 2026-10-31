"""SHACL 校验层：形状编译 + 执行引擎。

对外只暴露 `compiler.compile_shapes`、`engine.build_engine` 与两个引擎类，
上层（`ontology.validator`）负责把结果组装成 `GuardReport`。
"""

from .compiler import CompiledConstraint, ShapeCompiler, compile_shapes, substitute
from .engine import (
    BLOCKING_SEVERITY,
    FusekiShaclEngine,
    LocalShaclEngine,
    ShaclEngine,
    build_engine,
    is_blocking,
    partition,
    severity_rank,
)

__all__ = [
    "BLOCKING_SEVERITY",
    "CompiledConstraint",
    "FusekiShaclEngine",
    "LocalShaclEngine",
    "ShaclEngine",
    "ShapeCompiler",
    "build_engine",
    "compile_shapes",
    "is_blocking",
    "partition",
    "severity_rank",
    "substitute",
]
