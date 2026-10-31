"""文档解析：PDF / Word / 纯文本统一抽成文本。

解析失败必须显式报错并带上文件路径，不允许静默返回空串——
空文本会生成空分块，最终表现为"检索不到"，是最难排查的一类故障。
"""

from __future__ import annotations

from pathlib import Path

SUPPORTED_SUFFIXES = {".pdf", ".docx", ".txt", ".md"}


def extract_text(path: Path) -> str:
    """抽取文档正文。"""
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        return _extract_pdf(path)
    if suffix == ".docx":
        return _extract_docx(path)
    if suffix in {".txt", ".md"}:
        return path.read_text(encoding="utf-8", errors="replace")
    raise ValueError(f"不支持的文档类型：{path.suffix}（{path}）")


def _extract_pdf(path: Path) -> str:
    """逐页抽取 PDF 文本。"""
    try:
        from pypdf import PdfReader  # 延迟导入，避免无 PDF 场景的启动开销
    except ImportError as error:  # pragma: no cover
        raise RuntimeError("未安装 pypdf，无法解析 PDF") from error
    reader = PdfReader(str(path))
    pages: list[str] = []
    for index, page in enumerate(reader.pages, start=1):
        text = page.extract_text() or ""
        if text.strip():
            pages.append(f"<!-- page {index} -->\n{text}")
    if not pages:
        raise ValueError(f"PDF 未抽取到任何文本（可能是扫描件，需要 OCR）：{path}")
    return "\n\n".join(pages)


def _extract_docx(path: Path) -> str:
    """抽取 Word 正文（含表格文本）。"""
    try:
        from docx import Document  # 延迟导入
    except ImportError as error:  # pragma: no cover
        raise RuntimeError("未安装 python-docx，无法解析 Word") from error
    document = Document(str(path))
    parts: list[str] = [paragraph.text for paragraph in document.paragraphs if paragraph.text.strip()]
    for table in document.tables:
        for row in table.rows:
            cells = [cell.text.strip() for cell in row.cells if cell.text.strip()]
            if cells:
                parts.append(" | ".join(cells))
    if not parts:
        raise ValueError(f"Word 未抽取到任何文本：{path}")
    return "\n".join(parts)


def iter_documents(root: Path) -> list[Path]:
    """列出目录下所有受支持的文档。"""
    if root.is_file():
        return [root]
    return sorted(
        path for path in root.rglob("*") if path.is_file() and path.suffix.lower() in SUPPORTED_SUFFIXES
    )
