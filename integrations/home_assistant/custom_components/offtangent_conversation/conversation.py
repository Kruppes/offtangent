"""HA 2026.9 ChatLog agent; executes only selected Assist tools, never services directly."""
import asyncio
import json
import logging
import time
from collections.abc import Mapping
from dataclasses import replace
from uuid import uuid4
from datetime import UTC, datetime, timedelta

from probatio import to_openapi
import voluptuous as vol
from homeassistant.components import conversation, persistent_notification
from homeassistant.core import HomeAssistantError
from homeassistant.helpers import intent, llm
from homeassistant.helpers.event import async_track_time_interval

from . import client
from .client import AdapterError, TurnProgress, decode_json, run_turn, select_tools
from .const import DEFAULT_PROMPT, DOMAIN, WARM_INTERVAL_S
from .fallback import local_fallback_entry
from .guard import CONFIRM_TTL_S, Guard, is_confirmation
from .guard_ha import build_world, make_resolver, make_weather
from .ollama import MeteredTurn, compact_prompt, compact_tools, stable_prompt
from .turnlog import PipelineScanner, log_async, summarize_ollama, tool_trace

_LOGGER = logging.getLogger(__name__)


# Placed into a tool result by this component only; client.confirmed_result never confirms it.
INVALID_TOOL_RESULT = "invalid_tool_result"
NOT_FOUND = "not_found"


def _negative(value):
    """Explicit failure indicators inside tool data (checked before any positive mapping)."""
    return isinstance(value, Mapping) and (bool(value.get("error")) or value.get("success") is False)


def _verified_envelope(name, data):
    """Legacy {"success": True, "result": ...} ONLY for HA 2026.10.2 contracts verified in core source.

    GetLiveContext (components/homeassistant/llm.py): {"result": str}; errors use error=True.
    llm__GetDateTime (components/llm/llm.py): {"date", "time", "timezone", "weekday"}.
    todo__get_items / calendar__get_events: {"items": [...]} / {"events": [...]}; errors use error=True.
    script__* (helpers/llm.py ActionTool, domain "script"): {"result": response} returned only after
    hass.services.async_call(..., blocking=True) finished without exception -> same contract as 2026.9.
    Everything else (custom tools, unknown or new core tools) gets no synthetic success.
    """
    keys = set(data)
    if name in client.LIVE_CONTEXT_TOOLS and keys == {"result"} and isinstance(data["result"], str):
        return {"success": True, "result": data["result"]}
    if name == "llm__GetDateTime" and keys == {"date", "time", "timezone", "weekday"}:
        return {"success": True, "result": data}
    if name == "todo__get_items" and keys == {"items"} and isinstance(data["items"], list):
        return {"success": True, "result": data["items"]}
    if name == "calendar__get_events" and keys == {"events"} and isinstance(data["events"], list):
        return {"success": True, "result": data["events"]}
    if name.startswith("script__") and keys == {"result"} and not _negative(data["result"]):
        return {"success": True, "result": data["result"]}
    return None


def normalize_tool_result(name, result):
    """Map an Assist tool result onto the legacy dict shape judged by client.confirmed_result.

    HA <= 2026.9 returns the dict itself (passed through unchanged). HA >= 2026.10 returns
    llm.ToolResult(data, error): error=True is a lock nothing in data can override; bare data
    is only turned into a confirmation for verified core contracts (_verified_envelope).
    """
    if not hasattr(result, "data") or isinstance(result, Mapping):
        return result if isinstance(result, dict) else {"error": INVALID_TOOL_RESULT}
    data = result.data
    failed = bool(getattr(result, "error", False))
    if not isinstance(data, Mapping):
        return {"error": INVALID_TOOL_RESULT}
    data = dict(data)
    if failed:
        data["error"] = data.get("error") or True
        if "success" in data:
            data["success"] = False
        return data
    if "success" in data or client.intent_response(data) or _negative(data):
        return data  # explicit typed result or explicit failure: client.confirmed_result decides
    envelope = _verified_envelope(name, data)
    if envelope is not None:
        return envelope
    return {"result": data, client.UNCONFIRMED: True}


def tool_result_content_kwargs(payload, failed=False):
    """HA >= 2026.10: ToolResultContent(result=llm.ToolResult); older cores: tool_result=dict.

    failed is HA's own ToolResult.error of this call; it can only add, never remove an error mark.
    """
    if not isinstance(payload, Mapping):
        payload, failed = {"error": INVALID_TOOL_RESULT}, True
    if "result" in getattr(conversation.ToolResultContent, "__dataclass_fields__", {}):
        failed = bool(failed or payload.get("error") or payload.get("success") is False)
        return {"result": llm.ToolResult(data=dict(payload), error=failed)}
    return {"tool_result": payload}


