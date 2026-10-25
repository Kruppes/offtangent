"""Append-only JSONL turn log (training data for phase 2). Never raises into a turn.

Two record kinds share one daily file <dir>/YYYY-MM/turns-YYYY-MM-DD.jsonl:
- "agent": one line per turn of this agent (path ollama/relay/fallback, tool calls with
  arguments, HA confirmation, answer, Ollama prompt_eval/eval timings).
- "pipeline": one line per finished Assist pipeline run (STT text, stage latencies,
  processed_locally, spoken answer), read from HA's in-memory pipeline debug store.
Join key: conversation_id (+ timestamps). Plain file appends only; no SQLite.
"""
from __future__ import annotations

import json
import logging
import os
from datetime import datetime
from pathlib import Path
from typing import Any

_LOGGER = logging.getLogger(__name__)
MAX_FIELD_CHARS = 8000


def clip(value: Any, limit: int = MAX_FIELD_CHARS) -> Any:
    if isinstance(value, str) and len(value) > limit:
        return value[:limit] + "…[+%d]" % (len(value) - limit)
    return value


def daily_path(base: str, now: datetime | None = None) -> Path:
    now = now or datetime.now().astimezone()
    return Path(base) / now.strftime("%Y-%m") / now.strftime("turns-%Y-%m-%d.jsonl")


def append_line(base: str, record: dict) -> None:
    """Blocking; run in the executor. One write() call per line (O_APPEND)."""
    path = daily_path(base)
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(record, ensure_ascii=False, default=str) + "\n"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
    try:
        os.write(fd, line.encode())
    finally:
        os.close(fd)


def tool_trace(messages: list[dict]) -> list[dict]:
    """Tool calls with arguments plus the (clipped) HA result of each call."""
    trace, by_id = [], {}
    for message in messages:
        if message.get("role") == "assistant":
            for call in message.get("tool_calls", []) or []:
                func = call["function"]
                try:
                    args = json.loads(func["arguments"])
                except (TypeError, ValueError):
                    args = func["arguments"]
                item = {"id": call["id"], "name": func["name"], "arguments": args, "result": None}
                by_id[call["id"]] = item
                trace.append(item)
        elif message.get("role") == "tool" and message.get("tool_call_id") in by_id:
            by_id[message["tool_call_id"]]["result"] = clip(message.get("content"))
    return trace


def summarize_ollama(calls: list[dict]) -> dict:
    """Seconds, as in Ollama's own fields (ns). First call = prompt cache indicator."""
    def sec(value):
        return round(value / 1e9, 3) if isinstance(value, int) else None
    first = calls[0] if calls else {}
    return {
        "calls": len(calls),
        "prompt_tokens_first": first.get("prompt_eval_count"),
        "prompt_eval_s_first": sec(first.get("prompt_eval_duration")),
        "load_s_first": sec(first.get("load_duration")),
        "prompt_eval_s": round(sum(c.get("prompt_eval_duration", 0) for c in calls) / 1e9, 3) if calls else None,
        "eval_s": round(sum(c.get("eval_duration", 0) for c in calls) / 1e9, 3) if calls else None,
        "eval_tokens": sum(c.get("eval_count", 0) for c in calls) if calls else None,
        "per_call": calls,
    }


def _event_time(event) -> datetime | None:
    try:
        return datetime.fromisoformat(event["timestamp"])
    except (KeyError, TypeError, ValueError):
        return None


