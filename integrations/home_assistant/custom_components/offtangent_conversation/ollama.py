"""Native Ollama /api/chat client for the local primary path (no HA imports, no tool execution).

Speaks the same contract as AdapterClient.complete() -> Reply, so run_turn (confirmation,
no-match retry, deadline) is shared. Every reply is validated as a whole batch before any
dispatch. Per-call timings (prompt_eval/eval) go to an optional per-turn metrics sink.
"""
from __future__ import annotations

import json
import re
import time
from typing import Any
from uuid import uuid4

import aiohttp

from .client import MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, AdapterError, Reply, decode_json
from .const import DEFAULT_KEEP_ALIVE

MODEL_NAME = re.compile(r"^[A-Za-z0-9._:/-]{1,128}$")
# HA appends "Current time is HH:MM:SS. Today's date is ..." to the system prompt when no
# GetDateTime tool exists. Changing every second, it would invalidate the cached prompt prefix
# (tools are rendered after the system text), so it moves to the end of the user message.
_TIME_LINE = re.compile(r"^Current time is \d{1,2}:\d{2}(?::\d{2})?\. Today's date is [0-9-]+\.\s*$", re.M)
# Ollama keep_alive: -1 (stay loaded), 0 (unload after the request) or a duration such as "15m".
KEEP_ALIVE = re.compile(r"^(?:-1|0|[1-9][0-9]{0,5}(?:ms|s|m|h))$")
# The keep-warm ping re-evaluates the whole prompt when the server cache is cold (about 5900 tokens
# on the 27B model, longer than the 15 s turn timeout), so it gets its own, longer budget.
WARM_TIMEOUT_S = 60
TIMING_KEYS = ("total_duration", "load_duration", "prompt_eval_count", "prompt_eval_duration",
               "eval_count", "eval_duration")


def validate_ollama_url(value: str) -> str:
    from urllib.parse import urlsplit
    url = urlsplit(value or "")
    if (url.scheme not in {"http", "https"} or not url.hostname or url.username or url.password
            or url.query or url.fragment or url.path not in {"", "/"}):
        raise ValueError("invalid_ollama_url")
    return value.rstrip("/")


def parse_keep_alive(value) -> int | str:
    """Validate an Ollama keep_alive option: "-1" and "0" become ints, durations stay strings."""
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        raise ValueError("invalid_keep_alive")
    text = str(value).strip()
    if not KEEP_ALIVE.fullmatch(text):
        raise ValueError("invalid_keep_alive")
    return int(text) if text in {"-1", "0"} else text


def stable_prompt(prompt: str) -> tuple[str, str | None]:
    """Split the per-second time line off the system prompt (returns prompt, time hint)."""
    match = _TIME_LINE.search(prompt or "")
    if not match:
        return prompt, None
    stable = (prompt[:match.start()] + prompt[match.end():]).rstrip() + "\n"
    return stable, match.group(0).strip()


_STATIC_HEAD = "Static Context: An overview of the areas and the devices in this smart home:\n"
LOCAL_HINTS = ("Hinweise: Mehrere Namen in einer Zeile sind Aliase EINES Geräts. "
               "Stockwerke wie Erdgeschoss oder Obergeschoss gehören in floor, nicht in area. "
               "Für name nur exakte Namen aus der Liste; sind alle Geräte eines Bereichs gemeint, "
               "lass name weg und nutze area plus domain.")
DESC_MAX = 160  # local tool descriptions are cut to their first sentence(s) up to this length


def compact_prompt(prompt: str) -> str:
    """Local path only: HA's YAML device overview as one line per device.

    "- names: A, B / domain: light / areas: Büro" becomes "- A, B (light, Büro)". Same facts,
    roughly half the tokens. Everything before the overview stays byte-identical, so the
    cached prompt start is unchanged; text that does not parse is left as it is.
    """
    if not prompt or _STATIC_HEAD not in prompt:
        return prompt
    head, rest = prompt.split(_STATIC_HEAD, 1)
    block, sep, tail = rest.partition("\n\n")
    out, cur = [], None
    for line in block.splitlines():
        if line.startswith("- names: "):
            cur = {"names": line[9:].strip()}
            out.append(cur)
        elif cur is not None and line.startswith("  ") and ":" in line:
            key, value = line.strip().split(":", 1)
            cur[key.strip()] = value.strip()
        else:
            return prompt  # unknown shape: never guess
    lines = []
    for e in out:
        extra = [e[k] for k in ("domain", "areas") if e.get(k)]
        if set(e) - {"names", "domain", "areas"}:
            extra += [f"{k}: {v}" for k, v in e.items() if k not in ("names", "domain", "areas")]
        lines.append(f"- {e['names']} ({', '.join(extra)})" if extra else f"- {e['names']}")
    return (head + "Static Context: Geräte im Haus (Name, Aliase (Domäne, Bereich)):\n"
            + "\n".join(lines) + "\n" + LOCAL_HINTS + sep + tail)