def _exposed_area_ids(hass) -> set[str]:
    """Area ids holding at least one entity exposed to Assist (entity area, else device area).

    Same exposure/area resolution as HA's GetLiveContext. Fail-closed: if the exposure data is
    missing or its API changed, the result is EMPTY (no area is ever offered as a candidate).
    """
    try:
        from homeassistant.components.homeassistant import exposed_entities
        from homeassistant.helpers import device_registry as dr, entity_registry as er
        ent_reg, dev_reg = er.async_get(hass), dr.async_get(hass)
        ids = set()
        for state in hass.states.async_all():
            if exposed_entities.async_should_expose(hass, conversation.DOMAIN, state.entity_id) is not True:
                continue
            entry = ent_reg.async_get(state.entity_id)
            if entry is None:
                continue
            area_id = entry.area_id
            if area_id is None and entry.device_id and (device := dev_reg.async_get(entry.device_id)):
                effective = getattr(dr, "async_get_effective_area_id", None)
                area_id = effective(hass, device) if effective else device.area_id
            if isinstance(area_id, str) and area_id:
                ids.add(area_id)
        return ids
    except Exception:  # noqa: BLE001 - exposure store missing/changed: fail closed, no candidates
        return set()


def lookup_candidates_for(hass, name, args, result) -> list[str]:
    """Area-name candidates for a read-only no-match, only areas with an entity exposed to Assist.

    Data only (the fixed hint text is built in client.lookup_hint); empty on any registry error.
    """
    term = client.lookup_term(args)
    if not term:
        return []
    try:
        from homeassistant.helpers import area_registry as ar, floor_registry as fr
        exposed = _exposed_area_ids(hass)
        if not exposed:
            return []
        areas = [(a.name, a.aliases, a.floor_id) for a in ar.async_get(hass).async_list_areas()
                 if a.id in exposed]
        floors = [(f.floor_id, f.name, f.aliases) for f in fr.async_get(hass).async_list_floors()]
        return client.lookup_candidates(term, areas, floors)
    except Exception:  # noqa: BLE001 - registries unavailable: generic hint only
        return []


def lookup_hint_for(hass, name, args, result) -> dict:
    """Model-facing hint fields (fixed text + separate candidates data) for a read-only no-match."""
    return client.lookup_hint(lookup_candidates_for(hass, name, args, result))


def _error_result(user_input, conversation_id, text):
    response = intent.IntentResponse(language=user_input.language)
    response.async_set_error(intent.IntentResponseErrorCode.FAILED_TO_HANDLE, text)
    return conversation.ConversationResult(response=response, conversation_id=conversation_id)


async def async_setup_entry(hass, entry, async_add_entities):
    async_add_entities([OfftangentConversationEntity(entry)])


