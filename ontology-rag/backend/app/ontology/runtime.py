"""运行期本体接管（runtime overlay）。

本体中心发布版本时把 Turtle 推到这里，落在 `ontology/runtime/{domain}.ttl`；
加载时 runtime 覆盖同名内置域，多出来的文件视为新增域。

**为什么落盘而不是只放内存**：演示机重启后不该丢掉最后一次发布。只放内存的话，
"发布即生效"只在当前进程成立，重启就静默退回旧本体，而界面上看不出任何异常——
这类"没有报错的失效"比直接报错难查得多。

**为什么先解析再落盘**：语法错的 Turtle 一旦写进加载路径，下次启动整个服务起不来。
在边界上拒绝，比在下游等 `FileNotFoundError` 或半个空图好。
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from rdflib import Graph

#: 运行期接管目录（相对本体根目录）。
RUNTIME_DIR = "runtime"
#: 与 Turtle 同名的元数据后缀，记录发布版本与摘要。
META_SUFFIX = ".meta.json"
#: 域标识：小写字母开头，只允许小写字母、数字与连字符，最长 32。
DOMAIN_PATTERN = re.compile(r"^[a-z][a-z0-9-]{0,31}$")


class OntologyPublishError(ValueError):
    """发布的本体不合法：域标识、Turtle 语法或空图。"""


def runtime_dir(ontology_dir: Path) -> Path:
    """运行期接管目录。"""
    return ontology_dir / RUNTIME_DIR


def turtle_path(ontology_dir: Path, domain: str) -> Path:
    """某域的接管文件路径。"""
    return runtime_dir(ontology_dir) / f"{domain}.ttl"


def meta_path(ontology_dir: Path, domain: str) -> Path:
    """某域的接管元数据路径。"""
    return runtime_dir(ontology_dir) / f"{domain}{META_SUFFIX}"


def is_taken_over(ontology_dir: Path, domain: str) -> bool:
    """该域是否已被运行期接管。"""
    return turtle_path(ontology_dir, domain).is_file()


def require_domain(domain: str) -> str:
    """校验并归一域标识。

    @param domain - 调用方传入的域标识。
    @returns 归一后的域标识。
    @throws OntologyPublishError 标识不合法。
    """
    safe = domain.strip().lower()
    if not DOMAIN_PATTERN.match(safe):
        raise OntologyPublishError(
            f"非法域标识：{domain!r}（小写字母开头，只允许小写字母、数字与连字符）"
        )
    return safe


def parse_turtle(text: str, *, source: str = "发布内容") -> Graph:
    """严格解析 Turtle。

    @param text - Turtle 文本。
    @param source - 出错信息里的来源描述。
    @returns 解析后的图。
    @throws OntologyPublishError 语法错误或空图。
    """
    if not text.strip():
        raise OntologyPublishError(f"{source}为空")
    graph = Graph()
    try:
        graph.parse(data=text, format="turtle")
    except Exception as error:  # rdflib 的解析异常类型随版本变化，这里统一收敛
        raise OntologyPublishError(f"{source}不是合法的 Turtle：{error}") from error
    if len(graph) == 0:
        raise OntologyPublishError(f"{source}解析后是空图，拒绝接管")
    return graph


def _digest(payload: bytes) -> str:
    """字节级 sha256。"""
    return hashlib.sha256(payload).hexdigest()


def _atomic_write(path: Path, payload: bytes) -> None:
    """同目录临时文件 + `os.replace`，避免半截文件被下一次启动读到。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-", suffix=path.suffix)
    try:
        with os.fdopen(handle, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise


def save(
    ontology_dir: Path,
    domain: str,
    turtle: str,
    *,
    version: str = "",
    label: str = "",
    note: str = "",
) -> dict[str, Any]:
    """接管一个域的本体。

    @param ontology_dir - 本体根目录。
    @param domain - 域标识。
    @param turtle - 该域的完整 Turtle（OWL 类、属性、SHACL 形状可一并带上）。
    @param version - 来源版本号，写进元数据供面板显示。
    @param label - 域显示名。
    @param note - 发布备注。
    @returns 该域的指纹条目。
    """
    safe = require_domain(domain)
    graph = parse_turtle(turtle, source=f"域 {safe} 的本体")
    payload = turtle.encode("utf-8")
    _atomic_write(turtle_path(ontology_dir, safe), payload)

    meta = {
        "domain": safe,
        "version": version.strip(),
        "label": label.strip(),
        "note": note.strip(),
        "sha256": _digest(payload),
        "triples": len(graph),
        "publishedAt": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
    }
    _atomic_write(
        meta_path(ontology_dir, safe),
        json.dumps(meta, ensure_ascii=False, indent=2).encode("utf-8"),
    )
    return {**meta, "source": "runtime", "file": f"{RUNTIME_DIR}/{safe}.ttl"}


def read_meta(ontology_dir: Path, domain: str) -> dict[str, Any] | None:
    """读取接管元数据；没有或损坏时返回 `None`。"""
    path = meta_path(ontology_dir, domain)
    if not path.is_file():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return raw if isinstance(raw, dict) else None


def revert(ontology_dir: Path, domain: str) -> bool:
    """撤销接管，回落到内置文件。

    @param ontology_dir - 本体根目录。
    @param domain - 域标识。
    @returns 是否确实删掉了接管文件。
    """
    safe = require_domain(domain)
    removed = False
    for path in (turtle_path(ontology_dir, safe), meta_path(ontology_dir, safe)):
        if path.is_file():
            path.unlink()
            removed = True
    return removed


def _file_entry(ontology_dir: Path, domain: str, path: Path, *, source: str) -> dict[str, Any]:
    """单域指纹：摘要、三元组数、来源与发布时间。"""
    payload = path.read_bytes()
    try:
        triples = len(Graph().parse(data=payload, format="turtle"))
    except Exception:  # 内置文件坏了要走"能起来但要看得到"的路径，而不是整个接口 500
        triples = -1
    meta = read_meta(ontology_dir, domain) if source == "runtime" else None
    return {
        "domain": domain,
        "source": source,
        "file": str(path.relative_to(ontology_dir)).replace(os.sep, "/"),
        "sha256": _digest(payload),
        "triples": triples,
        "version": (meta or {}).get("version", ""),
        "label": (meta or {}).get("label", ""),
        "publishedAt": (meta or {}).get("publishedAt", ""),
    }


def fingerprint(ontology_dir: Path) -> dict[str, Any]:
    """本体文件的整体指纹。

    面板要靠它回答一个具体问题：**现在跑检索用的是哪一版本体**。没有这个，
    在本体中心改完本体却发现检索结果没变时，人会去怀疑检索，而不是怀疑"没发布"。

    @param ontology_dir - 本体根目录。
    @returns `digest`（全量摘要）、`domains`（逐域条目）与 `files`（参与加载的相对路径）。
    """
    from .model import DOMAIN_FILES  # 延迟导入：model 依赖本模块的路径规则

    entries: list[dict[str, Any]] = []
    for domain in sorted(DOMAIN_FILES):
        override = turtle_path(ontology_dir, domain)
        if override.is_file():
            entries.append(_file_entry(ontology_dir, domain, override, source="runtime"))
            continue
        bundled = ontology_dir / DOMAIN_FILES[domain][0]
        if bundled.is_file():
            entries.append(_file_entry(ontology_dir, domain, bundled, source="bundled"))

    if runtime_dir(ontology_dir).is_dir():
        for path in sorted(runtime_dir(ontology_dir).glob("*.ttl")):
            if path.stem in DOMAIN_FILES:
                continue
            entries.append(_file_entry(ontology_dir, path.stem, path, source="runtime"))

    material = "".join(f"{entry['domain']}:{entry['sha256']};" for entry in sorted(entries, key=lambda e: e["domain"]))
    return {
        "digest": _digest(material.encode("utf-8"))[:16] if material else "",
        "domains": entries,
        "files": [entry["file"] for entry in entries],
    }
