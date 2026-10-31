"""脚本共用引导：定位后端包根目录。

存在的理由：同一份脚本要能在两种目录布局下跑通。

- 宿主机布局：`ontology-rag/scripts/xxx.py`，后端包在 `ontology-rag/backend/app`；
- 容器布局：脚本挂到 `/srv/scripts`，后端包在 `/srv/app`（Dockerfile 里 `COPY app ./app`）。

写死 `parents[1] / "backend"` 在宿主机上对、在容器里就变成 `/srv/backend/app`
——不存在的路径，报错是 `ModuleNotFoundError: No module named 'app'`。
这里按"哪个目录下有 app/__init__.py"来判定，而不是靠环境变量猜测。
"""

from __future__ import annotations

import sys
from pathlib import Path


def backend_path() -> Path:
    """返回包含 `app` 包的后端根目录。"""
    scripts_dir = Path(__file__).resolve().parent
    root = scripts_dir.parent
    for candidate in (root / "backend", root):
        if (candidate / "app" / "__init__.py").is_file():
            return candidate
    raise RuntimeError(f"找不到后端包（已尝试 {root / 'backend'} 与 {root}）")


def ensure_backend_path() -> Path:
    """把后端根目录加入 `sys.path` 并返回它。"""
    resolved = backend_path()
    entry = str(resolved)
    if entry not in sys.path:
        sys.path.insert(0, entry)
    return resolved
