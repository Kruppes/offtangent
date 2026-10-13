"""Strict, buffered, no-retry chat-completions client; no HA imports or tool execution."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import date, datetime, time
from enum import Enum
import ipaddress
import json
import math
import re
from typing import Any
from urllib.parse import urlsplit

import aiohttp

MAX_RESPONSE_BYTES = 262144
MAX_REQUEST_BYTES = 262144
MAX_ROUNDS = 8
# Provider wire constraint for function names, NOT a namespace allowlist. OpenAI function
# names: ^[a-zA-Z0-9_-]{1,64}$; Anthropic client tools: ^[a-zA-Z0-9_-]{1,128}$ (docs.claude.com
# "Define tools"). The stricter common subset is used. Which tools exist is decided only by
# HA's own api.tools (exposure-dependent, incl. custom-integration llm platforms, script__1_x,
# intent_script__*); execution stays in HA, so the name never comes from the model alone.
TOOL_NAME = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
# Separate follow-up model round after confirmed HA actions (native answer / multi-step);
# bounded so a slow provider can never push the turn into the outer HA timeout.
FOLLOWUP_TIMEOUT = 30
# Single-entry allowlist meaning "every tool of the native HA Assist API" (control only).
ALL_ASSIST_TOOLS = "*"


class AdapterError(Exception):
    """Sanitized error, never includes URL, token, prompt or upstream body."""


def validate_url(value: str) -> str:
    """TLS mandatory except loopback; forbid credentials, redirects and query tricks."""
    if (not isinstance(value, str) or len(value) > 2048 or any(c.isspace() for c in value)
        or "?" in value or "#" in value):
        raise ValueError("invalid_url")
    url = urlsplit(value)
    try:
        loopback = ipaddress.ip_address(url.hostname or "").is_loopback
    except ValueError:
        loopback = url.hostname == "localhost"
    if (url.scheme not in ("http", "https") or not url.hostname
        or (url.scheme == "http" and not loopback) or url.username or url.password
        or url.query or url.fragment or url.path.rstrip("/") not in {"/v1", "/ha-relay/v1"}):
        raise ValueError("invalid_url")
    try:
        _ = url.port
    except ValueError as err:
        raise ValueError("invalid_url") from err
    return value.rstrip("/")


def decode_json(text: str) -> Any:
    """Reject duplicate keys and non-JSON NaN/Infinity rather than repairing."""
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate_json_key")
            result[key] = value
        return result

    def invalid_constant(_):
        raise ValueError("invalid_json_number")

    def finite_float(raw):
        value = float(raw)
        if not math.isfinite(value):
            raise ValueError("invalid_json_number")
        return value

    return json.loads(text, object_pairs_hook=pairs, parse_constant=invalid_constant, parse_float=finite_float)


@dataclass(frozen=True)
class Reply:
    message: dict[str, Any]
    session: str | None


def validate_reply(data: Any, model: str, tools: list[dict]) -> Reply:
    """Validate the WHOLE action batch before any HA dispatch."""
    try:
        if not isinstance(data, dict) or data.get("model") != model:
            raise ValueError()
        choices = data["choices"]
        if not isinstance(choices, list) or len(choices) != 1:
            raise ValueError()
        choice = choices[0]
        msg = choice["message"]
        if msg.get("role") != "assistant" or set(msg) - {"role", "content", "tool_calls"}:
            raise ValueError()
        text = msg.get("content")
        if text is not None and (not isinstance(text, str) or len(text) > 32768):
            raise ValueError()
        calls = msg.get("tool_calls", [])
        if not isinstance(calls, list) or len(calls) > 8:
            raise ValueError()
        if choice.get("finish_reason") != ("tool_calls" if calls else "stop"):
            raise ValueError()
        if not calls and (not text or not text.strip()):
            raise ValueError()
        names = {tool["function"]["name"] for tool in tools}
        ids = set()
        for call in calls:
            if set(call) != {"id", "type", "function"} or call["type"] != "function":
                raise ValueError()
            if (not isinstance(call["id"], str) or not call["id"]
                or len(call["id"]) > 128 or call["id"] in ids):
                raise ValueError()
            ids.add(call["id"])
            func = call["function"]
            if set(func) != {"name", "arguments"} or func["name"] not in names:
                raise ValueError()
            if (not isinstance(func["arguments"], str)
                or len(func["arguments"]) > 16384
                or not isinstance(decode_json(func["arguments"]), dict)):
                raise ValueError()
        session = data.get("ha_session")
        if session is not None and (not isinstance(session, str) or not session or len(session) > 128):
            raise ValueError()
        # Exact canonical assistant message is needed by the server's native vault.
        return Reply({"role": "assistant", "content": text,
                      **({"tool_calls": calls} if calls else {})}, session)
    except (KeyError, TypeError, ValueError, AttributeError) as err:
        raise AdapterError("invalid_adapter_response") from err


class AdapterClient:
    """Dedicated HTTP session, no SDK/env/proxy credential fallback or POST retries."""

    def __init__(self, url: str, token: str, model: str, timeout: int = 95):
        self.url = validate_url(url)
        if (not isinstance(token, str) or not re.fullmatch(r"[^\s]{16,512}", token)
            or not isinstance(model, str) or not re.fullmatch(r"[A-Za-z0-9-]{1,128}", model)
            or not isinstance(timeout, int) or not 1 <= timeout <= 100):
            raise ValueError("invalid_client_config")
        self._token = token
        self.model = model
        self._session = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=timeout), trust_env=False,
            headers={"Authorization": "Bearer " + token},
        )

    async def close(self):
        await self._session.close()

    async def _request(self, method: str, path: str, payload=None):
        try:
            kwargs = {"allow_redirects": False}
            if payload is not None:
                encoded = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode()
                if len(encoded) > MAX_REQUEST_BYTES:
                    raise AdapterError("request_too_large")
                kwargs.update(data=encoded, headers={"Content-Type": "application/json"})
            async with self._session.request(method, self.url + path, **kwargs) as response:
                if response.content_type != "application/json":
                    raise AdapterError("invalid_adapter_response")
                parts = []
                size = 0
                async for part in response.content.iter_chunked(16384):
                    size += len(part)
                    if size > MAX_RESPONSE_BYTES:
                        raise AdapterError("response_too_large")
                    parts.append(part)
                data = decode_json(b"".join(parts).decode("utf-8"))
                if response.status != 200:
                    error = data.get("error") if isinstance(data, dict) else None
                    code = error.get("code") if isinstance(error, dict) else None
                    safe = {"provider_relogin_required", "provider_refresh_unavailable", "provider_access_rejected",
                            "provider_access_blocked", "subscription_rate_limit", "timeout", "subscription_http_error"}
                    raise AdapterError(code if isinstance(code, str) and code in safe else "adapter_http_" + str(response.status))
                return data
        except (aiohttp.ClientError, TimeoutError, ValueError, UnicodeError) as err:
            raise AdapterError("adapter_unavailable") from err
        # CancelledError deliberately propagates. No retry and no model fallback.

    async def auth_status(self):
        return await self._request("GET", "/status")

    async def discard(self, session):
        if session:
            await self._request("POST", "/session/discard", {"ha_session": session})

    async def check_model(self):
        data = await self._request("GET", "/models")
        try:
            if self.model not in {item["id"] for item in data["data"]}:
                raise AdapterError("model_not_advertised")
        except (KeyError, TypeError) as err:
            raise AdapterError("invalid_adapter_response") from err

    async def complete(self, messages, tools, session=None):
        payload = {"model": self.model, "messages": messages, "stream": False}
        if tools:
            payload["tools"] = tools
        if session is not None:
            payload["ha_session"] = session
        return validate_reply(await self._request("POST", "/chat/completions", payload), self.model, tools)


# Verified against HA 2026.9.4 intent handlers (intent, intent.timers, weather).
# TimerStatus only reads Assist timers; start/cancel/pause remain mutations.
READ_ONLY_TOOLS = {"GetLiveContext", "HassGetState", "HassClimateGetTemperature",
                   "HassGetWeather", "HassTimerStatus", "HassGetCurrentTime",
                   "HassGetCurrentDate", "HassRespond"}


# Native non-intent Assist tools (HA 2026.9.4 llm/, todo/, calendar/ llm.py): read-only,
# reply {"success": true, "result": ...} instead of an IntentResponse.
READ_ONLY_NATIVE_TOOLS = {"llm__GetDateTime", "todo__get_items", "calendar__get_events"}


def select_tools(api_tools, allowed):
    """Return (selected {name: tool}, unsendable names). Never filters by namespace.

    Every tool HA's Assist API offers for this exposure is passed through when allowed;
    only names the provider wire format cannot carry are reported (never silently lost).
    """
    selected, unsendable = {}, []
    for tool in api_tools or []:
        if not (tool.name in allowed or ALL_ASSIST_TOOLS in allowed):
            continue
        if TOOL_NAME.fullmatch(tool.name) and tool.name not in selected:
            selected[tool.name] = tool
        else:
            unsendable.append(tool.name)
    return selected, unsendable


def is_intent_script(name: str) -> bool:
    return name.startswith("intent_script__")


def is_mutating(name: str) -> bool:
    # Unknown tools remain action-like: no heuristic allowing future mutations.
    if name in READ_ONLY_NATIVE_TOOLS:
        return False
    return name.split("__")[-1] not in READ_ONLY_TOOLS


def _intent_response(result: Any) -> bool:
    return isinstance(result, dict) and "response_type" in result and isinstance(result.get("data"), dict)


def confirmed_result(name: str, result: Any) -> bool:
    """Actions need HA's own success signal. Known info tools need a successful typed response."""
    if not isinstance(result, dict) or result.get("error") or result.get("success") is False:
        return False
    if name.split("__")[-1] == "GetLiveContext":
        return result.get("success") is True and isinstance(result.get("result"), str)
    if name in READ_ONLY_NATIVE_TOOLS or name.startswith("script__"):
        # script__* is HA's ActionTool: success only after the blocking script service call returned.
        return result.get("success") is True and "result" in result
    if _intent_response(result):
        data = result["data"]
        if data.get("failed") or result["response_type"] not in {"query_answer", "action_done"}:
            return False
        if is_intent_script(name) or not is_mutating(name):
            # ScriptIntentHandler (HA 2026.9 intent_script) only sets speech/card, never targets:
            # a real IntentResponse.as_dict() is action_done with success=[] after the script ran.
            return True
        return (result["response_type"] == "action_done"
                and isinstance(data.get("success"), list) and bool(data["success"]))
    if not is_mutating(name) or name.split("__")[-1].startswith("Hass"):
        # Hass* intents and known info tools must deliver their typed HA response.
        return False
    # Non-intent tool of another (e.g. custom) llm platform returned normally inside HA
    # (no exception, no error, success not False): its result goes to the model unchanged.
    return bool(result)


