"""本体包：模型加载、实体链接、分块与 SHACL 校验。"""

from .chunker import DocumentMeta, OntologyChunker
from .linker import EntityLinkResult, EntityLinker, HybridEntityLinker
from .model import CAR, CON, DOC, TOP, OntologyModel, domain_sources, load_ontology, normalize_term
from .runtime import OntologyPublishError, fingerprint, revert, save
from .validator import ShaclValidator

__all__ = [
    "CAR",
    "CON",
    "DOC",
    "TOP",
    "DocumentMeta",
    "EntityLinkResult",
    "EntityLinker",
    "HybridEntityLinker",
    "OntologyChunker",
    "OntologyModel",
    "OntologyPublishError",
    "ShaclValidator",
    "domain_sources",
    "fingerprint",
    "load_ontology",
    "normalize_term",
    "revert",
    "save",
]
