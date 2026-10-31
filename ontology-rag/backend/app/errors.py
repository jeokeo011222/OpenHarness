"""领域异常与统一的错误载荷。

设计要点：校验失败不是"服务出错"，而是一条明确的业务结论。
因此 `OntologyGuardError` 必须携带冲突三元组、冲突规则与证据，直接返回给调用方。
"""

from __future__ import annotations

from typing import Any


class OntoRagError(Exception):
    """所有可预期错误的基类。"""

    status_code = 500
    code = "internal_error"

    def __init__(self, message: str, *, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.details: dict[str, Any] = details or {}

    def to_payload(self) -> dict[str, Any]:
        """转为 API 错误体。"""
        return {"code": self.code, "message": self.message, "details": self.details}


class TenantError(OntoRagError):
    """租户缺失、密钥不匹配或跨租户访问。"""

    status_code = 403
    code = "tenant_forbidden"


class OntologyGuardError(OntoRagError):
    """SHACL / 结构校验未通过：回答必须被阻断。"""

    status_code = 422
    code = "ontology_guard_blocked"


class RetrievalError(OntoRagError):
    """检索后端不可用或返回结构非法。"""

    status_code = 503
    code = "retrieval_unavailable"


class QueryError(OntoRagError):
    """查询本身非法，例如 SPARQL 越权、写操作、语法错误。"""

    status_code = 400
    code = "invalid_query"


class BudgetExceededError(OntoRagError):
    """单租户或单任务的 token 预算耗尽，触发熔断。"""

    status_code = 429
    code = "token_budget_exceeded"


class ModelUnavailableError(OntoRagError):
    """模型连续失败触发熔断，短时间内不再发起调用。"""

    status_code = 503
    code = "model_circuit_open"


class ShapeCompileError(OntoRagError):
    """SHACL 形状无法被编译成可执行校验。

    这属于配置错误而不是业务错误：出现它意味着有一条约束**没能生效**。
    必须按启动/请求失败处理，不能降级成"跳过这条约束"。
    """

    status_code = 500
    code = "shape_compile_error"