def ha_speech(result: Any) -> str | None:
    """Native HA speech of an IntentResponse (e.g. intent_script), bounded."""
    try:
        speech = result["speech"]["plain"]["speech"]
    except (KeyError, TypeError):
        return None
    return speech.strip()[:1024] or None if isinstance(speech, str) else None


def json_result(result):
    def safe(value):
        if isinstance(value, (datetime, date, time)):
            return value.isoformat()
        if isinstance(value, Enum):
            return value.value
        raise TypeError("unsupported_tool_result_type")
    return json.dumps(result, ensure_ascii=False, allow_nan=False, default=safe)


@dataclass
class TurnProgress:
    dispatched: bool = False
    provider_completed: bool = False


@dataclass
class Outcome:
    text: str
    messages: list[dict]
    failed: bool = False
    start_index: int = 2
    session: None = None  # Completed turns never export a reusable native action vault.


def _confirmation(mutations: int, speeches: list[str]) -> str:
    if speeches:
        return " ".join(speeches)[:2048]
    return "Home Assistant hat die Aktion bestätigt." if mutations == 1 else "Home Assistant hat die Aktionen bestätigt."


async def run_turn(client, prompt, text, tools, validate_args, dispatch, history=None, progress=None,
                   followup_timeout=FOLLOWUP_TIMEOUT, deadline=None) -> Outcome:
    """Sequential Assist roundtrip. Caller supplies HA validation and execution.

    Only caller-owned text history; no other agent's history. No action retries.
    After HA-confirmed results (also mutations) the model gets a further round with the native
    HA tool results, like HA's own agents: native answers (intent_script speech, broadcast,
    read results of the same batch) and multi-step requests. Guards: whole batch validated
    before any dispatch; progress.dispatched set before awaiting (caller never falls back after
    it); an unconfirmed/timeout result stops immediately without further model rounds; identical
    calls are never repeated; a failing follow-up round after confirmed actions ends with HA's
    deterministic confirmation instead of an error or a retry.
    """
    history = history or []
    if (len(history) > 12 or any(set(m) != {"role", "content"} or m["role"] not in {"user", "assistant"}
        or not isinstance(m["content"], str) or len(m["content"]) > 8192 for m in history)):
        raise AdapterError("invalid_local_history")
    progress = progress or TurnProgress()
    messages = [{"role": "system", "content": prompt}, *history, {"role": "user", "content": text}]
    start_index = len(messages)
    session = None
    attempted = set()
    mutations = 0
    speeches: list[str] = []

    async def close_vault():
        # After actions the native action vault is closed; never replayed to clean up.
        if mutations and session and hasattr(client, "discard"):
            try:
                async with asyncio.timeout(2):
                    await client.discard(session)
            except (AdapterError, TimeoutError):
                pass  # TTL will expire.

    async def finish_confirmed():
        final = _confirmation(mutations, speeches)
        messages.append({"role": "assistant", "content": final})
        await close_vault()
        return Outcome(final, messages, start_index=start_index)

    for _ in range(MAX_ROUNDS):
        if mutations:
            # Actions already ran and are confirmed: never let a provider fault turn into an
            # error/fallback; report HA's confirmation instead.
            budget = followup_timeout
            if deadline is not None:
                budget = min(budget, deadline - asyncio.get_running_loop().time())
            if budget < 1:
                return await finish_confirmed()
            try:
                async with asyncio.timeout(budget):
                    reply = await client.complete(messages, tools, session)
            except (AdapterError, TimeoutError):
                return await finish_confirmed()
        else:
            reply = await client.complete(messages, tools, session)
        progress.provider_completed = True
        calls = reply.message.get("tool_calls", [])
        if not calls:
            final = reply.message["content"]
            if mutations and not (isinstance(final, str) and final.strip()):
                return await finish_confirmed()
            messages.append({"role": "assistant", "content": final})
            await close_vault()
            return Outcome(final, messages, start_index=start_index)
        # No partial batch: schema-validate and duplicate-check all first.
        inputs = []
        try:
            for call in calls:
                func = call["function"]
                args = decode_json(func["arguments"])
                name = func["name"]
                fingerprint = (name, json.dumps(args, sort_keys=True, allow_nan=False))
                if fingerprint in attempted:
                    raise AdapterError("repeated_tool_call_blocked")
                attempted.add(fingerprint)
                inputs.append((call, name, validate_args(name, args)))
        except Exception:
            if mutations:
                return await finish_confirmed()  # nothing of this batch ran
            raise
        messages.append(reply.message)
        session = reply.session
        for call, name, args in inputs:
            try:
                # Set BEFORE awaiting: timeout/exception can mean the action ran.
                progress.dispatched = True
                result = await dispatch(call["id"], name, args)
                encoded = json_result(result)
                if len(encoded.encode()) > MAX_RESPONSE_BYTES:
                    raise ValueError("tool_result_too_large")
            except asyncio.CancelledError:
                raise
            except Exception:
                # A timeout can mean the service ran. Never retry or claim failure/success.
                result = {"error": "tool_result_unconfirmed"}
                encoded = json_result(result)
            messages.append({"role": "tool", "tool_call_id": call["id"],
                             "content": encoded})
            if not confirmed_result(name, result):
                text = "Home Assistant hat das Ergebnis nicht eindeutig bestätigt. Ich habe keine weiteren Aktionen versucht."
                if mutations:
                    # Keep already HA-confirmed partial successes (native speech) in the answer and
                    # thus in the local history, so a later turn knows what really happened.
                    done = _confirmation(mutations, speeches)[:1800].rstrip()
                    text = (done + ("" if done.endswith((".", "!", "?")) else ".") + " Die weitere Aktion hat Home Assistant"
                            " nicht eindeutig bestätigt. Ich habe nichts wiederholt und keine weiteren Aktionen versucht.")
                messages.append({"role": "assistant", "content": text})
                return Outcome(text, messages, failed=True, start_index=start_index)
            if is_mutating(name):
                mutations += 1
                speech = ha_speech(result)
                if speech:
                    speeches.append(speech)
    if mutations:
        return await finish_confirmed()
    raise AdapterError("tool_iteration_limit")
