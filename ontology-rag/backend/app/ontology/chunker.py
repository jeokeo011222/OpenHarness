"""本体感知语义分块（Ontology Chunking）。

禁止固定长度切块。分块边界只由「业务单元」决定：
  - 单条款：第X条 / Article N / 1.2 款项
  - 单规则：以"应/不得/须/必须"开头的独立规则句
  - 单字段定义："字段：..." / "定义：..." / "口径：..."

每个 chunk 强制携带：本体标签、来源权重标签、生效时间标签、版本与作废标记。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date

from ..schemas import Chunk
from .model import OntologyModel, normalize_term

# 条款起始：第X条 / 第X.X条 / Article 5 / 5.1 标题
_CLAUSE_RE = re.compile(
    r"^\s*(?:第[一二三四五六七八九十百零\d]+条|第\d+(?:\.\d+)*条|Article\s+\d+|\d+(?:\.\d+){1,3}\s+\S)"
)
# 字段/口径定义
_FIELD_RE = re.compile(r"^\s*(?:字段|口径|定义|指标)\s*[:：]\s*\S")
# 仅用于超长条款内部的兜底断句，绝不是固定长度切块
_SENTENCE_RE = re.compile(r"(?<=[。！？；;])")

# 文档类型 -> 默认优先级（数字越小越优先）
DOC_PRIORITY = {
    "regulation": 10,  # 现行正式制度
    "contract": 20,  # 当前客户合同/台账
    "ledger": 20,
    "standard": 30,  # 国标规范
    "archive": 40,  # 历史参考资料
}

# 单条业务单元的字数上限：超限才按句子切，且保留同一 clause_no
MAX_UNIT_CHARS = 1200


@dataclass(slots=True)
class DocumentMeta:
    """待分块文档的元数据，来自解析器或同步任务。"""

    tenant_id: str
    doc_id: str
    title: str
    doc_type: str = "regulation"
    version: str = "v1"
    effective_from: date | None = None
    effective_to: date | None = None
    superseded_by: str | None = None


class OntologyChunker:
    """按业务单元切分，并把本体标签打到 chunk 上。"""

    def __init__(self, ontology: OntologyModel) -> None:
        self.ontology = ontology

    def chunk(self, text: str, meta: DocumentMeta, *, today: date | None = None) -> list[Chunk]:
        """切分一篇文档。"""
        today = today or date.today()
        units = self._split_units(text)
        priority = DOC_PRIORITY.get(meta.doc_type, 30)
        deprecated = meta.superseded_by is not None or (
            meta.effective_to is not None and meta.effective_to < today
        )
        chunks: list[Chunk] = []
        for index, (clause_no, body) in enumerate(units, start=1):
            body = body.strip()
            if not body:
                continue
            classes, properties = self._tag(body)
            chunks.append(
                Chunk(
                    chunk_id=f"{meta.doc_id}#{clause_no or index}",
                    tenant_id=meta.tenant_id,
                    doc_id=meta.doc_id,
                    doc_title=meta.title,
                    doc_type=meta.doc_type,  # type: ignore[arg-type]
                    clause_no=clause_no or str(index),
                    text=body,
                    classes=classes,
                    properties=properties,
                    priority=priority,
                    effective_from=meta.effective_from,
                    effective_to=meta.effective_to,
                    version=meta.version,
                    deprecated=deprecated,
                )
            )
        return chunks

    # ------------------------------ 内部 ------------------------------

    def _split_units(self, text: str) -> list[tuple[str, str]]:
        """按业务单元切分，返回 (条款号, 正文) 列表。"""
        lines = [line.rstrip() for line in text.replace("\r\n", "\n").split("\n")]
        units: list[tuple[str, str]] = []
        current_no = ""
        buffer: list[str] = []

        def flush() -> None:
            if not buffer:
                return
            body = "\n".join(buffer).strip()
            if body:
                units.append((current_no, body))
            buffer.clear()

        for line in lines:
            if not line.strip():
                if buffer:
                    buffer.append("")
                continue
            clause = _CLAUSE_RE.match(line)
            field = _FIELD_RE.match(line)
            if clause:
                flush()
                current_no = line.strip().split()[0].rstrip("、.．")
                buffer.append(line.strip())
            elif field and buffer:
                # 字段定义是新业务单元，但同一节下的字段定义常连续出现
                flush()
                current_no = f"{current_no or 'field'}-{len(units) + 1}"
                buffer.append(line.strip())
            elif field:
                current_no = f"field-{len(units) + 1}"
                buffer.append(line.strip())
            else:
                buffer.append(line.strip())

        flush()
        if not units:
            units = [("body", text.strip())]

        # 超长业务单元才按句切分，条款号保持一致并加序号后缀
        expanded: list[tuple[str, str]] = []
        for clause_no, body in units:
            if len(body) <= MAX_UNIT_CHARS:
                expanded.append((clause_no, body))
                continue
            part_index = 1
            part: list[str] = []
            size = 0
            for sentence in _SENTENCE_RE.split(body):
                if not sentence:
                    continue
                if size + len(sentence) > MAX_UNIT_CHARS and part:
                    expanded.append((f"{clause_no}.{part_index}", "".join(part).strip()))
                    part_index += 1
                    part = []
                    size = 0
                part.append(sentence)
                size += len(sentence)
            if part:
                expanded.append((f"{clause_no}.{part_index}", "".join(part).strip()))
        return expanded

    def _tag(self, body: str) -> tuple[list[str], list[str]]:
        """按同义词表给 chunk 打本体标签（类与属性分开）。"""
        normalized = normalize_term(body)
        classes: list[str] = []
        properties: list[str] = []
        for alias, (iri, kind) in self.ontology.aliases().items():
            if len(alias) < 2 or alias not in normalized:
                continue
            target = classes if kind == "class" else properties
            if iri not in target:
                target.append(iri)
        return classes, properties
