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
# Exactly one further model round after a READ-ONLY lookup found nothing (e.g. name instead of
# area, renamed area). Needs at least this many seconds left of the turn deadline.
LOOKUP_RETRY_MIN_BUDGET = 5
MAX_LOOKUP_CANDIDATES = 5
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


intent_response = _intent_response

# HA 2026.10 core GetLiveContext tool (components/homeassistant/llm.py).
LIVE_CONTEXT_TOOLS = {"GetLiveContext", "homeassistant__GetLiveContext"}
# Marker set by conversation.normalize_tool_result for bare HA >= 2026.10 data without a verified
# success contract (custom/unknown tools): such a result is never an action confirmation.
UNCONFIRMED = "offtangent_unconfirmed"
# HA 2026.10.2 GetLiveContext no-match messages (components/homeassistant/llm.py _live_context_match_error).
_LIVE_CONTEXT_NOT_FOUND = ("No exposed entities matched name ", "No exposed entities found in ",
                           "No entities matched the provided filter", "Area '")


def not_found(name: str, result: Any) -> bool:
    """A READ-ONLY lookup that HA answered with "no such entity/area". Never true for actions."""
    if is_mutating(name) or not isinstance(result, dict):
        return False
    error = result.get("error")
    if error == "not_found":  # conversation.dispatch: intent.MatchFailedError of a read-only tool
        return True
    if name in LIVE_CONTEXT_TOOLS and isinstance(error, str):
        return error.startswith(_LIVE_CONTEXT_NOT_FOUND)
    return (_intent_response(result) and result["response_type"] == "error"
            and result["data"].get("code") == "no_valid_targets")


NOT_FOUND_DEVICE = "Dieses Gerät habe ich in Home Assistant nicht gefunden."
NOT_FOUND_NEUTRAL = "Dazu habe ich in Home Assistant nichts gefunden."


def not_found_text(result: Any) -> str:
    """Device wording only where HA's result proves a single named device; otherwise neutral."""
    error = result.get("error") if isinstance(result, dict) else None
    if (isinstance(result, dict) and result.get("target") == "device") or (
            isinstance(error, str) and error.startswith("No exposed entities matched name ")):
        return NOT_FOUND_DEVICE
    return NOT_FOUND_NEUTRAL


def _norm(text: Any) -> str:
    """Casefold, strip accents/umlaut marks (ä->a, ß->ss), "_"/"-" as space, collapse spaces."""
    import unicodedata
    text = unicodedata.normalize("NFKD", str(text).casefold().replace("ß", "ss"))
    text = "".join(c for c in text if not unicodedata.combining(c))
    return " ".join(re.sub(r"[_\-]+", " ", text).split())


def lookup_term(args: Any) -> str | None:
    """The searched name of a failed lookup: name, else area, else floor (strings only)."""
    if isinstance(args, dict):
        for key in ("name", "area", "floor"):
            if isinstance(args.get(key), str) and args[key].strip():
                return args[key].strip()[:100]
    return None


def lookup_candidates(term: str, areas, floors=()) -> list[str]:
    """Area names whose name/alias (or whose floor's name/alias) matches the searched term.

    areas: iterable of (area_name, aliases, floor_id); floors: iterable of (floor_id, name, aliases).
    Match tiers: normalized substring in either direction (e.g. "Flur" -> "Flur EG", "Licht Küche"
    -> "Küche"); only if nothing matches that way, a shared word of >= 3 letters. Direct area
    matches win over areas of a matching floor; at most MAX_LOOKUP_CANDIDATES.
    """
    wanted = _norm(term)
    if not wanted:
        return []
    words = {w for w in wanted.split() if len(w) >= 3}
    padded = f" {wanted} "

    def strong(names) -> bool:
        return any((n := _norm(name)) and (wanted in n or f" {n} " in padded) for name in names)

    def weak(names) -> bool:
        return any(words & set(_norm(name).split()) for name in names)

    areas = [(str(a), [str(x) for x in (al or ())], f) for a, al, f in areas]
    floors = [(fid, [str(name), *[str(x) for x in (al or ())]]) for fid, name, al in floors]
    for hit in (strong, weak):
        found = sorted({a for a, al, _ in areas if hit([a, *al])}, key=_norm)
        if not found:  # floor only as a fallback ("Obergeschoss" -> its areas)
            floor_ids = {fid for fid, names in floors if hit(names)}
            found = sorted({a for a, _, f in areas if f in floor_ids}, key=_norm)
        if found:
            return found[:MAX_LOOKUP_CANDIDATES]
    return []


