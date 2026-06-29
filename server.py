#!/usr/bin/env python3
from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import hashlib
import json
import os
import pathlib
import queue
import signal
import sqlite3
import sys
import threading
import time
import urllib.parse
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


APP_ROOT = pathlib.Path(__file__).resolve().parent
STATIC_ROOT = APP_ROOT / "static"
DEFAULT_SOURCE = pathlib.Path.home() / ".codex" / "otel" / "logs" / "codex-otel.json"
DEFAULT_DB = APP_ROOT / "data" / "nopentel.sqlite"
CLAUDE_PROJECTS_ROOT = pathlib.Path.home() / ".claude" / "projects"
CODEX_SESSIONS_ROOT = pathlib.Path.home() / ".codex" / "sessions"
KNOWN_SERVICES = {
    "codex_exec": "Codex",
    "claude-code": "Claude Code",
}
TOKEN_FIELDS = (
    "input_tokens",
    "cached_tokens",
    "cache_write_tokens",
    "output_tokens",
    "reasoning_tokens",
    "tool_tokens",
)
TOKEN_TOTAL_FIELDS = (
    "input_tokens",
    "cached_tokens",
    "cache_write_tokens",
    "output_tokens",
    "reasoning_tokens",
)
PROJECT_NAME_KEYS = (
    "project.name",
    "project",
    "workspace.name",
    "repository.name",
    "repo.name",
    "cwd.name",
)
PROJECT_PATH_KEYS = (
    "project.path",
    "workspace.path",
    "cwd",
    "current_working_directory",
    "working_directory",
    "repository.path",
    "repo.path",
)
TOOL_NAME_KEYS = (
    "tool_name",
    "tool.name",
    "function.name",
    "mcp.tool.name",
)
CALL_EVENT_NAMES = {
    "api_request",
    "codex.api_request",
    "codex.sse_event",
    "codex.websocket_request",
}


SCHEMA = """
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_hash TEXT NOT NULL UNIQUE,
  observed_ns INTEGER,
  observed_at TEXT,
  received_at TEXT NOT NULL,
  event_name TEXT NOT NULL,
  event_kind TEXT,
  service_name TEXT,
  project_name TEXT,
  project_path TEXT,
  model TEXT,
  tool_name TEXT,
  conversation_id TEXT,
  duration_ms INTEGER,
  success TEXT,
  endpoint TEXT,
  input_tokens INTEGER,
  cached_tokens INTEGER,
  cache_write_tokens INTEGER,
  output_tokens INTEGER,
  reasoning_tokens INTEGER,
  tool_tokens INTEGER,
  cost_usd REAL,
  raw_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_observed_ns ON events(observed_ns);
CREATE INDEX IF NOT EXISTS idx_events_name ON events(event_name);
CREATE INDEX IF NOT EXISTS idx_events_model ON events(model);
CREATE INDEX IF NOT EXISTS idx_events_service_name ON events(service_name);
CREATE INDEX IF NOT EXISTS idx_events_project_name ON events(project_name);
CREATE INDEX IF NOT EXISTS idx_events_tool_name ON events(tool_name);
CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"""

EVENT_COLUMN_MIGRATIONS = {
    "project_name": "ALTER TABLE events ADD COLUMN project_name TEXT",
    "project_path": "ALTER TABLE events ADD COLUMN project_path TEXT",
    "tool_name": "ALTER TABLE events ADD COLUMN tool_name TEXT",
    "cache_write_tokens": "ALTER TABLE events ADD COLUMN cache_write_tokens INTEGER",
    "cost_usd": "ALTER TABLE events ADD COLUMN cost_usd REAL",
}


