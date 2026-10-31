"""结构化日志。

每条日志都带 trace_id 与 tenant_id，便于和审计记录对齐。
"""

from __future__ import annotations

import json
import logging
import sys
from datetime import UTC, datetime

from .settings import Settings


class JsonFormatter(logging.Formatter):
    """极简 JSON 行格式，直接可被 Loki / ELK 采集。"""

    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": datetime.now(UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        for key in ("trace_id", "tenant_id", "route"):
            value = getattr(record, key, None)
            if value:
                payload[key] = value
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False)


def configure_logging(settings: Settings) -> None:
    """按环境配置日志输出。"""
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(logging.DEBUG if settings.environment == "dev" else logging.INFO)
