"""离线评估：口径与报告渲染。

刻意与 `app/retrieval` 解耦，也不依赖任何后端：评估脚本读到的数字必须能被
单独复算，而不是"再跑一遍服务看结果是否一样"。
"""

from __future__ import annotations

from .metrics import (
    CaseResult,
    EvidenceJudge,
    JudgeSpec,
    Summary,
    failed_case,
    judge_answer,
    spec_from_case,
    summarize,
)
from .report import render_csv, render_markdown

__all__ = [
    "CaseResult",
    "EvidenceJudge",
    "JudgeSpec",
    "Summary",
    "failed_case",
    "judge_answer",
    "render_csv",
    "render_markdown",
    "spec_from_case",
    "summarize",
]