def utc_now_iso() -> str:
    return dt.datetime.now(dt.UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def ns_to_iso(value: Any) -> str | None:
    try:
        ns = int(value)
    except (TypeError, ValueError):
        return None
    return dt.datetime.fromtimestamp(ns / 1_000_000_000, dt.UTC).isoformat(
        timespec="milliseconds"
    ).replace("+00:00", "Z")


def int_or_none(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def string_or_none(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def value_from_otel(value: dict[str, Any]) -> Any:
    if "stringValue" in value:
        return value["stringValue"]
    if "intValue" in value:
        return int_or_none(value["intValue"])
    if "doubleValue" in value:
        with contextlib.suppress(TypeError, ValueError):
            return float(value["doubleValue"])
    if "boolValue" in value:
        return bool(value["boolValue"])
    if "bytesValue" in value:
        return value["bytesValue"]
    if "arrayValue" in value:
        return [value_from_otel(item) for item in value["arrayValue"].get("values", [])]
    if "kvlistValue" in value:
        return attrs_to_dict(value["kvlistValue"].get("values", []))
    return value


def attrs_to_dict(attrs: list[dict[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for attr in attrs:
        key = attr.get("key")
        if not key:
            continue
        result[key] = value_from_otel(attr.get("value", {}))
    return result


def first_attr(attrs: dict[str, Any], keys: tuple[str, ...]) -> Any:
    for key in keys:
        value = attrs.get(key)
        if value not in (None, ""):
            return value
    return None


class LocalProjectLookup:
    def __init__(self) -> None:
        self._cache: dict[tuple[str, str], tuple[str | None, str | None]] = {}

    def lookup(
        self,
        service_name: str | None,
        session_id: str | None,
        conversation_id: str | None,
    ) -> tuple[str | None, str | None]:
        key = (service_name or "", session_id or conversation_id or "")
        if key in self._cache:
            return self._cache[key]
        if service_name == "claude-code":
            result = self._lookup_claude(session_id)
        elif service_name == "codex_exec":
            result = self._lookup_codex(conversation_id)
        else:
            result = (None, None)
        self._cache[key] = result
        return result

    def _lookup_claude(self, session_id: str | None) -> tuple[str | None, str | None]:
        if not session_id or not CLAUDE_PROJECTS_ROOT.exists():
            return (None, None)
        for path in CLAUDE_PROJECTS_ROOT.glob(f"*/{session_id}.jsonl"):
            cwd = self._read_jsonl_cwd(path)
            if cwd:
                return (pathlib.PurePath(cwd).name, cwd)
        return (None, None)

    def _lookup_codex(self, conversation_id: str | None) -> tuple[str | None, str | None]:
        if not conversation_id or not CODEX_SESSIONS_ROOT.exists():
            return (None, None)
        for path in CODEX_SESSIONS_ROOT.glob(f"**/*{conversation_id}.jsonl"):
            cwd = self._read_codex_session_cwd(path)
            if cwd:
                return (pathlib.PurePath(cwd).name, cwd)
        return (None, None)

    def _read_jsonl_cwd(self, path: pathlib.Path) -> str | None:
        try:
            with path.open("r", encoding="utf-8") as handle:
                for _ in range(25):
                    line = handle.readline()
                    if not line:
                        break
                    with contextlib.suppress(json.JSONDecodeError):
                        cwd = json.loads(line).get("cwd")
                        if cwd:
                            return string_or_none(cwd)
        except OSError:
            return None
        return None

    def _read_codex_session_cwd(self, path: pathlib.Path) -> str | None:
        try:
            with path.open("r", encoding="utf-8") as handle:
                line = handle.readline()
        except OSError:
            return None
        with contextlib.suppress(json.JSONDecodeError):
            payload = json.loads(line).get("payload", {})
            return string_or_none(payload.get("cwd"))
        return None


PROJECT_LOOKUP = LocalProjectLookup()


def project_from_attrs(
    attrs: dict[str, Any],
    resource_attrs: dict[str, Any],
    service_name: str | None,
) -> tuple[str | None, str | None]:
    merged = {**resource_attrs, **attrs}
    project_name = string_or_none(first_attr(merged, PROJECT_NAME_KEYS))
    project_path = string_or_none(first_attr(merged, PROJECT_PATH_KEYS))
    if not project_name and project_path:
        project_name = pathlib.PurePath(project_path).name or project_path
    if not project_name and not project_path:
        return PROJECT_LOOKUP.lookup(
            service_name,
            string_or_none(attrs.get("session.id")),
            string_or_none(attrs.get("conversation.id")),
        )
    return project_name, project_path


def cost_usd_from_attrs(attrs: dict[str, Any]) -> float | None:
    value = attrs.get("cost_usd")
    if value not in (None, ""):
        with contextlib.suppress(TypeError, ValueError):
            return float(value)
    micros = attrs.get("cost_usd_micros")
    if micros not in (None, ""):
        with contextlib.suppress(TypeError, ValueError):
            return float(micros) / 1_000_000
    return None


def public_raw_json(payload: dict[str, Any]) -> str:
    """Store the full local OTel object; detail views decide when to reveal it."""
    return json.dumps(payload, separators=(",", ":"))


def flatten_payload(line: str, line_no: int) -> list[dict[str, Any]]:
    root = json.loads(line)
    events: list[dict[str, Any]] = []
    for resource_idx, resource_log in enumerate(root.get("resourceLogs", [])):
        resource_attrs = attrs_to_dict(resource_log.get("resource", {}).get("attributes", []))
        service_name = string_or_none(resource_attrs.get("service.name"))
        for scope_idx, scope_log in enumerate(resource_log.get("scopeLogs", [])):
            scope = scope_log.get("scope", {})
            for record_idx, record in enumerate(scope_log.get("logRecords", [])):
                record_attrs = attrs_to_dict(record.get("attributes", []))
                project_name, project_path = project_from_attrs(
                    record_attrs,
                    resource_attrs,
                    service_name,
                )
                observed_ns = int_or_none(record.get("observedTimeUnixNano"))
                event_name = (
                    string_or_none(record_attrs.get("event.name"))
                    or string_or_none(record.get("eventName"))
                    or "unknown"
                )
                event_hash = hashlib.sha256(
                    f"{line_no}:{resource_idx}:{scope_idx}:{record_idx}:{line}".encode("utf-8")
                ).hexdigest()
                input_tokens = int_or_none(
                    record_attrs.get("input_token_count") or record_attrs.get("input_tokens")
                )
                cached_tokens = int_or_none(
                    record_attrs.get("cached_token_count")
                    or record_attrs.get("cache_read_tokens")
                )
                cache_write_tokens = int_or_none(
                    record_attrs.get("cache_creation_tokens")
                    or record_attrs.get("cache_write_tokens")
                )
                if service_name == "codex_exec" and input_tokens is not None and cached_tokens:
                    input_tokens = max(input_tokens - cached_tokens, 0)
                raw = {
                    "resource": resource_attrs,
                    "scope": scope,
                    "record": record,
                }
                events.append(
                    {
                        "event_hash": event_hash,
                        "observed_ns": observed_ns,
                        "observed_at": ns_to_iso(observed_ns) if observed_ns else None,
                        "received_at": utc_now_iso(),
                        "event_name": event_name,
                        "event_kind": string_or_none(record_attrs.get("event.kind")),
                        "service_name": service_name,
                        "project_name": project_name,
                        "project_path": project_path,
                        "model": string_or_none(record_attrs.get("model") or record_attrs.get("slug")),
                        "tool_name": string_or_none(first_attr(record_attrs, TOOL_NAME_KEYS)),
                        "conversation_id": string_or_none(record_attrs.get("conversation.id")),
                        "duration_ms": int_or_none(record_attrs.get("duration_ms")),
                        "success": string_or_none(record_attrs.get("success")),
                        "endpoint": string_or_none(record_attrs.get("endpoint")),
                        "input_tokens": input_tokens,
                        "cached_tokens": cached_tokens,
                        "cache_write_tokens": cache_write_tokens,
                        "output_tokens": int_or_none(
                            record_attrs.get("output_token_count") or record_attrs.get("output_tokens")
                        ),
                        "reasoning_tokens": int_or_none(record_attrs.get("reasoning_token_count")),
                        "tool_tokens": int_or_none(record_attrs.get("tool_token_count")),
                        "cost_usd": cost_usd_from_attrs(record_attrs),
                        "raw_json": public_raw_json(raw),
                    }
                )
    return events


def init_db(db_path: pathlib.Path) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(db_path) as conn:
        conn.executescript(SCHEMA)
        columns = {
            row[1]
            for row in conn.execute("PRAGMA table_info(events)").fetchall()
        }
        for column, statement in EVENT_COLUMN_MIGRATIONS.items():
            if column not in columns:
                conn.execute(statement)
        conn.executescript(
            """
            CREATE INDEX IF NOT EXISTS idx_events_project_name ON events(project_name);
            CREATE INDEX IF NOT EXISTS idx_events_tool_name ON events(tool_name);
            """
        )


def event_row_to_dict(row: sqlite3.Row, include_raw: bool = False) -> dict[str, Any]:
    event = dict(row)
    if not include_raw:
        event.pop("raw_json", None)
    event["short_conversation_id"] = (
        event["conversation_id"][:8] if event.get("conversation_id") else None
    )
    event["total_tokens"] = token_total(event)
    return event


def token_total(event: dict[str, Any]) -> int:
    return sum(int_or_none(event.get(field)) or 0 for field in TOKEN_TOTAL_FIELDS)


def is_call_event(event: dict[str, Any]) -> bool:
    return (
        event.get("event_name") in CALL_EVENT_NAMES
        or token_total(event) > 0
        or (int_or_none(event.get("tool_tokens")) or 0) > 0
    )


class EventHub:
    def __init__(self) -> None:
        self._clients: set[queue.Queue[dict[str, Any]]] = set()
        self._lock = threading.Lock()

    def subscribe(self) -> queue.Queue[dict[str, Any]]:
        client: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=500)
        with self._lock:
            self._clients.add(client)
        return client

    def unsubscribe(self, client: queue.Queue[dict[str, Any]]) -> None:
        with self._lock:
            self._clients.discard(client)

    def publish(self, message: dict[str, Any]) -> None:
        with self._lock:
            clients = list(self._clients)
        for client in clients:
            try:
                client.put_nowait(message)
            except queue.Full:
                with contextlib.suppress(queue.Empty):
                    client.get_nowait()
                with contextlib.suppress(queue.Full):
                    client.put_nowait(message)


class OTelTailer(threading.Thread):
    def __init__(self, source: pathlib.Path, db_path: pathlib.Path, hub: EventHub) -> None:
        super().__init__(name="otel-tailer", daemon=True)
        self.source = source
        self.db_path = db_path
        self.hub = hub
        self.stop_event = threading.Event()
        self._status_lock = threading.Lock()
        self._status: dict[str, Any] = {
            "source": str(source),
            "source_exists": False,
            "last_read_at": None,
            "last_insert_at": None,
            "last_error": None,
            "position": 0,
            "inserted": 0,
        }

    def status(self) -> dict[str, Any]:
        with self._status_lock:
            return dict(self._status)

    def set_status(self, **kwargs: Any) -> None:
        with self._status_lock:
            self._status.update(kwargs)

    def stop(self) -> None:
        self.stop_event.set()

    def run(self) -> None:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        try:
            self._run(conn)
        finally:
            conn.close()

    def _run(self, conn: sqlite3.Connection) -> None:
        line_no = 0
        while not self.stop_event.is_set():
            if not self.source.exists():
                self.set_status(source_exists=False, last_error="source file is missing")
                self.stop_event.wait(1.0)
                continue

            try:
                with self.source.open("r", encoding="utf-8") as handle:
                    self.set_status(source_exists=True, last_error=None, position=0)
                    while not self.stop_event.is_set():
                        line = handle.readline()
                        if line:
                            line_no += 1
                            self.set_status(position=handle.tell(), last_read_at=utc_now_iso())
                            self.ingest_line(conn, line.strip(), line_no)
                            continue

                        current_size = self.source.stat().st_size if self.source.exists() else 0
                        if current_size < handle.tell():
                            break
                        self.stop_event.wait(0.35)
            except Exception as exc:  # Keep the local monitor alive and visible.
                self.set_status(last_error=f"{type(exc).__name__}: {exc}")
                self.stop_event.wait(1.0)

    def ingest_line(self, conn: sqlite3.Connection, line: str, line_no: int) -> None:
        if not line:
            return
        try:
            events = flatten_payload(line, line_no)
        except json.JSONDecodeError as exc:
            self.set_status(last_error=f"JSONDecodeError: {exc}")
            return

        inserted_events: list[dict[str, Any]] = []
        for event in events:
            values = (
                event["event_hash"],
                event["observed_ns"],
                event["observed_at"],
                event["received_at"],
                event["event_name"],
                event["event_kind"],
                event["service_name"],
                event["project_name"],
                event["project_path"],
                event["model"],
                event["tool_name"],
                event["conversation_id"],
                event["duration_ms"],
                event["success"],
                event["endpoint"],
                event["input_tokens"],
                event["cached_tokens"],
                event["cache_write_tokens"],
                event["output_tokens"],
                event["reasoning_tokens"],
                event["tool_tokens"],
                event["cost_usd"],
                event["raw_json"],
            )
            cursor = conn.execute(
                """
                INSERT OR IGNORE INTO events (
                  event_hash, observed_ns, observed_at, received_at, event_name, event_kind,
                  service_name, project_name, project_path, model, tool_name, conversation_id,
                  duration_ms, success, endpoint, input_tokens, cached_tokens, cache_write_tokens,
                  output_tokens, reasoning_tokens, tool_tokens, cost_usd,
                  raw_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                values,
            )
            if cursor.rowcount:
                event_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
                stored = dict(event)
                stored["id"] = event_id
                stored["short_conversation_id"] = (
                    stored["conversation_id"][:8] if stored.get("conversation_id") else None
                )
                inserted_events.append(stored)
        conn.commit()

        if inserted_events:
            inserted_count = len(inserted_events)
            status = self.status()
            self.set_status(
                inserted=status.get("inserted", 0) + inserted_count,
                last_insert_at=utc_now_iso(),
                last_error=None,
            )
            for event in inserted_events:
                self.hub.publish({"type": "event", "event": event_row_to_dict(event)})
                if is_call_event(event):
                    self.hub.publish({"type": "call", "call": event_row_to_dict(event)})
            self.hub.publish({"type": "summary", "summary": make_summary(self.db_path, self.status())})


def query_recent(conn: sqlite3.Connection, limit: int = 250) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT * FROM events
        ORDER BY COALESCE(observed_ns, 0) DESC, id DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    return [event_row_to_dict(row) for row in reversed(rows)]


def query_calls(conn: sqlite3.Connection, limit: int = 250) -> list[dict[str, Any]]:
    token_expr = token_total_sql()
    rows = conn.execute(
        f"""
        SELECT * FROM events
        WHERE event_name IN ({",".join("?" for _ in CALL_EVENT_NAMES)})
           OR ({token_expr}) > 0
           OR COALESCE(tool_tokens, 0) > 0
        ORDER BY COALESCE(observed_ns, 0) DESC, id DESC
        LIMIT ?
        """,
        (*sorted(CALL_EVENT_NAMES), limit),
    ).fetchall()
    return [event_row_to_dict(row) for row in reversed(rows)]


def query_event_detail(conn: sqlite3.Connection, event_id: int) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM events WHERE id = ?", (event_id,)).fetchone()
    return event_row_to_dict(row, include_raw=True) if row else None


def token_total_sql() -> str:
    return " + ".join(f"COALESCE({field}, 0)" for field in TOKEN_TOTAL_FIELDS)


def token_sum_sql() -> str:
    return " + ".join(f"COALESCE(SUM({field}), 0)" for field in TOKEN_TOTAL_FIELDS)


def query_counts(conn: sqlite3.Connection, interval_minutes: int) -> dict[str, int]:
    since_ns = int((time.time() - interval_minutes * 60) * 1_000_000_000)
    row = conn.execute(
        """
        SELECT
          COUNT(*) AS events,
          COALESCE(SUM(input_tokens), 0) AS input_tokens,
          COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
          COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
          COALESCE(SUM(output_tokens), 0) AS output_tokens,
          COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
          COALESCE(SUM(tool_tokens), 0) AS tool_tokens
        FROM events
        WHERE observed_ns >= ?
        """,
        (since_ns,),
    ).fetchone()
    return dict(row)


def query_top(conn: sqlite3.Connection, column: str, limit: int = 8) -> list[dict[str, Any]]:
    if column not in {"event_name", "model", "service_name"}:
        raise ValueError("invalid top column")
    rows = conn.execute(
        f"""
        SELECT {column} AS name, COUNT(*) AS count
        FROM events
        WHERE {column} IS NOT NULL AND {column} != ''
        GROUP BY {column}
        ORDER BY count DESC, name ASC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    return [dict(row) for row in rows]


def query_usage_by_dimension(
    conn: sqlite3.Connection,
    dimension: str,
    label_sql: str,
    where_sql: str,
    limit: int = 12,
) -> list[dict[str, Any]]:
    token_expr = token_total_sql()
    token_sum_expr = token_sum_sql()
    rows = conn.execute(
        f"""
        SELECT
          {label_sql} AS name,
          COUNT(*) AS events,
          SUM(CASE WHEN event_name IN ({",".join("?" for _ in CALL_EVENT_NAMES)})
                    OR ({token_expr}) > 0
                    OR COALESCE(tool_tokens, 0) > 0 THEN 1 ELSE 0 END) AS calls,
          COALESCE(SUM(input_tokens), 0) AS input_tokens,
          COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
          COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
          COALESCE(SUM(output_tokens), 0) AS output_tokens,
          COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
          COALESCE(SUM(tool_tokens), 0) AS tool_tokens,
          COALESCE(SUM(duration_ms), 0) AS duration_ms,
          COALESCE(SUM(cost_usd), 0.0) AS cost_usd,
          ({token_sum_expr}) AS total_tokens
        FROM events
        WHERE {where_sql}
        GROUP BY {dimension}
        ORDER BY total_tokens DESC, calls DESC, events DESC, name ASC
        LIMIT ?
        """,
        (*sorted(CALL_EVENT_NAMES), limit),
    ).fetchall()
    return [dict(row) for row in rows]


def query_usage_breakdowns(conn: sqlite3.Connection) -> dict[str, list[dict[str, Any]]]:
    token_expr = token_total_sql()
    call_or_token = (
        f"(event_name IN ({','.join(repr(name) for name in sorted(CALL_EVENT_NAMES))}) "
        f"OR ({token_expr}) > 0 OR COALESCE(tool_tokens, 0) > 0)"
    )
    return {
        "models": query_usage_by_dimension(
            conn,
            "COALESCE(NULLIF(model, ''), '(unknown model)')",
            "COALESCE(NULLIF(model, ''), '(unknown model)')",
            call_or_token,
        ),
        "tools": query_usage_by_dimension(
            conn,
            "CASE WHEN tool_name IS NOT NULL AND tool_name != '' THEN tool_name "
            "WHEN tool_tokens IS NOT NULL AND tool_tokens > 0 THEN '(aggregate tool tokens)' "
            "ELSE '(no tool)' END",
            "CASE WHEN tool_name IS NOT NULL AND tool_name != '' THEN tool_name "
            "WHEN tool_tokens IS NOT NULL AND tool_tokens > 0 THEN '(aggregate tool tokens)' "
            "ELSE '(no tool)' END",
            "(tool_name IS NOT NULL AND tool_name != '') OR COALESCE(tool_tokens, 0) > 0",
        ),
        "projects": query_usage_by_dimension(
            conn,
            "COALESCE(NULLIF(project_name, ''), '(unknown project)')",
            "COALESCE(NULLIF(project_name, ''), '(unknown project)')",
            call_or_token,
        ),
    }


def row_int(row: sqlite3.Row | dict[str, Any], key: str) -> int:
    return int(row[key] or 0)


def row_float(row: sqlite3.Row | dict[str, Any], key: str) -> float:
    return float(row[key] or 0)


def report_total(row: sqlite3.Row | dict[str, Any]) -> int:
    return (
        row_int(row, "input_tokens")
        + row_int(row, "output_tokens")
        + row_int(row, "cache_write_tokens")
        + row_int(row, "cached_tokens")
    )


def make_report_row(row: sqlite3.Row) -> dict[str, Any]:
    item = dict(row)
    item["total_tokens"] = report_total(item)
    return item


def query_usage_report(conn: sqlite3.Connection) -> dict[str, Any]:
    token_expr = token_total_sql()
    rows = conn.execute(
        f"""
        SELECT
          substr(observed_at, 1, 10) AS day,
          COALESCE(NULLIF(project_name, ''), '(unknown project)') AS project_name,
          MAX(project_path) AS project_path,
          COALESCE(NULLIF(model, ''), '(unknown model)') AS model,
          COUNT(*) AS calls,
          COALESCE(SUM(input_tokens), 0) AS input_tokens,
          COALESCE(SUM(output_tokens), 0) AS output_tokens,
          COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
          COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
          COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
          COALESCE(SUM(tool_tokens), 0) AS tool_tokens,
          COALESCE(SUM(duration_ms), 0) AS duration_ms,
          COALESCE(SUM(cost_usd), 0.0) AS cost_usd
        FROM events
        WHERE observed_at IS NOT NULL
          AND (({token_expr}) > 0 OR COALESCE(tool_tokens, 0) > 0)
        GROUP BY day, project_name, model
        ORDER BY day DESC, project_name ASC
        """
    ).fetchall()

    groups_by_key: dict[tuple[str, str], dict[str, Any]] = {}
    totals = {
        "calls": 0,
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_write_tokens": 0,
        "cached_tokens": 0,
        "reasoning_tokens": 0,
        "tool_tokens": 0,
        "duration_ms": 0,
        "cost_usd": 0.0,
        "total_tokens": 0,
    }
    for row in rows:
        model_row = make_report_row(row)
        key = (model_row["day"], model_row["project_name"])
        group = groups_by_key.setdefault(
            key,
            {
                "day": model_row["day"],
                "project_name": model_row["project_name"],
                "project_path": model_row.get("project_path"),
                "models": [],
                "calls": 0,
                "input_tokens": 0,
                "output_tokens": 0,
                "cache_write_tokens": 0,
                "cached_tokens": 0,
                "reasoning_tokens": 0,
                "tool_tokens": 0,
                "duration_ms": 0,
                "cost_usd": 0.0,
                "total_tokens": 0,
            },
        )
        if not group.get("project_path") and model_row.get("project_path"):
            group["project_path"] = model_row["project_path"]
        group["models"].append(model_row)
        for field in (
            "calls",
            "input_tokens",
            "output_tokens",
            "cache_write_tokens",
            "cached_tokens",
            "reasoning_tokens",
            "tool_tokens",
            "duration_ms",
            "total_tokens",
        ):
            group[field] += row_int(model_row, field)
            totals[field] += row_int(model_row, field)
        group["cost_usd"] += row_float(model_row, "cost_usd")
        totals["cost_usd"] += row_float(model_row, "cost_usd")

    groups = list(groups_by_key.values())
    for group in groups:
        group["models"].sort(key=lambda item: (-item["total_tokens"], item["model"]))
    groups.sort(key=lambda item: (item["day"], item["project_name"]), reverse=True)
    return {
        "generated_at": utc_now_iso(),
        "groups": groups,
        "totals": totals,
    }


def query_report_calls(
    conn: sqlite3.Connection,
    day: str | None,
    project_name: str | None,
    model: str | None,
    limit: int = 500,
) -> list[dict[str, Any]]:
    token_expr = token_total_sql()
    clauses = [
        "observed_at IS NOT NULL",
        f"(({token_expr}) > 0 OR COALESCE(tool_tokens, 0) > 0)",
    ]
    params: list[Any] = []
    if day:
        clauses.append("substr(observed_at, 1, 10) = ?")
        params.append(day)
    if project_name:
        clauses.append("COALESCE(NULLIF(project_name, ''), '(unknown project)') = ?")
        params.append(project_name)
    if model:
        clauses.append("COALESCE(NULLIF(model, ''), '(unknown model)') = ?")
        params.append(model)
    params.append(limit)
    rows = conn.execute(
        f"""
        SELECT * FROM events
        WHERE {" AND ".join(clauses)}
        ORDER BY COALESCE(observed_ns, 0) DESC, id DESC
        LIMIT ?
        """,
        params,
    ).fetchall()
    return [event_row_to_dict(row) for row in rows]


def query_timeline(conn: sqlite3.Connection, minutes: int = 45) -> list[dict[str, Any]]:
    now_minute = int(time.time() // 60) * 60
    start = now_minute - (minutes - 1) * 60
    buckets = {
        start + offset * 60: {
            "time": dt.datetime.fromtimestamp(start + offset * 60, dt.UTC)
            .isoformat(timespec="minutes")
            .replace("+00:00", "Z"),
            "events": 0,
            "input_tokens": 0,
            "output_tokens": 0,
        }
        for offset in range(minutes)
    }
    rows = conn.execute(
        """
        SELECT
          CAST(observed_ns / 1000000000 / 60 AS INTEGER) * 60 AS bucket,
          COUNT(*) AS events,
          COALESCE(SUM(input_tokens), 0) AS input_tokens,
          COALESCE(SUM(output_tokens), 0) AS output_tokens
        FROM events
        WHERE observed_ns >= ?
        GROUP BY bucket
        ORDER BY bucket ASC
        """,
        (start * 1_000_000_000,),
    ).fetchall()
    for row in rows:
        bucket = int(row["bucket"])
        if bucket in buckets:
            buckets[bucket]["events"] = int(row["events"])
            buckets[bucket]["input_tokens"] = int(row["input_tokens"])
            buckets[bucket]["output_tokens"] = int(row["output_tokens"])
    return list(buckets.values())


def make_summary(db_path: pathlib.Path, tail_status: dict[str, Any]) -> dict[str, Any]:
    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        total = conn.execute("SELECT COUNT(*) AS count FROM events").fetchone()["count"]
        last = conn.execute(
            """
            SELECT observed_at, event_name, service_name, model
            FROM events
            ORDER BY COALESCE(observed_ns, 0) DESC, id DESC
            LIMIT 1
            """
        ).fetchone()
        all_time = conn.execute(
            """
            SELECT
              COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
              COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
              COALESCE(SUM(tool_tokens), 0) AS tool_tokens,
              COALESCE(SUM(cost_usd), 0.0) AS cost_usd
            FROM events
            """
        ).fetchone()
        token_expr = token_total_sql()
        call_count = conn.execute(
            f"""
            SELECT COUNT(*) AS count
            FROM events
            WHERE event_name IN ({",".join("?" for _ in CALL_EVENT_NAMES)})
               OR ({token_expr}) > 0
               OR COALESCE(tool_tokens, 0) > 0
            """,
            tuple(sorted(CALL_EVENT_NAMES)),
        ).fetchone()["count"]
        return {
            "generated_at": utc_now_iso(),
            "source": tail_status.get("source"),
            "db": str(db_path),
            "tail": tail_status,
            "total_events": total,
            "last_event": dict(last) if last else None,
            "known_services": [
                {"name": name, "label": label}
                for name, label in KNOWN_SERVICES.items()
            ],
            "all_time": dict(all_time),
            "total_calls": call_count,
            "last_15m": query_counts(conn, 15),
            "top_services": query_top(conn, "service_name"),
            "top_events": query_top(conn, "event_name"),
            "top_models": query_top(conn, "model"),
            "usage": query_usage_breakdowns(conn),
            "timeline": query_timeline(conn),
        }


def make_snapshot(db_path: pathlib.Path, tail_status: dict[str, Any]) -> dict[str, Any]:
    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        return {
            "summary": make_summary(db_path, tail_status),
            "events": query_recent(conn),
            "calls": query_calls(conn),
        }


class DashboardServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(
        self,
        server_address: tuple[str, int],
        handler_class: type[BaseHTTPRequestHandler],
        db_path: pathlib.Path,
        tailer: OTelTailer,
        hub: EventHub,
    ) -> None:
        super().__init__(server_address, handler_class)
        self.db_path = db_path
        self.tailer = tailer
        self.hub = hub

    def handle_error(self, request: Any, client_address: Any) -> None:
        exc = sys.exc_info()[1]
        if isinstance(exc, (BrokenPipeError, ConnectionResetError)):
            return
        super().handle_error(request, client_address)


class Handler(BaseHTTPRequestHandler):
    server: DashboardServer

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("%s - %s\n" % (self.log_date_time_string(), fmt % args))

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/":
            self.serve_file(STATIC_ROOT / "index.html", "text/html; charset=utf-8")
        elif parsed.path == "/favicon.ico":
            self.send_response(HTTPStatus.NO_CONTENT)
            self.end_headers()
        elif parsed.path == "/static/app.js":
            self.serve_file(STATIC_ROOT / "app.js", "application/javascript; charset=utf-8")
        elif parsed.path == "/static/styles.css":
            self.serve_file(STATIC_ROOT / "styles.css", "text/css; charset=utf-8")
        elif parsed.path == "/api/snapshot":
            self.respond_json(make_snapshot(self.server.db_path, self.server.tailer.status()))
        elif parsed.path == "/api/calls":
            self.respond_json(self.make_calls_response())
        elif parsed.path == "/api/report":
            self.respond_json(self.make_report_response())
        elif parsed.path == "/api/report/calls":
            self.respond_json(self.make_report_calls_response(parsed))
        elif parsed.path == "/api/event":
            self.respond_event_detail(parsed)
        elif parsed.path == "/api/health":
            self.respond_json(
                {
                    "ok": True,
                    "summary": make_summary(self.server.db_path, self.server.tailer.status()),
                }
            )
        elif parsed.path == "/events":
            self.serve_sse()
        else:
            self.send_error(HTTPStatus.NOT_FOUND)

    def make_calls_response(self) -> dict[str, Any]:
        with sqlite3.connect(self.server.db_path) as conn:
            conn.row_factory = sqlite3.Row
            return {
                "calls": query_calls(conn),
                "usage": query_usage_breakdowns(conn),
            }

    def make_report_response(self) -> dict[str, Any]:
        with sqlite3.connect(self.server.db_path) as conn:
            conn.row_factory = sqlite3.Row
            return {
                "report": query_usage_report(conn),
                "summary": make_summary(self.server.db_path, self.server.tailer.status()),
            }

    def make_report_calls_response(self, parsed: urllib.parse.ParseResult) -> dict[str, Any]:
        params = urllib.parse.parse_qs(parsed.query)
        with sqlite3.connect(self.server.db_path) as conn:
            conn.row_factory = sqlite3.Row
            return {
                "calls": query_report_calls(
                    conn,
                    params.get("day", [None])[0],
                    params.get("project", [None])[0],
                    params.get("model", [None])[0],
                )
            }

    def respond_event_detail(self, parsed: urllib.parse.ParseResult) -> None:
        params = urllib.parse.parse_qs(parsed.query)
        try:
            event_id = int(params.get("id", [""])[0])
        except (TypeError, ValueError):
            self.send_error(HTTPStatus.BAD_REQUEST, "missing or invalid id")
            return
        with sqlite3.connect(self.server.db_path) as conn:
            conn.row_factory = sqlite3.Row
            event = query_event_detail(conn, event_id)
        if event is None:
            self.send_error(HTTPStatus.NOT_FOUND, "event not found")
            return
        self.respond_json({"event": event})

    def serve_file(self, path: pathlib.Path, content_type: str) -> None:
        if not path.exists():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        body = path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def respond_json(self, payload: Any) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def write_sse(self, event: str, payload: Any) -> None:
        data = json.dumps(payload, separators=(",", ":"))
        self.wfile.write(f"event: {event}\n".encode("utf-8"))
        for line in data.splitlines():
            self.wfile.write(f"data: {line}\n".encode("utf-8"))
        self.wfile.write(b"\n")
        self.wfile.flush()

    def serve_sse(self) -> None:
        client = self.server.hub.subscribe()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        try:
            self.write_sse("snapshot", make_snapshot(self.server.db_path, self.server.tailer.status()))
            while True:
                try:
                    message = client.get(timeout=15)
                    self.write_sse(message["type"], message)
                except queue.Empty:
                    self.wfile.write(b": keep-alive\n\n")
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            self.server.hub.unsubscribe(client)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="NOPEntel local telemetry dashboard")
    parser.add_argument("--source", type=pathlib.Path, default=DEFAULT_SOURCE)
    parser.add_argument("--db", type=pathlib.Path, default=DEFAULT_DB)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    init_db(args.db)
    hub = EventHub()
    tailer = OTelTailer(args.source.expanduser(), args.db.expanduser(), hub)
    tailer.start()

    httpd = DashboardServer((args.host, args.port), Handler, args.db.expanduser(), tailer, hub)

    shutdown_started = threading.Event()

    def handle_signal(signum: int, _frame: Any) -> None:
        if shutdown_started.is_set():
            return
        shutdown_started.set()
        print(f"\nreceived signal {signum}; shutting down", file=sys.stderr)
        tailer.stop()
        threading.Thread(target=httpd.shutdown, name="http-shutdown", daemon=True).start()

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    print(f"NOPEntel: http://{args.host}:{args.port}")
    print(f"Source: {args.source.expanduser()}")
    print(f"SQLite: {args.db.expanduser()}")
    try:
        httpd.serve_forever()
    finally:
        tailer.stop()
        tailer.join(timeout=2)
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