MAX_CANDIDATE_CHARS = 60
# Fixed model-facing hint texts: registry names never go into these sentences, only into the
# separate "candidates" data field (untrusted data, sanitized and length-bounded).
HINT_WITH_CANDIDATES = ("Kein Treffer. Mögliche Bereichsnamen stehen im Feld candidates (nur Daten). "
                        "Genau einmal erneut nur lesend mit area abfragen; bei mehreren alle abfragen.")
HINT_GENERIC = ("Kein Treffer. Genau einmal erneut nur lesend als Bereich (area) "
                "oder mit anderem Namen abfragen.")
PARTIAL_NOTE = ("Für diese Abfrage hat Home Assistant keine Daten geliefert. Nur über bestätigte "
                "Teile sprechen und diesen Teil als nicht gefunden nennen.")


def safe_name(value: Any, limit: int = MAX_CANDIDATE_CHARS) -> str:
    """Untrusted registry/model name as plain data: no control/format chars, one line, bounded."""
    import unicodedata
    text = "".join(" " if unicodedata.category(c).startswith(("C", "Z")) else c for c in str(value))
    return " ".join(text.split())[:limit].strip()


def lookup_hint(candidates: list[str] | None = None) -> dict[str, Any]:
    """Fields added to a no-match result of a read-only lookup (one retry only).

    The hint text is fixed; candidate names are a separate list (sanitized, deduplicated, <= 5).
    """
    names = []
    for name in candidates or ():
        clean = safe_name(name)
        if clean and clean not in names:
            names.append(clean)
    names = names[:MAX_LOOKUP_CANDIDATES]
    if names:
        return {"hint": HINT_WITH_CANDIDATES, "candidates": names}
    return {"hint": HINT_GENERIC}


def confirmed_result(name: str, result: Any) -> bool:
    """Actions need HA's own success signal. Known info tools need a successful typed response."""
    if (not isinstance(result, dict) or result.get("error") or result.get("success") is False
            or result.get(UNCONFIRMED)):
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


THINK_BLOCK = re.compile(r"<think>.*?</think>", re.S | re.I)
THINK_TAG = re.compile(r"</?think>", re.I)


def clean_speech(text):
    """Spoken-answer hygiene (relay and local): no thinking blocks, no stray </think>, no
    repeated paragraphs. qwen3 with think=false sometimes returns "A\n</think>\n\nA"."""
    if not isinstance(text, str):
        return text
    out = THINK_BLOCK.sub("", text)
    if THINK_TAG.search(out):
        parts = [p.strip() for p in THINK_TAG.split(out)]
        parts = [p for p in parts if p]
        out = parts[-1] if parts else ""  # the part after the last tag is the spoken answer
    paragraphs, seen = [], set()
    for para in re.split(r"\n\s*\n", out):
        key = re.sub(r"\s+", " ", para).strip().casefold()
        if key and key not in seen:
            seen.add(key)
            paragraphs.append(para.strip())
    out = "\n\n".join(paragraphs)
    # Whole answer repeated inside one paragraph ("A. A.").
    half = len(out) // 2
    if len(out) >= 8 and len(out) % 2 == 1 and out[:half].strip() == out[half + 1:].strip() and out[half].isspace():
        out = out[:half].strip()
    return out.strip()


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


UNCONFIRMED_TEXT = "Home Assistant hat das Ergebnis nicht eindeutig bestätigt. Ich habe keine weiteren Aktionen versucht."
# Answer round after the lookup retry asked for further tools: nothing of that batch ran.
RETRY_STOP_TEXT = ("Nach der erneuten Suche habe ich keine weiteren Abfragen oder Aktionen ausgeführt. "
                   "Bitte stelle die Frage genauer.")


def partial_text(terms: list[str]) -> str:
    """Deterministic note on lookups of the retry block without HA data (never left to the model)."""
    names = []
    for term in terms:
        clean = safe_name(term)
        if clean and clean not in names:
            names.append(clean)
    if names and len(names) == len({safe_name(t) for t in terms}) and len(names) <= MAX_LOOKUP_CANDIDATES:
        return "Für " + ", ".join(f"'{n}'" for n in names) + " habe ich in Home Assistant nichts gefunden."
    return "Für einen Teil der Anfrage habe ich in Home Assistant nichts gefunden."