def _short(text: str) -> str:
    if not isinstance(text, str) or len(text) <= DESC_MAX:
        return text
    cut = text[:DESC_MAX]
    stops = [m.start() for m in re.finditer(r"(?<![0-9])\.(?=\s)", cut)]
    return cut[:stops[-1] + 1] if stops and stops[-1] > 40 else cut.rstrip() + "…"


def compact_tools(tools: list[dict]) -> list[dict]:
    """Local path only: same tools, same order, same parameters; long descriptions shortened."""
    out = []
    for tool in tools:
        func = dict(tool.get("function") or {})
        func["description"] = _short(func.get("description"))
        params = func.get("parameters")
        if isinstance(params, dict) and isinstance(params.get("properties"), dict):
            props = {}
            for key, spec in params["properties"].items():
                if isinstance(spec, dict) and "description" in spec:
                    spec = {**spec, "description": _short(spec["description"])}
                props[key] = spec
            func["parameters"] = {**params, "properties": props}
        out.append({**tool, "function": func})
    return out


def to_ollama_messages(messages: list[dict]) -> list[dict]:
    """OpenAI-style canonical messages -> Ollama chat messages (arguments as objects)."""
    out, names = [], {}
    for message in messages:
        role = message["role"]
        if role == "assistant":
            item = {"role": "assistant", "content": message.get("content") or ""}
            calls = []
            for call in message.get("tool_calls", []):
                func = call["function"]
                names[call["id"]] = func["name"]
                calls.append({"function": {"name": func["name"], "arguments": decode_json(func["arguments"])}})
            if calls:
                item["tool_calls"] = calls
            out.append(item)
        elif role == "tool":
            item = {"role": "tool", "content": message["content"]}
            if message.get("tool_call_id") in names:
                item["tool_name"] = names[message["tool_call_id"]]
            out.append(item)
        else:
            out.append({"role": role, "content": message.get("content") or ""})
    return out


