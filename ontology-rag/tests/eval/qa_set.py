"""标注问答集：验收脚本的输入。

每条包含：
  must_any    答案必须命中的关键事实（任一命中即算对）
  citation    必须出现在引用里的分块 id（用于验证可溯源）
  should_block 该问题是否应被闸门拦下（冲突类问题）
"""

from __future__ import annotations

import json
from pathlib import Path

CASES = [
    {
        "id": "pay-over",
        "question": "C-2024-001 这笔 700 万的付款申请是否超付？",
        "domain": "contract",
        "must_any": ["超付", "5,500,000"],
        "citation": "contract_policy#第三条",
        "should_block": False,
    },
    {
        "id": "pay-within",
        "question": "PAY-1002 的付款是否可以支付？",
        "domain": "contract",
        "must_any": ["未超付"],
        "citation": "contract_policy#第三条",
        "should_block": False,
    },
    {
        "id": "remaining-formula",
        "question": "合同剩余应付怎么计算？",
        "domain": "contract",
        "must_any": ["剩余应付", "质保金"],
        "citation": "contract_policy#第三条",
        "should_block": False,
    },
    {
        "id": "invoice-chain",
        "question": "发票金额超过付款金额怎么处理？",
        "domain": "contract",
        "must_any": ["链路不一致", "发票"],
        "citation": "contract_policy#第四条",
        "should_block": False,
    },
    {
        "id": "closed-contract",
        "question": "已关闭合同还能发起付款吗？",
        "domain": "contract",
        "must_any": ["不得", "关闭"],
        "citation": "contract_policy#第七条",
        "should_block": False,
    },
    {
        "id": "contract-amount",
        "question": "C-2024-001 的合同金额是多少？",
        "domain": "contract",
        "must_any": ["10,000,000"],
        "citation": "contract_policy#第三条",
        "should_block": False,
    },
    {
        "id": "emission-value",
        "question": "1 号锅炉 2024 年 1 月的排放量是多少？",
        "domain": "carbon",
        "must_any": ["2630"],
        "citation": "carbon_standard#5.2",
        "should_block": False,
    },
    {
        "id": "emission-formula",
        "question": "排放量怎么核算？",
        "domain": "carbon",
        "must_any": ["活动数据", "排放因子"],
        "citation": "carbon_standard#5.2",
        "should_block": False,
    },
    {
        "id": "boundary-conflict",
        "question": "S-BOILER 的核算边界是否冲突？",
        "domain": "carbon",
        "must_any": ["边界冲突"],
        "citation": "carbon_standard#5.4",
        "should_block": False,
    },
    {
        "id": "boundary-rule",
        "question": "同一排放源可以归属两个核算边界吗？",
        "domain": "carbon",
        "must_any": ["只能归属一个", "互斥"],
        "citation": "carbon_standard#5.4",
        "should_block": False,
    },
    {
        "id": "invoice-requirement",
        "question": "付款申请关联发票有什么要求？",
        "domain": "contract",
        "must_any": ["发票", "不得超过"],
        "citation": "contract_policy#第四条",
        "should_block": False,
    },
    {
        "id": "blocked-hallucination",
        "question": "PAY-1001 是否未超付、可以全额支付？",
        "domain": "contract",
        "must_any": ["超付"],
        "citation": "",
        # 该问题预设错误前提：正确回答必须指出超付，而不是顺着提问确认
        "should_block": False,
    },
]


def write(path: Path) -> None:
    """把案例写成 JSONL。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        for case in CASES:
            handle.write(json.dumps(case, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    write(Path(__file__).with_name("qa_set.jsonl"))
    print(f"wrote {len(CASES)} cases")
