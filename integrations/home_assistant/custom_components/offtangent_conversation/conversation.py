"""HA 2026.9 ChatLog agent; executes only selected Assist tools, never services directly."""
import asyncio
import json
import time
from dataclasses import replace
from uuid import uuid4
from datetime import UTC, datetime, timedelta

from probatio import to_openapi
import voluptuous as vol
from homeassistant.components import conversation, persistent_notification
from homeassistant.core import HomeAssistantError
from homeassistant.helpers import intent, llm
from homeassistant.helpers.event import async_track_time_interval

from .client import AdapterError, TOOL_NAME, TurnProgress, decode_json, run_turn
from .const import DEFAULT_PROMPT, DOMAIN
from .fallback import local_fallback_entry


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
        self._lock = asyncio.Lock()
        self._history = {}
        self._fallback_ids = {}
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
                "fallback_agent": self._settings.get("fallback_agent") or None}

    async def async_added_to_hass(self):
        await super().async_added_to_hass()
        conversation.async_set_agent(self.hass, self.entry, self)
        self._state_ready = True
        self.async_on_remove(async_track_time_interval(self.hass, self._poll_auth, timedelta(minutes=1)))
        await self._poll_auth()

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
            progress = TurnProgress()
            key = self._history_key(user_input, chat_log)
            try:
                async with asyncio.timeout(105):
                    result = await self._async_run(user_input, chat_log, key, progress)
                if progress.provider_completed:
                    self._auth_state = "ready"
                    self._last_path = "relay"
                else:
                    self._last_path = "ha_context_unavailable"
                self._warn_login()
                self._publish_state()
                return result
            except (AdapterError, TimeoutError) as err:
                code = str(err)
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
            selected = {
                tool.name: tool for tool in (api.tools if api else [])
                if tool.name in allowed and TOOL_NAME.fullmatch(tool.name)
            }
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
                return await api.async_call_tool(llm.ToolInput(
                    id=call_id, tool_name=name, tool_args=args,
                ))

            history = self._history.get(key, (0, []))[1]
            outcome = await run_turn(self._client, prompt, user_input.text, tools, validate_args, dispatch,
                                     history=history, progress=progress)
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
                        tool_result=decode_json(message["content"]),
                    ))
            return conversation.async_get_result_from_chat_log(user_input, chat_log)
        except conversation.ConverseError as err:
            return err.as_conversation_result()
        except (HomeAssistantError, vol.Invalid, ValueError, TypeError):
            # Do not expose upstream bodies, tokens, hostnames, thinking or tool arguments.
            return _error_result(user_input, chat_log.conversation_id,
                                 "Der Assistent ist derzeit nicht verfügbar. Ein Aktionserfolg ist nicht bestätigt.")