def validate_ollama_reply(data: Any, model: str, tools: list[dict]) -> Reply:
    """Same guarantees as validate_reply: whole batch checked before any dispatch."""
    try:
        if not isinstance(data, dict) or data.get("model") != model or data.get("done") is not True:
            raise ValueError()
        msg = data["message"]
        if not isinstance(msg, dict) or msg.get("role") != "assistant":
            raise ValueError()
        text = msg.get("content")
        if text is not None and (not isinstance(text, str) or len(text) > 32768):
            raise ValueError()
        raw_calls = msg.get("tool_calls") or []
        if not isinstance(raw_calls, list) or len(raw_calls) > 8:
            raise ValueError()
        if not raw_calls and data.get("done_reason") not in (None, "stop"):
            raise ValueError()  # e.g. "length": truncated answer is never spoken
        names = {tool["function"]["name"] for tool in tools}
        calls, ids = [], set()
        for raw in raw_calls:
            func = raw["function"]
            name, args = func["name"], func.get("arguments", {})
            if name not in names:
                raise ValueError()
            if isinstance(args, str):
                args = decode_json(args)
            if not isinstance(args, dict):
                raise ValueError()
            encoded = json.dumps(args, ensure_ascii=False, allow_nan=False)
            if len(encoded) > 16384:
                raise ValueError()
            call_id = raw.get("id")
            if not isinstance(call_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", call_id) or call_id in ids:
                call_id = "call_" + uuid4().hex[:16]
            ids.add(call_id)
            calls.append({"id": call_id, "type": "function", "function": {"name": name, "arguments": encoded}})
        if not calls:
            if not isinstance(text, str) or not text.strip():
                raise ValueError()
            return Reply({"role": "assistant", "content": text.strip()}, None)
        # Tool-call turns carry no spoken text (same canonical shape as the relay).
        return Reply({"role": "assistant", "content": None, "tool_calls": calls}, None)
    except (KeyError, TypeError, ValueError, AttributeError) as err:
        raise AdapterError("invalid_ollama_response") from err


class OllamaClient:
    """Dedicated HTTP session to a LAN Ollama; keep_alive/num_ctx set per request only."""

    def __init__(self, url: str, model: str, num_ctx: int = 16384, timeout: int = 20,
                 keep_alive: int | str = DEFAULT_KEEP_ALIVE, warm_timeout: int = WARM_TIMEOUT_S):
        self.url = validate_ollama_url(url)
        if (not isinstance(model, str) or not MODEL_NAME.fullmatch(model) or model.endswith((":cloud", "-cloud"))
                or not isinstance(num_ctx, int) or not 2048 <= num_ctx <= 131072
                or not isinstance(timeout, int) or not 1 <= timeout <= 100
                or not isinstance(warm_timeout, int) or isinstance(warm_timeout, bool) or not 1 <= warm_timeout <= 300):
            raise ValueError("invalid_ollama_config")
        self.model = model
        self.num_ctx = num_ctx
        self.keep_alive = parse_keep_alive(keep_alive)
        self.timeout = timeout
        self.warm_timeout = warm_timeout
        self._session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout), trust_env=False)

    async def close(self):
        await self._session.close()

    def payload(self, messages, tools):
        body = {"model": self.model, "messages": to_ollama_messages(messages), "stream": False,
                "think": False, "keep_alive": self.keep_alive, "options": {"num_ctx": self.num_ctx}}
        if tools:
            body["tools"] = tools
        return body

    async def complete(self, messages, tools, session=None, metrics=None):
        encoded = json.dumps(self.payload(messages, tools), ensure_ascii=False, allow_nan=False).encode()
        if len(encoded) > MAX_REQUEST_BYTES:
            raise AdapterError("request_too_large")
        start = time.monotonic()
        try:
            async with self._session.post(self.url + "/api/chat", data=encoded, allow_redirects=False,
                                          headers={"Content-Type": "application/json"}) as response:
                if response.status != 200:
                    raise AdapterError("ollama_http_%d" % response.status)
                parts, size = [], 0
                async for chunk in response.content.iter_chunked(65536):
                    size += len(chunk)
                    if size > MAX_RESPONSE_BYTES:
                        raise AdapterError("invalid_ollama_response")
                    parts.append(chunk)
            data = decode_json(b"".join(parts).decode())
        except TimeoutError as err:
            raise AdapterError("ollama_timeout") from err
        except (aiohttp.ClientError, OSError) as err:
            raise AdapterError("ollama_unreachable") from err
        except (UnicodeDecodeError, ValueError) as err:
            raise AdapterError("invalid_ollama_response") from err
        if metrics is not None:
            entry = {k: data.get(k) for k in TIMING_KEYS if isinstance(data, dict) and isinstance(data.get(k), int)}
            entry["wall_ms"] = round((time.monotonic() - start) * 1000)
            metrics.append(entry)
        return validate_ollama_reply(data, self.model, tools)

    async def warm(self, prompt: str, tools: list[dict]) -> dict:
        """Keep-warm ping: same system prompt and tools as the last local turn, 1 token, no tools run.

        Refreshes the server's prompt cache for the stable prompt start and keeps the model
        loaded (keep_alive per request). The reply is discarded; nothing is dispatched.
        Timeout: warm_timeout (default 60 s), independent of the turn timeout.
        """
        body = self.payload([{"role": "system", "content": prompt}, {"role": "user", "content": "ping"}], tools)
        body["options"] = {**body["options"], "num_predict": 1}
        start = time.monotonic()
        try:
            # Own budget (warm_timeout), not the session's turn timeout: with a cold prompt cache this
            # ping takes longer than a user turn may, and aborting it only leaves an HTTP 500 in the
            # Ollama log while the cache stays cold.
            async with self._session.post(self.url + "/api/chat", data=json.dumps(body, ensure_ascii=False).encode(),
                                          allow_redirects=False, headers={"Content-Type": "application/json"},
                                          timeout=aiohttp.ClientTimeout(total=self.warm_timeout)) as response:
                data = await response.json(content_type=None) if response.status == 200 else {}
        except TimeoutError as err:
            raise AdapterError("ollama_timeout") from err
        except (aiohttp.ClientError, OSError, ValueError) as err:
            raise AdapterError("ollama_unreachable") from err
        out = {k: data.get(k) for k in TIMING_KEYS if isinstance(data, dict) and isinstance(data.get(k), int)}
        out["wall_ms"] = round((time.monotonic() - start) * 1000)
        return out

    async def check_model(self):
        try:
            async with self._session.get(self.url + "/api/tags", allow_redirects=False) as response:
                data = await response.json(content_type=None)
        except (aiohttp.ClientError, OSError, TimeoutError, ValueError) as err:
            raise AdapterError("ollama_unreachable") from err
        names = {m.get("name") for m in data.get("models", []) if isinstance(m, dict)} if isinstance(data, dict) else set()
        if self.model not in names:
            raise AdapterError("ollama_model_missing")


class MeteredTurn:
    """Per-turn view of a client: collects timings without changing run_turn's call contract."""

    def __init__(self, client):
        self._client = client
        self.calls: list[dict] = []

    async def complete(self, messages, tools, session=None):
        return await self._client.complete(messages, tools, session, metrics=self.calls)
