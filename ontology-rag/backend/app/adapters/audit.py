"""审计存储：SQLite 单文件，行级租户隔离。

存的是「全链路」而不是摘要：query、意图、召回列表、SPARQL、LLM 输入输出、
token 消耗、租户、时间戳、校验结论。任何一条结论都能回放到证据。
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from ..errors import TenantError
from ..settings import Settings

_SCHEMA = """
CREATE TABLE IF NOT EXISTS audit_run (
    trace_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    question TEXT NOT NULL,
    intent_json TEXT,
    recall_json TEXT,
    sparql TEXT,
    prompt TEXT,
    llm_output TEXT,
    answer TEXT,
    prompt_tokens INTEGER DEFAULT 0,
    completion_tokens INTEGER DEFAULT 0,
    model TEXT,
    guard_ok INTEGER DEFAULT 0,
    guard_json TEXT,
    blocked INTEGER DEFAULT 0,
    latency_ms INTEGER DEFAULT 0,
    error TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_tenant_time ON audit_run(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_guard ON audit_run(tenant_id, guard_ok);
"""


class SqliteAuditStore:
    """审计读写。所有 SQL 都带 tenant_id 条件。"""

    def __init__(self, settings: Settings) -> None:
        self.path: Path = settings.audit_db_path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            conn.executescript(_SCHEMA)

    def _connect(self) -> sqlite3.Connection:
        """连接并启用行工厂。"""
        connection = sqlite3.connect(self.path, timeout=10.0)
        connection.row_factory = sqlite3.Row
        return connection

    async def append(self, record: dict[str, Any]) -> None:
        """写入一条审计记录。"""
        await asyncio.to_thread(self._append_sync, record)

    def _append_sync(self, record: dict[str, Any]) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO audit_run (
                    trace_id, tenant_id, created_at, question, intent_json, recall_json,
                    sparql, prompt, llm_output, answer, prompt_tokens, completion_tokens,
                    model, guard_ok, guard_json, blocked, latency_ms, error
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    record["trace_id"],
                    record["tenant_id"],
                    record.get("created_at") or datetime.now(UTC).isoformat(),
                    record.get("question", ""),
                    json.dumps(record.get("intent"), ensure_ascii=False) if record.get("intent") else None,
                    json.dumps(record.get("recall"), ensure_ascii=False) if record.get("recall") else None,
                    record.get("sparql"),
                    record.get("prompt"),
                    record.get("llm_output"),
                    record.get("answer"),
                    int(record.get("prompt_tokens", 0)),
                    int(record.get("completion_tokens", 0)),
                    record.get("model"),
                    1 if record.get("guard_ok") else 0,
                    json.dumps(record.get("guard"), ensure_ascii=False) if record.get("guard") else None,
                    1 if record.get("blocked") else 0,
                    int(record.get("latency_ms", 0)),
                    record.get("error"),
                ),
            )

    async def get(self, tenant_id: str, trace_id: str) -> dict[str, Any] | None:
        """按 trace 读取；跨租户访问直接拒绝。"""
        return await asyncio.to_thread(self._get_sync, tenant_id, trace_id)

    def _get_sync(self, tenant_id: str, trace_id: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM audit_run WHERE trace_id = ?", (trace_id,)).fetchone()
        if row is None:
            return None
        if row["tenant_id"] != tenant_id:
            raise TenantError("跨租户访问被拒绝")
        return dict(row)

    async def usage(self, tenant_id: str, *, days: int = 1) -> dict[str, Any]:
        """按天聚合 token 与成本。"""
        return await asyncio.to_thread(self._usage_sync, tenant_id, days)

    def _usage_sync(self, tenant_id: str, days: int) -> dict[str, Any]:
        since = (datetime.now(UTC) - timedelta(days=days)).isoformat()
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT substr(created_at, 1, 10) AS day,
                       COUNT(*) AS runs,
                       SUM(prompt_tokens) AS prompt_tokens,
                       SUM(completion_tokens) AS completion_tokens,
                       SUM(CASE WHEN blocked = 1 THEN 1 ELSE 0 END) AS blocked_runs
                FROM audit_run
                WHERE tenant_id = ? AND created_at >= ?
                GROUP BY day ORDER BY day
                """,
                (tenant_id, since),
            ).fetchall()
        days_out = [
            {
                "day": row["day"],
                "runs": row["runs"] or 0,
                "prompt_tokens": row["prompt_tokens"] or 0,
                "completion_tokens": row["completion_tokens"] or 0,
                "blocked_runs": row["blocked_runs"] or 0,
            }
            for row in rows
        ]
        return {
            "tenant_id": tenant_id,
            "days": days_out,
            "total_tokens": sum(item["prompt_tokens"] + item["completion_tokens"] for item in days_out),
        }

    async def recent(self, tenant_id: str, *, limit: int = 20) -> list[dict[str, Any]]:
        """最近若干条审计。"""
        return await asyncio.to_thread(self._recent_sync, tenant_id, limit)

    def _recent_sync(self, tenant_id: str, limit: int) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT trace_id, created_at, question, model, guard_ok, blocked,
                       prompt_tokens, completion_tokens, latency_ms
                FROM audit_run WHERE tenant_id = ?
                ORDER BY created_at DESC LIMIT ?
                """,
                (tenant_id, limit),
            ).fetchall()
        return [dict(row) for row in rows]
