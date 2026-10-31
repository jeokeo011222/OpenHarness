"""约束注册表：业务约束 -> 目标类 + 必须投影的属性。

检索层**只取事实，不做判定**。这张表的职责只有一个：把「用户提了哪条业务约束」
翻译成「SPARQL 该以哪个类为主体、把哪些属性取回来」，同时作为本体兼容性判定
的属性来源（一条关于"超付"的问题，天然对合同金额、已付金额这些属性敏感）。

判定本身在 SHACL，不在这里——检索层一旦开始算"是否超付"，
事实与结论就混在一层，闸门也就失去独立的校验对象。

新增一条约束只需要在这里登记一行；未登记的约束名会被 planner 忽略并留下
`unknown-constraint` 备注，而不是静默当成没有约束。
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class ConstraintSpec:
    """一条约束在检索侧的投影需求。"""

    # 与 SHACL 形状本地名一致，便于把校验结论与召回依据对上
    name: str
    # 约束的主体类（本地名）：SPARQL 用它兜底构造实体空间
    target_class: str
    # 约束成立所依赖的属性（带前缀，如 con:contractAmount）
    properties: tuple[str, ...]
    # 该属性是否必须存在：默认 False。缺失属性不该让实体整条消失，
    # 否则"数据不全"会被误读成"这个实体不存在"——两类问题必须区分。
    required: bool = False


# 只登记数据质量类形状。`claim_shapes.ttl` 里的是**输出闸门**，
# 作用对象是模型给出的断言而不是库里的实例，不该影响召回。
_REGISTRY: dict[str, ConstraintSpec] = {
    # ---------------- 合同付款风控 ----------------
    "PaymentWithinRemaining": ConstraintSpec(
        name="PaymentWithinRemaining",
        target_class="PaymentApplication",
        properties=(
            "con:paymentAmount",
            "con:contractAmount",
            "con:paidAmount",
            "con:retentionRate",
        ),
    ),
    "InvoiceTotalWithinPayment": ConstraintSpec(
        name="InvoiceTotalWithinPayment",
        target_class="PaymentApplication",
        properties=("con:paymentAmount", "con:invoiceAmount"),
    ),
    "PaymentRequiresContract": ConstraintSpec(
        name="PaymentRequiresContract",
        target_class="PaymentApplication",
        properties=("con:appliesToContract",),
    ),
    "ClosedContractAcceptsNoPayment": ConstraintSpec(
        name="ClosedContractAcceptsNoPayment",
        target_class="Contract",
        # closedAt 缺失时只能给告警，所以不是 required
        properties=("con:contractStatus", "con:closedAt", "con:hasPaymentApplication"),
    ),
    "ContractCoreFields": ConstraintSpec(
        name="ContractCoreFields",
        target_class="Contract",
        properties=("con:contractAmount", "con:contractStatus"),
    ),
    # ---------------- 碳核算边界 ----------------
    "EmissionSourceSingleBoundary": ConstraintSpec(
        name="EmissionSourceSingleBoundary",
        target_class="EmissionSource",
        properties=("car:belongsToBoundary", "car:exclusivityGroup"),
    ),
    "EmissionAmountMatchesFactor": ConstraintSpec(
        name="EmissionAmountMatchesFactor",
        target_class="EmissionRecord",
        properties=("car:emissionAmount", "car:activityData", "car:usesFactor"),
    ),
    "BoundaryApproachRequired": ConstraintSpec(
        name="BoundaryApproachRequired",
        target_class="AccountingBoundary",
        properties=("car:boundaryApproach",),
    ),
    "EmissionRecordTraceable": ConstraintSpec(
        name="EmissionRecordTraceable",
        target_class="EmissionRecord",
        properties=("car:usesFactor",),
    ),
}

# 约束名大小写容错：模型可能输出 `paymentWithinRemaining`
_LOWER_INDEX: dict[str, str] = {name.lower(): name for name in _REGISTRY}


def spec_for(name: str) -> ConstraintSpec | None:
    """按名字取约束规格；未登记返回 None（调用方必须显式披露，不得当成无约束）。"""
    if not name:
        return None
    key = _LOWER_INDEX.get(name.strip().lower())
    return _REGISTRY.get(key) if key else None


def known_names() -> tuple[str, ...]:
    """已登记的约束名（用于健康检查与文档生成）。"""
    return tuple(_REGISTRY)


def properties_for(names: tuple[str, ...] | list[str]) -> tuple[str, ...]:
    """一组约束名 -> 去重后的属性列表（保序，便于断言）。"""
    seen: dict[str, None] = {}
    for name in names:
        spec = spec_for(name)
        if spec is None:
            continue
        for prop in spec.properties:
            seen.setdefault(prop, None)
    return tuple(seen)


def target_classes_for(names: tuple[str, ...] | list[str]) -> tuple[str, ...]:
    """一组约束名 -> 去重后的主体类（保序）。"""
    seen: dict[str, None] = {}
    for name in names:
        spec = spec_for(name)
        if spec is not None:
            seen.setdefault(spec.target_class, None)
    return tuple(seen)