def pipeline_record(pipeline_id: str, run_id: str, events: list[dict]) -> dict | None:
    """Build one record from a FINISHED run's debug events (dicts as in pipeline_debug/get)."""
    types = [e.get("type") for e in events]
    if "run-end" not in types and "error" not in types:
        return None  # still running
    if "intent-start" not in types and "stt-end" not in types:
        return None  # wake-word-only runs carry no turn
    rec: dict[str, Any] = {"kind": "pipeline", "pipeline_id": pipeline_id, "run_id": run_id}
    start = _event_time(events[0])
    rec["ts"] = start.isoformat() if start else None
    stamps: dict[str, datetime] = {}
    for event in events:
        kind, data = event.get("type"), event.get("data") or {}
        when = _event_time(event)
        if when:
            stamps.setdefault(kind, when)
        if kind == "run-start":
            rec["conversation_id"] = data.get("conversation_id")
        elif kind == "stt-start":
            rec["stt_engine"] = data.get("engine")
        elif kind == "stt-end":
            rec["stt_text"] = clip((data.get("stt_output") or {}).get("text"))
        elif kind == "intent-start":
            rec["engine"] = data.get("engine")
            rec["intent_input"] = clip(data.get("intent_input"))
            rec["device_id"] = data.get("device_id")
            rec.setdefault("conversation_id", data.get("conversation_id"))
        elif kind == "intent-end":
            out = data.get("intent_output") or {}
            rec["processed_locally"] = data.get("processed_locally")
            rec["conversation_id"] = out.get("conversation_id") or rec.get("conversation_id")
            resp = out.get("response") or {}
            rec["response_type"] = resp.get("response_type")
            rec["answer"] = clip(((resp.get("speech") or {}).get("plain") or {}).get("speech"))
            rec["intent_data"] = clip(json.dumps(resp.get("data"), ensure_ascii=False, default=str), 4000)
        elif kind == "tts-start":
            rec["tts_engine"] = data.get("engine")
        elif kind == "error":
            rec["error"] = {"code": data.get("code"), "message": clip(data.get("message"), 500)}

    def span(a, b):
        if a in stamps and b in stamps:
            return round((stamps[b] - stamps[a]).total_seconds(), 3)
        return None
    rec["latency_s"] = {"stt": span("stt-start", "stt-end"), "intent": span("intent-start", "intent-end"),
                        "tts": span("tts-start", "tts-end"), "total": span("run-start", "run-end")}
    if rec.get("processed_locally"):
        rec["path"] = "local_intent"
    elif rec.get("engine"):
        rec["path"] = "agent:" + str(rec["engine"])
    return rec


class PipelineScanner:
    """Polls HA's pipeline debug store (10 runs/pipeline kept) and logs each finished run once."""

    def __init__(self, hass, base: str):
        self.hass = hass
        self.base = base
        self.seen: dict[str, float] = {}

    def _store(self):
        try:
            from homeassistant.components.assist_pipeline.pipeline import KEY_ASSIST_PIPELINE
        except ImportError:
            return None
        data = self.hass.data.get(KEY_ASSIST_PIPELINE)
        return getattr(data, "pipeline_debug", None)

    async def scan(self, _now=None):
        store = self._store()
        if not store:
            return
        records = []
        for pipeline_id, runs in list(store.items()):
            for run_id, debug in list(runs.items()):
                if run_id in self.seen:
                    continue
                events = [dict(e) if isinstance(e, dict) else _as_dict(e) for e in list(debug.events)]
                types = {e.get("type") for e in events}
                if "run-end" not in types and "error" not in types:
                    continue  # still running; look again next scan
                self.seen[run_id] = 0
                rec = pipeline_record(pipeline_id, run_id, events)
                if rec is not None:
                    records.append(rec)
        if len(self.seen) > 2000:
            for key in list(self.seen)[:1000]:
                self.seen.pop(key, None)
        for rec in records:
            await log_async(self.hass, self.base, rec)

    def prime(self):
        """Do not re-log runs that finished before this instance started."""
        store = self._store() or {}
        for runs in store.values():
            for run_id in list(runs):
                self.seen[run_id] = 0


def _as_dict(event) -> dict:
    as_dict = getattr(event, "as_dict", None)
    if callable(as_dict):
        return as_dict()
    return {"type": str(getattr(event, "type", "")), "data": getattr(event, "data", None),
            "timestamp": getattr(event, "timestamp", None)}


async def log_async(hass, base: str | None, record: dict) -> None:
    if not base:
        return
    try:
        await hass.async_add_executor_job(append_line, base, record)
    except Exception:  # noqa: BLE001 - logging must never break a voice turn
        _LOGGER.warning("turn log write failed (%s)", base, exc_info=True)
