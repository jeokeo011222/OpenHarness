"""启动入口。

存在的理由只有一个：事件循环必须由我们自己创建。

直接跑 `uvicorn app.main:app` 时有两层坑：
1. uvicorn 是在 `serve()` 内部才 import 应用的，等 `app.main` 被导入时
   ProactorEventLoop 已经建好，再切策略无效；
2. 新版 uvicorn 自己指定 loop factory，绕过 asyncio 的 policy 设置。

所以这里显式 `asyncio.run(server.serve())`——`asyncio.run` 用当前 policy 建循环，
在 Windows 上就是 SelectorEventLoop，Linux 容器里与直接跑 uvicorn 等价。
"""

from __future__ import annotations

import asyncio
import os

import uvicorn

from app.compat import use_psycopg_compatible_loop

use_psycopg_compatible_loop()


def main() -> None:
    """按环境变量启动服务。"""
    config = uvicorn.Config(
        "app.main:app",
        host=os.environ.get("HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", "8000")),
        log_level=os.environ.get("LOG_LEVEL", "info").lower(),
        # 多进程下每个进程各持一份连接池；测试阶段单进程更可控
        workers=None,
        lifespan="on",
    )
    server = uvicorn.Server(config)
    asyncio.run(server.serve())


if __name__ == "__main__":
    main()