class OfftangentConversationEntity(conversation.ConversationEntity, conversation.AbstractConversationAgent):
    _attr_has_entity_name = True
    _attr_name = "Offtangent Conversation"
    _attr_supports_streaming = False

    def __init__(self, entry):
        self.entry = entry
        self._settings = {**entry.data, **entry.options}
        self._client = entry.runtime_data
        # Variant B: native Ollama primary path; the relay (Haiku) takes over before any dispatch.
        self._local = getattr(entry.runtime_data, "local", None)
        self._turn_log_dir = getattr(entry.runtime_data, "turn_log_dir", None)
        self._turn = None
        self._turn_path = None
        self._local_failures = 0
        self._lock = asyncio.Lock()
        self._history = {}
        self._fallback_ids = {}
        self._pending = {}  # history key -> (monotonic, batch) awaiting the user's "ja" (local guard)
        self._key = None
        self._warm_payload = None  # (prompt, tools) of the last local turn for the keep-warm ping
        self._warm_task = None  # running keep-warm request; a starting turn cancels it
        self._warm_preempted_tasks = set()  # pings cancelled by a turn (per task, never a shared flag)
        self._degradation_count = 0
        self._last_path = "relay"
        self._auth_state = "unknown"
        self._auth_status_last_success_at = None
        self._auth_status_last_error_at = None
        self._warning_active = False
        self._state_ready = False
        self._attr_unique_id = entry.entry_id
        if self._settings.get("control"):
            self._attr_supported_features = conversation.ConversationEntityFeature.CONTROL

    @property
    def supported_languages(self):
        return ["de", "de-DE"]

    async def async_will_remove_from_hass(self):
        conversation.async_unset_agent(self.hass, self.entry)
        await super().async_will_remove_from_hass()

    @property
    def extra_state_attributes(self):
        return {"provider_auth_state": self._auth_state, "last_path": self._last_path,
                "degradation_count": self._degradation_count,
                "relogin_required": self._auth_state == "relogin_required",
                "auth_status_last_success_at": self._auth_status_last_success_at,
                "auth_status_last_error_at": self._auth_status_last_error_at,
                "fallback_agent": self._settings.get("fallback_agent") or None,
                "primary_path": "ollama" if self._local is not None else "relay",
                "local_failures": self._local_failures}

    async def async_added_to_hass(self):
        await super().async_added_to_hass()
        conversation.async_set_agent(self.hass, self.entry, self)
        self._state_ready = True
        self.async_on_remove(async_track_time_interval(self.hass, self._poll_auth, timedelta(minutes=1)))
        if self._turn_log_dir:
            # Pipeline-level record per voice turn (STT text, stage latencies, local intent path).
            scanner = PipelineScanner(self.hass, self._turn_log_dir)
            scanner.prime()
            self.async_on_remove(async_track_time_interval(self.hass, scanner.scan, timedelta(seconds=5)))
        if self._local is not None:
            self.async_on_remove(async_track_time_interval(self.hass, self._keep_warm, timedelta(seconds=WARM_INTERVAL_S)))
        await self._poll_auth()

    async def _keep_warm(self, _now=None):
        """Every WARM_INTERVAL_S: refresh the Ollama prompt cache with the last local prompt start.

        Skipped while a turn runs, while a ping is still running, or before the first local turn
        (nothing to warm yet). A user turn never waits for the ping: _async_handle_message cancels
        a running ping first (the ping may take up to warm_timeout, the turn only local_timeout).
        Failures are only counted in the turn log; they never change the primary path.
        """
        if self._local is None or self._warm_payload is None or self._lock.locked() or self._warm_task is not None:
            return
        task = asyncio.ensure_future(self._local.warm(*self._warm_payload))
        self._warm_task = task
        try:
            timing = await task
            entry = {"kind": "warm", "ts": datetime.now(UTC).isoformat(), "model": self._local.model, **timing}
        except AdapterError as err:
            # Expected while Ollama is busy, cold or down; the next turn falls back on its own.
            _LOGGER.debug("Keep-warm ping to Ollama failed (%s); primary path unchanged", err)
            entry = {"kind": "warm", "ts": datetime.now(UTC).isoformat(), "error": str(err)}
        except asyncio.CancelledError:
            current = asyncio.current_task()
            if task not in self._warm_preempted_tasks or (current is not None and current.cancelling()):
                raise  # shutdown / outer cancel (also right after a preemption): always propagate
            _LOGGER.debug("Keep-warm ping cancelled: a user turn started")
            entry = {"kind": "warm", "ts": datetime.now(UTC).isoformat(), "error": "preempted_by_turn"}
        finally:
            if self._warm_task is task:
                self._warm_task = None
            self._warm_preempted_tasks.discard(task)
        if self._turn_log_dir:
            await log_async(self.hass, self._turn_log_dir, entry)

    def _preempt_warm(self):
        """Cancel a running keep-warm request so the user turn gets Ollama without waiting for it."""
        task = self._warm_task
        if task is not None and not task.done():
            self._warm_preempted_tasks.add(task)  # marks only this ping as preempted
            task.cancel()

    async def _poll_auth(self, _now=None):
        if not hasattr(self._client, "auth_status"):
            return
        try:
            status = await self._client.auth_status()
            state = status["auth"]["state"]
            if state not in {"unknown", "ready", "access_expired", "access_rejected", "refresh_unavailable", "relogin_required", "provider_unavailable"}:
                raise AdapterError("invalid_auth_status")
            self._auth_state = state
            self._auth_status_last_success_at = datetime.now(UTC).isoformat()
            self._warn_login()
            self._publish_state()
        except (AdapterError, KeyError, TypeError):
            # Never present a cached ready observation as fresh during an outage.
            # Keep any existing login notification until verified inference repairs it.
            self._auth_state = "relay_unavailable"
            self._auth_status_last_error_at = datetime.now(UTC).isoformat()
            self._publish_state()

    def _publish_state(self):
        if self._state_ready:
            self.async_write_ha_state()

    def _warn_login(self):
        notification_id = DOMAIN + "_auth_" + self.entry.entry_id
        if self._auth_state == "relogin_required" and not self._warning_active:
            persistent_notification.async_create(self.hass,
                "Die zentrale Offtangent-Anmeldung muss erneuert werden. Bitte in Offtangent neu anmelden. "
                "Bis dahin wird nur vor Werkzeugausführung der konfigurierte lokale Agent genutzt.",
                title="Offtangent: erneute Anmeldung erforderlich", notification_id=notification_id)
            self._warning_active = True
        elif self._auth_state == "ready" and self._warning_active:
            persistent_notification.async_dismiss(self.hass, notification_id)
            self._warning_active = False

    def _history_key(self, user_input, chat_log):
        now = time.monotonic()
        for key, (stamp, _) in list(self._history.items()):
            if now - stamp > 1800:
                self._history.pop(key, None)
                self._fallback_ids.pop(key, None)
        key = (chat_log.conversation_id, user_input.device_id, user_input.satellite_id)
        if key not in self._history and len(self._history) >= 64:
            oldest = min(self._history, key=lambda k: self._history[k][0])
            self._history.pop(oldest)
            self._fallback_ids.pop(oldest, None)
        # Include fallback-only sessions in the same TTL/size-bounded ownership ledger.
        self._history[key] = (now, self._history.get(key, (now, []))[1])
        return key

    async def _fallback(self, user_input, chat_log, key):
        target = self._settings.get("fallback_agent")
        # Only explicitly selected existing Ollama entities; never default/remote/self.
        try:
            local_fallback_entry(self.hass, target, control=self._settings.get("control", False))
        except ValueError:
            return _error_result(user_input, chat_log.conversation_id,
                "Der Relay ist nicht verfügbar; ein lokaler Ersatzagent ist nicht gültig konfiguriert. Es wurde keine Aktion versucht.")
        if target == self.entity_id:
            return _error_result(user_input, chat_log.conversation_id, "Ein rekursiver Ersatzagent ist nicht erlaubt.")
        agent = conversation.async_get_agent(self.hass, target)
        if agent is None:
            return _error_result(user_input, chat_log.conversation_id, "Der lokale Ersatzagent ist nicht verfügbar. Es wurde keine Aktion versucht.")
        self._degradation_count += 1
        self._last_path = "local_fallback"
        self._publish_state()
        fallback_id = self._fallback_ids.setdefault(key, uuid4().hex)
        # Own fallback session only; no supplied foreign chat id/pipeline prompt.
        result = await agent.async_process(replace(user_input, agent_id=target,
            conversation_id=fallback_id, extra_system_prompt=None))
        self._fallback_ids[key] = result.conversation_id or fallback_id
        result.conversation_id = chat_log.conversation_id
        speech = result.response.speech.get("plain", {}).get("speech", "")
        if speech:
            spoken = "Lokaler Ersatzassistent. " + speech
            result.response.async_set_speech(spoken)
            recent = self._history.get(key, (0, []))[1]
            # Own delegated answer only, never the local agent's other histories or prompt.
            self._history[key] = (time.monotonic(), (recent + [
                {"role": "user", "content": user_input.text[:8192]},
                {"role": "assistant", "content": spoken[:8192]},
            ])[-12:])
        self._publish_state()
        return result

    async def _async_handle_message(self, user_input, chat_log):
        if self._lock.locked():
            return _error_result(user_input, chat_log.conversation_id, "Der Assistent ist noch beschäftigt. Es wurde keine weitere Aktion versucht.")
        async with self._lock:
            self._preempt_warm()
            progress = TurnProgress()
            key = self._history_key(user_input, chat_log)
            self._key = key
            self._turn = record = {"kind": "agent", "ts": datetime.now(UTC).isoformat(),  # UTC like the pipeline records
                                   "conversation_id": chat_log.conversation_id, "device_id": user_input.device_id,
                                   "satellite_id": user_input.satellite_id, "text": user_input.text,
                                   "path": None, "local_error": None}
            started = time.monotonic()
            result = None
            try:
                result = await self._handle_locked(user_input, chat_log, key, progress)
                return result
            finally:
                record["path"] = record["path"] or self._last_path
                record["total_s"] = round(time.monotonic() - started, 3)
                if result is not None:
                    response = result.response
                    record["response_type"] = getattr(getattr(response, "response_type", None), "value", None)
                    record["answer"] = response.speech.get("plain", {}).get("speech")
                self._turn = None
                if self._turn_log_dir:
                    self.hass.async_create_task(log_async(self.hass, self._turn_log_dir, record))

    async def _handle_locked(self, user_input, chat_log, key, progress):
            self._turn_path = None
            try:
                async with asyncio.timeout(105):
                    result = await self._async_run(user_input, chat_log, key, progress)
                if self._turn_path == "ollama":
                    self._last_path = "ollama"
                elif progress.provider_completed:
                    self._auth_state = "ready"
                    self._last_path = "relay"
                else:
                    self._last_path = "ha_context_unavailable"
                self._warn_login()
                self._publish_state()
                return result
            except (AdapterError, TimeoutError) as err:
                code = str(err)
                if self._turn_path == "ollama_dispatched":
                    self._last_path = "ollama_failed_after_tool"
                else:
                    self._last_path = "relay_failed_after_tool" if progress.dispatched else "relay_unavailable"
                self._auth_state = {"provider_relogin_required": "relogin_required",
                    "provider_refresh_unavailable": "refresh_unavailable",
                    "provider_access_rejected": "access_rejected"}.get(code, self._auth_state)
                self._warn_login()
                self._publish_state()
                if not progress.dispatched:
                    # Exactly one local attempt. Never catches/retries a fallback tool failure.
                    try:
                        async with asyncio.timeout(60):
                            return await self._fallback(user_input, chat_log, key)
                    except (HomeAssistantError, TimeoutError, ValueError, TypeError):
                        self._last_path = "local_fallback_failed"
                        self._publish_state()
                return _error_result(user_input, chat_log.conversation_id,
                    "Der Assistent ist derzeit nicht verfügbar. Ein Aktionserfolg ist nicht bestätigt; ich habe keine weiteren Aktionen versucht.")

    async def _run_local(self, prompt, text, tools, validate_args, dispatch, progress, common):
        """Ollama primary path through the same run_turn. None = not dispatched, use the relay."""
        metered = MeteredTurn(self._local)
        stable, time_line = stable_prompt(prompt)  # per-second clock must not break the prompt cache
        # Local only: one line per device, short tool descriptions (same tools, same order).
        stable, tools = compact_prompt(stable), compact_tools(tools)
        self._warm_payload = (stable, tools)
        local_text = text + ("\n\n(" + time_line + ")" if time_line else "")
        record = self._turn if self._turn is not None else {}
        pending = self._pending.pop(self._key, None)
        if pending is not None and time.monotonic() - pending[0] <= CONFIRM_TTL_S and is_confirmation(text):
            # The user confirmed the batch the guard held back: run exactly that, no model round.
            record["guard"] = [{"guard_confirmed": True, "calls": [[n, a] for n, a in pending[1]][:10]}]
            self._turn_path = "ollama_confirmed"
            return await client.run_confirmed(pending[1], validate_args, dispatch, progress)
        try:
            guard = Guard(text, build_world(self.hass), make_resolver(self.hass), make_weather(self.hass))
        except Exception:  # noqa: BLE001 - registries unavailable: guard without world blocks every action
            guard = Guard(text, None, None)
        try:
            outcome = await run_turn(metered, stable, local_text, tools, validate_args, dispatch,
                                     guard=guard, **common)
        except (AdapterError, TimeoutError, vol.Invalid, ValueError, TypeError) as err:
            record["local_error"] = str(err) or type(err).__name__
            if progress.dispatched:
                self._turn_path = "ollama_dispatched"
                raise  # a tool already ran: never repeat the turn on the relay
            self._local_failures += 1
            _LOGGER.warning("Ollama primary path failed before any tool ran (%s); relay takes over",
                            record["local_error"])
            progress.provider_completed = False
            return None
        finally:
            record["ollama"] = summarize_ollama(metered.calls)
            record["model"] = self._local.model
            if guard.events:
                record["guard"] = guard.events
        if guard.pending:
            self._pending[self._key] = (time.monotonic(), guard.pending)
        self._turn_path = "ollama"
        self._local_failures = 0
        return outcome

    async def _async_run(self, user_input, chat_log, key, progress):
        try:
            # A reused chat ID must not import another agent/pipeline extra prompt.
            chat_log.extra_system_prompt = None
            await chat_log.async_provide_llm_data(
                user_input.as_llm_context(DOMAIN),
                llm.LLM_API_ASSIST if self._settings.get("control") else None,
                DEFAULT_PROMPT, None,  # Do not import other pipeline/agent prompts.
            )
            api = chat_log.llm_api
            allowed = set(json.loads(self._settings["allowed_tools"]))
            selected, unsendable = select_tools(api.tools if api else [], allowed)
            if unsendable:
                # Counted and logged, never silently lost (see diagnostics "unsendable_tools").
                _LOGGER.warning("%d Assist tool(s) have names the provider cannot carry: %s",
                                len(unsendable), ", ".join(sorted(unsendable))[:512])
            tools = [{"type": "function", "function": {
                "name": tool.name, "description": tool.description or "Home Assistant Assist tool",
                "parameters": to_openapi(tool.parameters, custom_serializer=api.custom_serializer),
            }} for tool in selected.values()]
            prompt = chat_log.content[0].content

            def validate_args(name, args):
                # Validate entire batch before execution; reject unknown tools and invalid slots.
                if name not in selected:
                    raise AdapterError("unsupported_tool")
                return selected[name].parameters(args)

            async def dispatch(call_id, name, args):
                if api is None or name not in selected:
                    raise AdapterError("unsupported_tool")
                try:
                    result = await api.async_call_tool(llm.ToolInput(
                        id=call_id, tool_name=name, tool_args=args,
                    ))
                except intent.MatchFailedError as err:
                    if client.is_mutating(name):
                        raise  # actions stay "not confirmed"; never reinterpreted
                    missing = {"error": NOT_FOUND}  # read-only lookup matched nothing
                    c = getattr(err, "constraints", None)
                    # Single device only when HA matched by name alone; area/floor/domain/etc. stays neutral.
                    if getattr(c, "name", None) and not any(
                            getattr(c, f, None) for f in ("area_name", "floor_name", "domains", "device_classes")):
                        missing["target"] = "device"
                    return missing
                ha_errors[call_id] = bool(getattr(result, "error", False))
                return normalize_tool_result(name, result)

            ha_errors = {}  # call_id -> HA's own ToolResult.error (2026.10), kept apart from the payload
            history = self._history.get(key, (0, []))[1]
            # Stay inside the 105 s turn guard of _async_handle_message.
            deadline = asyncio.get_running_loop().time() + 100
            common = {"history": history, "progress": progress, "deadline": deadline,
                      "candidates_for": lambda name, args, result: lookup_candidates_for(
                          self.hass, name, args, result)}
            outcome = None
            if self._local is not None:
                outcome = await self._run_local(prompt, user_input.text, tools, validate_args, dispatch,
                                                progress, common)
            if outcome is None:
                outcome = await run_turn(self._client, prompt, user_input.text, tools, validate_args, dispatch,
                                         **common)
            if self._turn is not None:
                self._turn["tools"] = tool_trace(outcome.messages[outcome.start_index:])
                self._turn["prompt_chars"] = len(prompt)
                self._turn["tool_count"] = len(tools)
            self._history[key] = (time.monotonic(), (history + [
                {"role": "user", "content": user_input.text[:8192]},
                {"role": "assistant", "content": outcome.text[:8192]},
            ])[-12:])
            # Tool calls are already executed here. External=True prevents ChatLog re-execution.
            tool_names = {}
            for message in outcome.messages[outcome.start_index:]:
                if message["role"] == "assistant":
                    calls = []
                    for call in message.get("tool_calls", []):
                        func = call["function"]
                        tool_names[call["id"]] = func["name"]
                        calls.append(llm.ToolInput(id=call["id"], tool_name=func["name"],
                                                   tool_args=decode_json(func["arguments"]), external=True))
                    chat_log.async_add_assistant_content_without_tools(conversation.AssistantContent(
                        agent_id=self.entity_id, content=None if calls else message.get("content"), tool_calls=calls or None,
                    ))
                else:
                    chat_log.async_add_assistant_content_without_tools(conversation.ToolResultContent(
                        agent_id=self.entity_id, tool_call_id=message["tool_call_id"],
                        tool_name=tool_names[message["tool_call_id"]],
                        **tool_result_content_kwargs(decode_json(message["content"]),
                                                     ha_errors.get(message["tool_call_id"], False)),
                    ))
            return conversation.async_get_result_from_chat_log(user_input, chat_log)
        except conversation.ConverseError as err:
            return err.as_conversation_result()
        except (HomeAssistantError, vol.Invalid, ValueError, TypeError):
            # Do not expose upstream bodies, tokens, hostnames, thinking or tool arguments.
            return _error_result(user_input, chat_log.conversation_id,
                                 "Der Assistent ist derzeit nicht verfügbar. Ein Aktionserfolg ist nicht bestätigt.")
