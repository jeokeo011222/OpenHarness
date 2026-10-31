"""运行时兼容垫片。

目前只有一件事：把 Windows 的事件循环切到 SelectorEventLoop。

原因：psycopg 的异步连接基于 `loop.add_reader`，而 Windows 自 3.8 起默认的
`ProactorEventLoop` 没有这个能力，直连会抛 `InterfaceError`。Linux 容器里不存在
该问题，但开发机是 Windows 时会出现「连不上库」的假象，所以在这里显式处理，
并在 `PgPool.open()` 里做一次可读的失败断言，避免被 pool 超时掩盖成 10 秒后报错。
"""

from __future__ import annotations

import asyncio
import sys


def use_psycopg_compatible_loop() -> None:
    """在 Windows 上把事件循环策略切换到 Selector；其他平台无操作。"""
    if sys.platform != "win32":
        return
    policy_factory = getattr(asyncio, "WindowsSelectorEventLoopPolicy", None)
    if policy_factory is None:  # pragma: no cover - 仅非 CPython 分支
        return
    current = asyncio.get_event_loop_policy()
    if isinstance(current, policy_factory):
        return
    asyncio.set_event_loop_policy(policy_factory())


def is_proactor_loop() -> bool:
    """当前运行中的事件循环是否是不兼容的 Proactor 实现。"""
    if sys.platform != "win32":
        return False
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return False
    return type(loop).__name__ == "ProactorEventLoop"
