"""文档入库：解析、分块、抽取三元组。"""

from .documents import SUPPORTED_SUFFIXES, extract_text, iter_documents
from .extractor import ExtractionResult, TripleExtractor

__all__ = [
    "SUPPORTED_SUFFIXES",
    "ExtractionResult",
    "TripleExtractor",
    "extract_text",
    "iter_documents",
]