async def run_turn(client, prompt, text, tools, validate_args, dispatch, history=None, progress=None,
                   followup_timeout=FOLLOWUP_TIMEOUT, deadline=None, candidates_for=None, guard=None) -> Outcome:
    """Sequential Assist roundtrip. Caller supplies HA validation and execution.

    Only caller-owned text history; no other agent's history. No action retries.
    After HA-confirmed results (also mutations) the model gets a further round with the native
    HA tool results, like HA's own agents: native answers (intent_script speech, broadcast,
    read results of the same batch) and multi-step requests. Guards: whole batch validated
    before any dispatch; progress.dispatched set before awaiting (caller never falls back after
    it); an unconfirmed/timeout result stops immediately without further model rounds; identical
    calls are never repeated; a failing follow-up round after confirmed actions ends with HA's
    deterministic confirmation instead of an error or a retry.

    Deadline: deadline (loop time) is absolute for the turn. Bound by it: every read-only lookup
    dispatch, the retry call, the retry block and its answer call, and follow-ups after confirmed
    actions; the retry is only granted with >= LOOKUP_RETRY_MIN_BUDGET s left. Past it: a lookup
    dispatch counts as unconfirmed (as any dispatch timeout), a confirmed-action follow-up ends
    with HA's confirmation, the retry call ends with the fixed not-found text and the answer call
    raises TimeoutError to the caller (the previous turn-timeout behavior). The first model call
    and action dispatches keep the unchanged path (caller's 105 s turn guard).

    Lookup retry (fixed contract, at most two extra model calls per turn):
    1. A batch of ONLY read-only tools (no action so far in this turn) finds nothing (not_found)
       and >= LOOKUP_RETRY_MIN_BUDGET s are left: the no-match results go back to the model with
       a fixed hint text plus a separate "candidates" list (candidates_for(name, args, result) ->
       area names from HA's registries; untrusted data, sanitized).
    2. Exactly ONE retry model call (bounded by min(followup_timeout, deadline)). It must return
       one read-only lookup batch; otherwise (provider error/timeout, no tool, an action, a
       repeated or invalid call) the fixed not-found text, nothing of that batch runs.
    3. That batch runs. All no-match again -> fixed not-found text. A non not-found failure ->
       the unconfirmed text (no false "not found", no action claim). Data for all -> step 4.
       Data for only a part -> each lookup without data is marked (partial, without_data, note)
       for the model, and step 4's answer gets a deterministic partial_text() appended.
    4. Exactly ONE answer model call. Further tool calls there -> RETRY_STOP_TEXT, nothing runs.
    Batches containing an action and everything after a confirmed action keep the unchanged path.
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
    loop = asyncio.get_running_loop()

    def left():
        return None if deadline is None else deadline - loop.time()

    async def until_deadline(start):
        """Await start() under the absolute turn deadline; TimeoutError once it has passed."""
        if deadline is None:
            return await start()
        if left() <= 0:
            raise TimeoutError
        async with asyncio.timeout_at(deadline):
            return await start()

    async def close_vault():
        # After actions the native action vault is closed; never replayed to clean up.
        if mutations and session and hasattr(client, "discard"):
            budget = 2 if deadline is None else min(2, left())
            if budget <= 0:
                return  # TTL will expire.
            try:
                async with asyncio.timeout(budget):
                    await client.discard(session)
            except (AdapterError, TimeoutError):
                pass  # TTL will expire.

    retry = None  # None -> "pending" (the one retry call) -> "answer" (the one answer call)
    retry_text = None  # fixed not-found answer of the lookup that granted the retry
    partial_terms: list[str] = []  # lookups of the retry block without HA data
    found_data = False  # any HA-confirmed read result in this turn

    def fixed_outcome(text):
        messages.append({"role": "assistant", "content": text})
        return Outcome(text, messages, failed=True, start_index=start_index)

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
                budget = min(budget, left())
            if budget < 1:
                return await finish_confirmed()
            try:
                async with asyncio.timeout(budget):
                    reply = await client.complete(messages, tools, session)
            except (AdapterError, TimeoutError):
                return await finish_confirmed()
        elif retry == "pending":
            # The one lookup retry call; budget was checked (>= LOOKUP_RETRY_MIN_BUDGET) when granted.
            budget = followup_timeout
            if deadline is not None:
                budget = min(budget, left())
            try:
                async with asyncio.timeout(max(budget, 0)):
                    reply = await client.complete(messages, tools, session)
            except (AdapterError, TimeoutError):
                return fixed_outcome(retry_text)
        elif retry == "answer":
            # The one answer call after the retry block: absolute turn deadline (TimeoutError past it).
            reply = await until_deadline(lambda: client.complete(messages, tools, session))
        else:
            reply = await client.complete(messages, tools, session)  # unchanged (105 s turn guard)
        progress.provider_completed = True
        calls = reply.message.get("tool_calls", [])
        if not calls and retry == "pending":
            # No new lookup after the hint: never answer a state question without HA data.
            return fixed_outcome(retry_text)
        if calls and retry == "answer":
            # Retry contract: one lookup block + one answer call. Nothing of this batch runs.
            return fixed_outcome(RETRY_STOP_TEXT)
        if not calls:
            final = clean_speech(reply.message["content"])
            if mutations and not (isinstance(final, str) and final.strip()):
                return await finish_confirmed()
            if partial_terms and isinstance(final, str):
                # Never let a partial lookup read as a complete answer: name the gap deterministically.
                final = final.rstrip()
                final = (final + ("" if not final or final.endswith((".", "!", "?")) else ".") + " "
                         + partial_text(partial_terms)).strip()
            if not (isinstance(final, str) and final.strip()):
                raise AdapterError("empty_answer")  # e.g. only a thinking block: never spoken empty
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
        except Exception as err:
            if mutations:
                return await finish_confirmed()  # nothing of this batch ran
            if retry == "pending":
                return fixed_outcome(retry_text)  # e.g. same lookup repeated; nothing ran
            if guard is not None and guard.feedback_used and str(err) == "repeated_tool_call_blocked":
                # Same blocked batch again after the guard's feedback: ask, never act.
                guard.events.append({"guard_blocked": "clarify", "reason": "repeated_after_feedback"})
                return fixed_outcome("Ich bin nicht sicher, welche Geräte gemeint sind, und habe nichts geschaltet. "
                                     "Sag mir bitte die Räume einzeln.")
            if guard is not None and not guard.arg_feedback_used and retry is None:
                # Local path: invalid arguments go back to the model exactly once (nothing ran);
                # a second invalid batch raises and the relay takes over.
                guard.arg_feedback_used = True
                guard.events.append({"guard_blocked": "invalid_args", "reason": str(err)[:200] or type(err).__name__,
                                     "calls": [[c["function"]["name"], c["function"]["arguments"][:300]] for c in calls][:10]})
                messages.append(reply.message)
                note = guard_arg_text(err)
                for call in calls:
                    messages.append({"role": "tool", "tool_call_id": call["id"],
                                     "content": json_result({"error": "invalid_arguments", "error_text": note})})
                continue
            raise
        in_retry = retry == "pending"
        if in_retry and any(is_mutating(name) for _, name, _ in inputs):
            # The retry block is read-only by contract: an action is never dispatched here.
            return fixed_outcome(retry_text)
        if guard is not None and any(is_mutating(name) for _, name, _ in inputs):
            decision = guard.check([(name, args) for _, name, args in inputs], is_mutating)
            if decision is not None:
                if decision.action == "feedback":
                    # Nothing of this batch ran; the model gets one chance to correct the targets.
                    messages.append(reply.message)
                    for call, _, _ in inputs:
                        messages.append({"role": "tool", "tool_call_id": call["id"],
                                         "content": json_result({"error": "guard_blocked", "error_text": decision.text})})
                    continue
                if decision.action == "confirm":
                    guard.pending = [(name, args) for _, name, args in inputs]
                text = decision.text
                if mutations:
                    text = _confirmation(mutations, speeches) + " Weitere Aktionen habe ich nicht ausgeführt."
                    if decision.action == "confirm":
                        guard.pending = None  # a half-done multi-step turn is never resumed by "ja"
                messages.append({"role": "assistant", "content": text})
                await close_vault()
                return Outcome(text, messages, failed=not mutations, start_index=start_index)
        messages.append(reply.message)
        session = reply.session
        if not mutations and not any(is_mutating(name) for _, name, _ in inputs):
            # Read-only batch: run all lookups (no side effects), then decide once for the batch.
            missing = []
            for call, name, args in inputs:
                try:
                    progress.dispatched = True
                    result = await until_deadline(lambda: dispatch(call["id"], name, args))
                    encoded = json_result(result)
                    if len(encoded.encode()) > MAX_RESPONSE_BYTES:
                        raise ValueError("tool_result_too_large")
                except asyncio.CancelledError:
                    raise
                except Exception:
                    result = {"error": "tool_result_unconfirmed"}
                    encoded = json_result(result)
                messages.append({"role": "tool", "tool_call_id": call["id"], "content": encoded})
                if confirmed_result(name, result):
                    found_data = True
                elif not_found(name, result):
                    missing.append((len(messages) - 1, name, args, result))
                else:
                    # Also inside the retry block: a read error is reported as such, never as
                    # "not found" and never as an action.
                    return fixed_outcome(UNCONFIRMED_TEXT)
            if in_retry:
                retry = "answer"
                if missing and not found_data:
                    return fixed_outcome(not_found_text(missing[-1][3]))
                for index, name, args, result in missing:
                    # Partial data: mark every lookup without data for the model (data, no names
                    # in sentences) and keep its term for the deterministic note in the answer.
                    term = safe_name(lookup_term(args) or "")
                    partial_terms.append(term)
                    messages[index]["content"] = json_result(
                        {**(result if isinstance(result, dict) else {"error": "not_found"}),
                         "partial": True, "without_data": term or None, "note": PARTIAL_NOTE})
                continue
            if not missing:
                continue
            text = not_found_text(missing[-1][3])
            remaining = left()
            if retry is not None or (remaining is not None and remaining < LOOKUP_RETRY_MIN_BUDGET):
                return fixed_outcome(text)
            retry, retry_text = "pending", text
            for index, name, args, result in missing:
                try:
                    names = list(candidates_for(name, args, result) or []) if candidates_for else []
                except Exception:
                    names = []  # no registry data: generic hint only
                messages[index]["content"] = json_result({**(result if isinstance(result, dict) else {"error": "not_found"}), **lookup_hint(names)})
            continue
        for call, name, args in inputs:
            try:
                # Set BEFORE awaiting: timeout/exception can mean the action ran.
                progress.dispatched = True
                result = await dispatch(call["id"], name, args)  # action path unchanged (105 s guard)
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
                text = UNCONFIRMED_TEXT
                if not mutations and not_found(name, result):
                    # Only a read-only lookup without any earlier action: nothing to confirm.
                    text = not_found_text(result)
                if mutations:
                    # Keep already HA-confirmed partial successes (native speech) in the answer and
                    # thus in the local history, so a later turn knows what really happened.
                    done = _confirmation(mutations, speeches)[:1800].rstrip()
                    text = (done + ("" if done.endswith((".", "!", "?")) else ".") + (" Die weitere Aktion hat Home Assistant"
                            if is_mutating(name) else " Die anschließende Abfrage hat Home Assistant")
                            + " nicht eindeutig bestätigt. Ich habe nichts wiederholt und keine weiteren Aktionen versucht.")
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


def guard_arg_text(err) -> str:
    detail = re.sub(r"[^\w .,:'()\[\]-]", "", str(err))[:160]
    return ("Nicht ausgeführt: ungültige Werkzeug-Argumente" + (f" ({detail})" if detail else "")
            + ". Nichts wurde geschaltet. Rufe das Werkzeug mit gültigen Argumenten laut Schema erneut auf, "
            "Namen und Bereiche als einfache Zeichenkette.")


async def run_confirmed(batch, validate_args, dispatch, progress=None) -> Outcome:
    """Run a batch the user explicitly confirmed ("ja"); no model round, same HA validation."""
    progress = progress or TurnProgress()
    calls, inputs = [], []
    for name, args in batch:
        call_id = "call_" + __import__("uuid").uuid4().hex[:16]
        inputs.append((call_id, name, validate_args(name, args)))
        calls.append({"id": call_id, "type": "function",
                      "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)}})
    messages = [{"role": "assistant", "content": None, "tool_calls": calls}]
    mutations, speeches = 0, []
    for call_id, name, args in inputs:
        try:
            progress.dispatched = True
            result = await dispatch(call_id, name, args)
            encoded = json_result(result)
        except asyncio.CancelledError:
            raise
        except Exception:
            result = {"error": "tool_result_unconfirmed"}
            encoded = json_result(result)
        messages.append({"role": "tool", "tool_call_id": call_id, "content": encoded})
        if not confirmed_result(name, result):
            text = (_confirmation(mutations, speeches) + " " if mutations else "") + UNCONFIRMED_TEXT
            messages.append({"role": "assistant", "content": text})
            return Outcome(text, messages, failed=True, start_index=0)
        mutations += 1
        speech = ha_speech(result)
        if speech:
            speeches.append(speech)
    text = _confirmation(mutations, speeches)
    messages.append({"role": "assistant", "content": text})
    return Outcome(text, messages, start_index=0)
