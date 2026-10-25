"""Actual Home Assistant 2026.9.4 classes, isolated instance, ONLY simulated tools.

No HA server is started; no conversation.process or service call is used.
Requires the explicitly pinned HA environment described in README.md.
"""
import asyncio
from dataclasses import replace
import json
from pathlib import Path
import sys
import tempfile
import unittest
import unittest.mock
from unittest.mock import AsyncMock, patch
from types import SimpleNamespace

from homeassistant.components import conversation
from homeassistant.components.conversation.chat_log import ChatLog, UserContent
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import Context, HomeAssistant
from homeassistant.helpers import intent, llm
import voluptuous as vol

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from custom_components.offtangent_conversation import client, config_flow, diagnostics
from custom_components.offtangent_conversation.client import AdapterError, validate_reply
from custom_components.offtangent_conversation.const import DEFAULT_PROMPT, DOMAIN
from custom_components.offtangent_conversation.conversation import OfftangentConversationEntity

MODEL = "claude-haiku-5-5"
NAME = "homeassistant__HassTurnOff"
SUCCESS = {"response_type": "action_done", "data": {"success": [{"id": "synthetic"}], "failed": []}}


class SyntheticTool(llm.Tool):
    def __init__(self, name=NAME, result=SUCCESS):
        self.name = name
        self.description = "Entirely synthetic tool; no services or states"
        self.parameters = vol.Schema({vol.Required("name"): str})
        self.calls = []
        self.result = result

    async def async_call(self, hass, tool_input, llm_context):
        self.calls.append((tool_input, llm_context))
        return as_tool_result(self.result)


def as_tool_result(data):
    """HA >= 2026.10 tools return llm.ToolResult (a bare dict is a frame-reported deprecation there)."""
    return llm.ToolResult(data=data) if hasattr(llm, "ToolResult") else data


def stored_result(content):
    """ToolResultContent payload: .result.data (HA >= 2026.10) or .tool_result (HA 2026.9)."""
    return content.result.data if "result" in content.__dataclass_fields__ else content.tool_result


class MockAdapter:
    def __init__(self, replies):
        self.replies = replies
        self.requests = []

    async def complete(self, messages, tools, session=None):
        self.requests.append(json.loads(json.dumps({"messages": messages, "tools": tools, "session": session})))
        return validate_reply(self.replies.pop(0), MODEL, tools)


def reply(message=None, calls=None):
    if calls is not None:
        message = {"role": "assistant", "content": "Unbestätigte Vorausbehauptung!", "tool_calls": calls}
    message = message or {"role": "assistant", "content": "Modellbehauptung: alles ist aus!"}
    return {"model": MODEL, "ha_session": "synthetic-only-vault",
            "choices": [{"message": message, "finish_reason": "tool_calls" if calls is not None else "stop"}]}


def call(cid="synthetic-id", args=None, name=NAME):
    return {"type": "function", "id": cid, "function": {"name": name, "arguments": json.dumps(args or {"name": "synthetic"})}}


class ActualHAEntityTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        # Never use real DATA_DIR, HA credentials or installed production configuration.
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[3], prefix=".ha-offline-test-")
        self.hass = HomeAssistant(self.temp.name)
        self.hass.config.location_name = "Offline synthetic HA"
        self.tool = SyntheticTool()
        api = type("OfflineAPI", (), {"hass": self.hass})()
        self.context = Context()
        self.input = conversation.ConversationInput(
            text="Simuliertes Licht aus", context=self.context,
            conversation_id="offline-conversation", device_id="synthetic-voice-device",
            satellite_id=None, language="de", agent_id="conversation.offtangent_synthetic",
        )
        self.api = llm.APIInstance(api=api, api_prompt="Only synthetic exposed device",
                                   llm_context=self.input.as_llm_context(DOMAIN), tools=[self.tool, SyntheticTool("shell__exec")])
        self.api_patch = patch.object(llm, "async_get_api", AsyncMock(return_value=self.api))
        self.get_api = self.api_patch.start()
        self.services_before = self.hass.services.async_services()

    async def asyncTearDown(self):
        self.assertEqual(self.hass.services.async_services(), self.services_before)
        self.api_patch.stop()
        self.temp.cleanup()

    def agent(self, adapter, control=True, allowed=None):
        data = {"url": "https://adapter.example.invalid/v1", "adapter_token": "synthetic-token-only",
                "model": MODEL, "control": control, "allowed_tools": json.dumps(allowed or [NAME])}
        entry = ConfigEntry(domain=DOMAIN, title="Synthetic Offtangent", data=data, options={},
                            source="user", version=1, minor_version=1, unique_id=None,
                            discovery_keys={}, subentries_data=[])
        entry.runtime_data = adapter
        entity = OfftangentConversationEntity(entry)
        entity.hass = self.hass
        entity.entity_id = "conversation.offtangent_synthetic"
        return entity

    def log(self, conversation_id="offline-conversation"):
        log = ChatLog(self.hass, conversation_id)
        log.async_add_user_content(UserContent(content=self.input.text))
        return log

    async def test_real_chatlog_assist_context_schema_external_tool_roundtrip(self):
        adapter = MockAdapter([reply(calls=[call()]), reply()])
        agent = self.agent(adapter); log = self.log()
        log.extra_system_prompt = "Dangerous prompt from a different pipeline"
        result = await agent._async_handle_message(self.input, log)
        self.assertEqual(len(self.tool.calls), 1)
        self.assertIs(self.tool.calls[0][1].context, self.context)
        self.assertEqual(self.tool.calls[0][1].device_id, "synthetic-voice-device")
        self.assertEqual(self.tool.calls[0][1].assistant, conversation.DOMAIN)
        self.assertEqual(self.get_api.await_args.args[1], llm.LLM_API_ASSIST)
        self.assertEqual([t["function"]["name"] for t in adapter.requests[0]["tools"]], [NAME])
        self.assertEqual(adapter.requests[0]["tools"][0]["function"]["parameters"]["type"], "object")
        self.assertIn("name", adapter.requests[0]["tools"][0]["function"]["parameters"]["properties"])
        self.assertIn(DEFAULT_PROMPT, adapter.requests[0]["messages"][0]["content"])
        self.assertNotIn("Dangerous prompt", adapter.requests[0]["messages"][0]["content"])
        self.assertIsNone(log.content[2].content)
        self.assertTrue(log.content[2].tool_calls[0].external)
        self.assertEqual(stored_result(log.content[3]), SUCCESS)
        # F7: second model round sees HA's native result; its answer is the turn answer (like HA agents).
        self.assertEqual(len(adapter.requests), 2)
        self.assertEqual(adapter.requests[1]["messages"][-1]["role"], "tool")
        self.assertEqual(json.loads(adapter.requests[1]["messages"][-1]["content"]), SUCCESS)
        self.assertEqual(log.content[-1].content, "Modellbehauptung: alles ist aus!")
        self.assertEqual(result.response.speech["plain"]["speech"], "Modellbehauptung: alles ist aus!")
        self.assertFalse(agent._attr_supports_streaming)

    async def test_diagnostics_exports_exact_allowlisted_schemas_without_secrets_or_execution(self):
        agent = self.agent(MockAdapter([]))
        result = await diagnostics.async_get_config_entry_diagnostics(self.hass, agent.entry)
        self.assertEqual([tool["name"] for tool in result["tools"]], [NAME])
        self.assertNotIn("synthetic-token-only", json.dumps(result))
        self.assertNotIn("adapter.example", json.dumps(result))
        self.assertNotIn("api_prompt", result)
        self.assertEqual(self.tool.calls, [])

    async def test_actual_voluptuous_bad_second_call_executes_nothing(self):
        adapter = MockAdapter([reply(calls=[call(), call("second", {"name": 5})])])
        agent = self.agent(adapter); log = self.log()
        result = await agent._async_handle_message(self.input, log)
        self.assertEqual(self.tool.calls, [])
        self.assertEqual(result.response.response_type.value, "error")
        self.assertIn("nicht bestätigt", result.response.speech["plain"]["speech"])

    async def test_tool_ambiguity_failure_and_missing_confirmation_are_reported_honestly(self):
        for error in [{"error": "ambiguous"}, {}, {"response_type": "error", "data": {"code": "no_valid_targets"}}]:
            self.tool.result = error; self.tool.calls.clear()
            adapter = MockAdapter([reply(calls=[call()])])
            result = await self.agent(adapter)._async_handle_message(self.input, self.log())
            self.assertEqual(len(self.tool.calls), 1)
            self.assertEqual(len(adapter.requests), 1)
            self.assertIn("nicht eindeutig bestätigt", result.response.speech["plain"]["speech"])

    async def test_partial_success_kept_in_answer_and_local_history(self):
        class Flaky(SyntheticTool):
            async def async_call(self, hass, tool_input, llm_context):
                self.calls.append((tool_input, llm_context))
                if len(self.calls) == 1:
                    return as_tool_result({**SUCCESS, "speech": {"plain": {"speech": "Simulierte Küche an."}}})
                raise TimeoutError()
        self.tool.__class__ = Flaky
        adapter = MockAdapter([reply(calls=[call("one", {"name": "Küche"}), call("two", {"name": "Flur"})])])
        agent = self.agent(adapter)
        result = await agent._async_handle_message(self.input, self.log())
        self.assertEqual(len(self.tool.calls), 2); self.assertEqual(len(adapter.requests), 1)
        speech = result.response.speech["plain"]["speech"]
        self.assertTrue(speech.startswith("Simulierte Küche an."))
        self.assertIn("nicht eindeutig bestätigt", speech)
        history = [m for _, hist in agent._history.values() for m in hist]
        self.assertIn({"role": "assistant", "content": speech}, history)  # next turn knows the real partial success

    async def test_control_off_requests_no_assist_api_and_no_tools(self):
        adapter = MockAdapter([reply({"role": "assistant", "content": "Kurze Wissensantwort."})])
        result = await self.agent(adapter, control=False)._async_handle_message(self.input, self.log())
        self.get_api.assert_not_awaited()
        self.assertEqual(adapter.requests[0]["tools"], [])
        self.assertEqual(self.tool.calls, [])
        self.assertEqual(result.response.speech["plain"]["speech"], "Kurze Wissensantwort.")

    async def test_busy_agent_refuses_concurrent_work_without_queueing(self):
        adapter = MockAdapter([]); agent = self.agent(adapter)
        async with agent._lock:
            result = await agent._async_handle_message(self.input, self.log())
        self.assertEqual(adapter.requests, [])
        self.assertEqual(result.response.response_type.value, "error")

    async def test_upstream_authblock_is_not_leaked_and_no_tools_run(self):
        adapter = MockAdapter([])
        adapter.complete = AsyncMock(side_effect=AdapterError("anthropic_subscription_auth_blocked private-token"))
        result = await self.agent(adapter)._async_handle_message(self.input, self.log())
        self.assertNotIn("private-token", result.response.speech["plain"]["speech"])
        self.assertEqual(self.tool.calls, [])

    async def test_history_is_not_sent_as_model_memory(self):
        adapter = MockAdapter([reply({"role": "assistant", "content": "Welches Gerät?"})])
        log = self.log()
        log.async_add_assistant_content_without_tools(conversation.AssistantContent(agent_id="another-agent", content="Private previous conversation"))
        await self.agent(adapter)._async_handle_message(self.input, log)
        self.assertEqual([m["role"] for m in adapter.requests[0]["messages"]], ["system", "user"])
        self.assertNotIn("Private previous conversation", json.dumps(adapter.requests))


    async def test_multiturn_pronoun_receives_only_own_history_and_same_device_context(self):
        adapter = MockAdapter([reply({"role": "assistant", "content": "Gemeint ist das simulierte Küchenlicht."}), reply(calls=[call(args={"name": "Küchenlicht"})]), reply()])
        agent = self.agent(adapter); log = self.log()
        await agent._async_handle_message(self.input, log)
        log.async_add_assistant_content_without_tools(conversation.AssistantContent(agent_id="foreign-agent", content="FOREIGN_PRIVATE_SECRET"))
        followup = replace(self.input, text="Schalte es aus.")
        log.async_add_user_content(UserContent(content=followup.text))
        await agent._async_handle_message(followup, log)
        sent = adapter.requests[1]["messages"]
        self.assertEqual([x["role"] for x in sent], ["system", "user", "assistant", "user"])
        self.assertEqual(sent[-1]["content"], "Schalte es aus.")
        self.assertIn("Küchenlicht", sent[-2]["content"])
        self.assertNotIn("FOREIGN_PRIVATE_SECRET", json.dumps(sent))
        self.assertEqual(len(self.tool.calls), 1)
        self.assertEqual(self.tool.calls[0][0].tool_args, {"name": "Küchenlicht"})

    async def test_same_chat_id_different_device_does_not_import_own_or_foreign_history(self):
        adapter = MockAdapter([reply(), reply()]); agent = self.agent(adapter)
        await agent._async_handle_message(self.input, self.log())
        other = replace(self.input, device_id="another-device", satellite_id="other-satellite")
        await agent._async_handle_message(other, self.log())
        self.assertEqual([x["role"] for x in adapter.requests[1]["messages"]], ["system", "user"])

    async def test_auth_poll_actively_warns_without_conversation_and_dismisses_only_verified_ready(self):
        adapter = MockAdapter([])
        adapter.auth_status = AsyncMock(side_effect=[
            {"auth": {"state": "relogin_required"}}, {"auth": {"state": "relogin_required"}},
            AdapterError("adapter_unavailable"), {"auth": {"state": "access_expired"}},
            {"auth": {"state": "ready"}}, {"auth": {"state": "ready"}},
        ])
        agent = self.agent(adapter)
        with patch("custom_components.offtangent_conversation.conversation.persistent_notification.async_create") as notice, patch("custom_components.offtangent_conversation.conversation.persistent_notification.async_dismiss") as dismiss:
            for _ in range(4):
                await agent._poll_auth()
            self.assertEqual(notice.call_count, 1)
            dismiss.assert_not_called()
            self.assertEqual(agent.extra_state_attributes["provider_auth_state"], "access_expired")
            for _ in range(2):
                await agent._poll_auth()
            self.assertEqual(notice.call_count, 1)
            self.assertEqual(dismiss.call_count, 1)
            self.assertFalse(agent.extra_state_attributes["relogin_required"])
        self.assertEqual(adapter.auth_status.await_count, 6)
        self.assertEqual(adapter.requests, [])
        self.assertEqual(self.tool.calls, [])
        self.assertEqual(agent.extra_state_attributes["degradation_count"], 0)

    async def test_relogin_warning_deduplicated_local_fallback_counted_and_session_isolated(self):
        adapter = MockAdapter([])
        adapter.complete = AsyncMock(side_effect=AdapterError("provider_relogin_required"))
        agent = self.agent(adapter); agent._settings["fallback_agent"] = "conversation.synthetic_ollama"
        async def local_reply(_input):
            response = conversation.ConversationResult(response=__import__('homeassistant.helpers.intent', fromlist=['IntentResponse']).IntentResponse(language="de"), conversation_id="synthetic-local-returned-id")
            response.response.async_set_speech("Lokale synthetische Antwort")
            return response
        local = SimpleNamespace(async_process=AsyncMock(side_effect=local_reply))
        with patch("custom_components.offtangent_conversation.conversation.local_fallback_entry", return_value=object()), patch.object(conversation, "async_get_agent", return_value=local), patch("custom_components.offtangent_conversation.conversation.persistent_notification.async_create") as notice, patch("custom_components.offtangent_conversation.conversation.persistent_notification.async_dismiss") as dismiss:
            for _ in range(2):
                result = await agent._async_handle_message(self.input, self.log())
                self.assertEqual(result.response.speech["plain"]["speech"], "Lokaler Ersatzassistent. Lokale synthetische Antwort")
            self.assertEqual(notice.call_count, 1)
            self.assertEqual(agent.extra_state_attributes["degradation_count"], 2)
            self.assertEqual(agent.extra_state_attributes["last_path"], "local_fallback")
            self.assertTrue(agent.extra_state_attributes["relogin_required"])
            first = local.async_process.await_args_list[0].args[0]
            second = local.async_process.await_args_list[1].args[0]
            self.assertNotEqual(first.conversation_id, self.input.conversation_id)
            self.assertEqual(second.conversation_id, "synthetic-local-returned-id")
            self.assertIsNone(first.extra_system_prompt)
            self.assertEqual(first.agent_id, "conversation.synthetic_ollama")
            agent._auth_state = "ready"; agent._warn_login(); agent._warn_login()
            dismiss.assert_called_once()
        self.assertEqual(self.tool.calls, [])

    async def test_tool_partial_failure_and_raising_mutation_never_use_fallback_or_repeat(self):
        for tool_result in [{"response_type": "action_done", "data": {"success": [1], "failed": [2]}}, {"error": "synthetic possible execution before failure"}]:
            self.tool.calls.clear(); self.tool.result = tool_result
            adapter = MockAdapter([reply(calls=[call(), call("second", {"name": "other"})])])
            agent = self.agent(adapter); agent._settings["fallback_agent"] = "conversation.synthetic_ollama"
            with patch.object(agent, "_fallback", new=AsyncMock()) as fallback:
                result = await agent._async_handle_message(self.input, self.log())
                fallback.assert_not_awaited()
            self.assertEqual(len(self.tool.calls), 1); self.assertEqual(len(adapter.requests), 1)
            self.assertIn("nicht eindeutig bestätigt", result.response.speech["plain"]["speech"])

    async def test_queried_information_is_not_required_to_be_an_action_confirmation(self):
        name = "homeassistant__HassGetState"
        info = SyntheticTool(name, {"response_type": "query_answer", "data": {"success": [1], "failed": []}, "speech": {"plain": {"speech": "Die Temperatur beträgt 22 Grad."}}})
        self.api.tools = [info]
        adapter = MockAdapter([reply(calls=[call(name=name)]), reply({"role": "assistant", "content": "Die Temperatur beträgt 22 Grad."})])
        result = await self.agent(adapter, allowed=[name])._async_handle_message(self.input, self.log())
        self.assertEqual(len(info.calls), 1); self.assertEqual(len(adapter.requests), 2)
        self.assertEqual(result.response.speech["plain"]["speech"], "Die Temperatur beträgt 22 Grad.")
        self.assertNotIn("Aktion bestätigt", result.response.speech["plain"]["speech"])


    async def test_ha_error_flag_locks_action_and_marks_chatlog(self):
        # P0 review probe: ToolResult(data={"success": True}, error=True) is never a confirmation.
        if not hasattr(llm, "ToolResult"):
            self.skipTest("HA < 2026.10 has no ToolResult error flag")
        class Contradicting(SyntheticTool):
            async def async_call(self, hass, tool_input, llm_context):
                self.calls.append((tool_input, llm_context))
                return llm.ToolResult(data={**SUCCESS, "success": True}, error=True)
        self.tool.__class__ = Contradicting
        adapter = MockAdapter([reply(calls=[call()])])
        log = self.log()
        result = await self.agent(adapter)._async_handle_message(self.input, log)
        self.assertIn("nicht eindeutig bestätigt", result.response.speech["plain"]["speech"])
        stored = [c for c in log.content if isinstance(c, conversation.ToolResultContent)]
        self.assertEqual(len(stored), 1)
        self.assertIs(stored[0].result.error, True)
        self.assertIs(stored[0].result.data["success"], False)

    async def test_match_failed_read_only_says_not_found_action_stays_unconfirmed(self):
        await self._match_failed(intent.MatchTargetsConstraints(name="Keller"),
                                 "Dieses Gerät habe ich in Home Assistant nicht gefunden.")

    async def test_match_failed_area_or_domain_is_neutral(self):
        await self._match_failed(intent.MatchTargetsConstraints(area_name="Keller"),
                                 "Dazu habe ich in Home Assistant nichts gefunden.")
        await self._match_failed(intent.MatchTargetsConstraints(name="Lampe", domains=["light"]),
                                 "Dazu habe ich in Home Assistant nichts gefunden.")

    async def _match_failed(self, constraints, expected):
        def no_match(*_):
            raise intent.MatchFailedError(
                intent.MatchTargetsResult(False, intent.MatchFailedReason.NAME), constraints)
        class Missing(SyntheticTool):
            async def async_call(self, hass, tool_input, llm_context):
                self.calls.append((tool_input, llm_context))
                no_match()
        read = Missing("homeassistant__HassGetState")
        self.api.tools = [read, Missing(NAME)]
        # The single lookup retry round repeats the identical lookup: blocked, never re-dispatched.
        adapter = MockAdapter([reply(calls=[call(name="homeassistant__HassGetState")]),
                               reply(calls=[call(cid="retry-id", name="homeassistant__HassGetState")])])
        result = await self.agent(adapter, allowed=["homeassistant__HassGetState"])._async_handle_message(self.input, self.log())
        self.assertEqual(len(read.calls), 1); self.assertEqual(len(adapter.requests), 2)
        self.assertEqual(result.response.speech["plain"]["speech"], expected)
        adapter = MockAdapter([reply(calls=[call()])])
        result = await self.agent(adapter)._async_handle_message(self.input, self.log())
        self.assertIn("nicht eindeutig bestätigt", result.response.speech["plain"]["speech"])

    async def test_auth_poll_outage_invalid_status_and_recovery_never_keep_cached_ready(self):
        from datetime import datetime
        adapter = MockAdapter([])
        adapter.auth_status = AsyncMock(side_effect=[
            {"auth": {"state": "ready"}}, AdapterError("adapter_unavailable"),
            {"auth": {"state": "not_a_state"}}, {},
            {"auth": {"state": "unknown"}},
        ])
        agent = self.agent(adapter, control=False)
        agent._state_ready = True
        with patch.object(agent, "async_write_ha_state") as publish:
            await agent._poll_auth()
            success_at = agent.extra_state_attributes["auth_status_last_success_at"]
            self.assertEqual(agent.extra_state_attributes["provider_auth_state"], "ready")
            self.assertIsNotNone(datetime.fromisoformat(success_at).tzinfo)
            for _ in range(3):
                await agent._poll_auth()
                attrs = agent.extra_state_attributes
                self.assertEqual(attrs["provider_auth_state"], "relay_unavailable")
                self.assertEqual(attrs["auth_status_last_success_at"], success_at)
                self.assertIsNotNone(datetime.fromisoformat(attrs["auth_status_last_error_at"]).tzinfo)
            error_at = attrs["auth_status_last_error_at"]
            await agent._poll_auth()
            self.assertEqual(agent.extra_state_attributes["provider_auth_state"], "unknown")
            self.assertEqual(agent.extra_state_attributes["auth_status_last_error_at"], error_at)
            self.assertEqual(publish.call_count, 5)
        self.assertEqual(adapter.requests, [])
        self.assertEqual(self.tool.calls, [])

    async def test_login_notification_survives_poll_outage_and_relogin_unknown(self):
        adapter = MockAdapter([])
        adapter.auth_status = AsyncMock(side_effect=[
            {"auth": {"state": "relogin_required"}}, AdapterError("adapter_unavailable"),
            {"auth": {"state": "unknown"}}, {"auth": {"state": "ready"}},
        ])
        agent = self.agent(adapter, control=False)
        with patch("custom_components.offtangent_conversation.conversation.persistent_notification.async_create") as create, patch("custom_components.offtangent_conversation.conversation.persistent_notification.async_dismiss") as dismiss:
            for _ in range(3):
                await agent._poll_auth()
            create.assert_called_once()
            dismiss.assert_not_called()
            await agent._poll_auth()
            dismiss.assert_called_once()

    async def test_auth_status_poll_deduplicates_login_warning_and_unknown_does_not_dismiss(self):
        adapter = MockAdapter([])
        adapter.auth_status = AsyncMock(side_effect=[{"auth": {"state": state}} for state in ["relogin_required", "relogin_required", "unknown", "ready"]])
        agent = self.agent(adapter, control=False)
        with patch("custom_components.offtangent_conversation.conversation.persistent_notification.async_create") as create, patch("custom_components.offtangent_conversation.conversation.persistent_notification.async_dismiss") as dismiss:
            await agent._poll_auth(); await agent._poll_auth(); await agent._poll_auth()
            self.assertEqual(create.call_count, 1); dismiss.assert_not_called()
            await agent._poll_auth(); dismiss.assert_called_once()
        self.assertEqual(len(adapter.requests), 0); self.assertEqual(self.tool.calls, [])

    async def test_fallback_only_sessions_are_bounded_and_own_answer_is_retained(self):
        adapter = MockAdapter([reply({"role": "assistant", "content": "Eigener Folgebezug"})])
        agent = self.agent(adapter, control=False)
        agent._settings["fallback_agent"] = "conversation.synthetic_ollama"
        async def local_reply(value):
            response = intent.IntentResponse(language="de")
            response.async_set_speech("Eigene lokale Antwort")
            return conversation.ConversationResult(response=response, conversation_id=value.conversation_id)
        from homeassistant.helpers import intent
        local = SimpleNamespace(async_process=AsyncMock(side_effect=local_reply))
        with patch("custom_components.offtangent_conversation.conversation.local_fallback_entry"), patch("custom_components.offtangent_conversation.conversation.conversation.async_get_agent", return_value=local):
            for i in range(70):
                own_input = replace(self.input, conversation_id=f"synthetic-own-{i}")
                own_log = self.log(own_input.conversation_id)
                key = agent._history_key(own_input, own_log)
                await agent._fallback(own_input, own_log, key)
        self.assertEqual(len(agent._history), 64); self.assertEqual(len(agent._fallback_ids), 64)
        own_input = replace(self.input, conversation_id="synthetic-own-69", text="Was davon?")
        await agent._async_handle_message(own_input, self.log(own_input.conversation_id))
        self.assertEqual([m["role"] for m in adapter.requests[0]["messages"]], ["system", "user", "assistant", "user"])
        self.assertEqual(adapter.requests[0]["messages"][-2]["content"], "Lokaler Ersatzassistent. Eigene lokale Antwort")
        self.assertEqual(self.tool.calls, [])


    async def test_full_assist_allowlist_forwards_every_ha_offered_tool_without_namespace_filter(self):
        native = [SyntheticTool(n) for n in ("homeassistant__GetLiveContext", "llm__GetDateTime", "todo__get_items",
                                             "todo__HassListAddItem", "script__abendstimmung", "intent__HassTurnOn",
                                             "light__HassLightSet", "media_player__HassMediaPause", "vacuum__HassVacuumStart")]
        native += [SyntheticTool(n) for n in ("script__1_morgens", "intent_script__Abendmodus", "my_custom__do",
                                              "shell__exec", "custom__run")]
        # Whatever HA's api.tools offers (core, custom integrations, scripts with leading digits,
        # intent_script) is forwarded (F2). Only wire-unsendable names are dropped, and reported.
        self.api.tools = [self.tool, *native, SyntheticTool("bad name")]
        adapter = MockAdapter([reply(calls=[call(name="llm__GetDateTime", args={})]), reply()])
        agent = self.agent(adapter, allowed=["*"])
        await agent._async_handle_message(self.input, self.log())
        sent = [t["function"]["name"] for t in adapter.requests[0]["tools"]]
        self.assertEqual(sent, [NAME, *[t.name for t in native]])
        self.assertEqual([t.name for t in native if t.calls], ["llm__GetDateTime"])
        self.assertEqual(self.tool.calls, [])
        diag = await diagnostics.async_get_config_entry_diagnostics(self.hass, agent.entry)
        self.assertEqual([t["name"] for t in diag["tools"]], sent)
        self.assertEqual(diag["unsendable_tools"], ["bad name"])
        self.assertEqual(diag["tool_count"], len(sent))
        self.assertGreater(diag["tool_payload_bytes"], 0)


class ActualHAConfigFlowTests(unittest.TestCase):
    def test_config_flow_full_assist_allowlist_only_alone_and_with_control(self):
        data = {"url": "https://example.invalid/v1", "adapter_token": "synthetic-token-only", "model": "another-model-1",
                "control": True, "allowed_tools": '["*"]'}
        config_flow._validate(data)
        config_flow._validate({**data, "allowed_tools": '["llm__GetDateTime","todo__get_items","script__x"]'})
        config_flow._validate({**data, "allowed_tools": '["my_custom__do","script__1_morgens","intent_script__X"]'})
        for value, control in [('["*","homeassistant__HassTurnOff"]', True), ('["*"]', False), ('["**"]', True),
                               ('["bad name"]', True), ('["a.b"]', True)]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                config_flow._validate({**data, "allowed_tools": value, "control": control})

    def test_config_flow_accepts_generic_model_and_explicit_restricted_allowlist(self):
        data = {"url": "https://example.invalid/v1", "adapter_token": "synthetic-token-only", "model": "another-model-1",
                "control": True, "allowed_tools": '["homeassistant__HassTurnOff"]'}
        config_flow._validate(data)
        config_flow._validate({**data, "url": "https://example.invalid/ha-relay/v1", "fallback_agent": ""})
        config_flow._validate({**data, "fallback_agent": "conversation.local_ollama"})
        for key, value in [("url", "http://insecure.invalid/v1"), ("adapter_token", "short"),
                           ("allowed_tools", "[]"), ("allowed_tools", '["shell exec"]'),
                           ("allowed_tools", '["HassTurnOff","HassTurnOff"]'), ("model", "bad/model"),
                           ("fallback_agent", "remote.agent"), ("fallback_agent", 1)]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                config_flow._validate({**data, key: value})
        form = config_flow._schema(data)
        self.assertIn("adapter_token", {str(k) for k in form.schema})


LIVE = "homeassistant__GetLiveContext"


class LiveContextTool(llm.Tool):
    """Synthetic stand-in with HA's GetLiveContext parameter shape; scripted results, no states."""

    def __init__(self, results):
        self.name = LIVE  # real HA tool id (see live-questions.jsonl)
        self.description = "Synthetic live context; no services or real states"
        self.parameters = vol.Schema({vol.Optional("name"): str, vol.Optional("area"): str})
        self.results, self.calls = results, []

    async def async_call(self, hass, tool_input, llm_context):
        self.calls.append(tool_input.tool_args)
        return as_tool_result(self.results.pop(0))


class ActualHALookupRetryTests(unittest.IsolatedAsyncioTestCase):
    """Real HA area/floor/entity/device registries + exposure store; lookup retry end to end."""

    agent, log, asyncTearDown = ActualHAEntityTests.agent, ActualHAEntityTests.log, ActualHAEntityTests.asyncTearDown

    async def asyncSetUp(self):
        await ActualHAEntityTests.asyncSetUp(self)
        from homeassistant.components.homeassistant import exposed_entities
        from homeassistant.components.homeassistant.const import DATA_EXPOSED_ENTITIES
        from homeassistant.helpers import area_registry as ar, device_registry as dr
        from homeassistant.helpers import entity_registry as er, floor_registry as fr
        dr.async_setup(self.hass)
        for registry in (fr, ar, dr, er):
            await registry.async_load(self.hass, load_empty=True)
        floors = fr.async_get(self.hass)
        eg = floors.async_create("Erdgeschoss", aliases={"EG", "unten"})
        og = floors.async_create("Obergeschoss", aliases={"OG", "oben"})
        areas = ar.async_get(self.hass)
        self.flur_eg = areas.async_create("Flur EG", aliases={"Flur unten", "unterer Flur", "Flur Erdgeschoss"},
                                          floor_id=eg.floor_id)
        self.flur_og = areas.async_create("Flur OG", aliases={"Flur oben", "oberer Flur", "Flur Obergeschoss"},
                                          floor_id=og.floor_id)
        areas.async_create("Flur Keller")  # no exposed entity -> never offered
        store = exposed_entities.ExposedEntities(self.hass)
        await store.async_initialize()
        self.hass.data[DATA_EXPOSED_ENTITIES] = store
        ents = er.async_get(self.hass)
        for uid, area in (("eg", self.flur_eg), ("og", self.flur_og)):
            entry = ents.async_get_or_create("light", "synthetic", uid, suggested_object_id=f"flur_{uid}")
            ents.async_update_entity(entry.entity_id, area_id=area.id)
            self.hass.states.async_set(entry.entity_id, "on")
            exposed_entities.async_expose_entity(self.hass, conversation.DOMAIN, entry.entity_id, True)
        hidden = ents.async_get_or_create("light", "synthetic", "keller", suggested_object_id="flur_keller")
        self.hass.states.async_set(hidden.entity_id, "off")

    def live_agent(self, adapter, results):
        tool = LiveContextTool(results)
        self.api.tools[:] = [tool]
        return self.agent(adapter, allowed=[LIVE]), tool

    async def test_name_no_match_hint_lists_exposed_areas_then_area_hit_answers(self):
        no_match = {"success": False, "error": "No exposed entities matched name 'Flur'"}
        hit = {"success": True, "result": "- names: Flur Licht\n  domain: light\n  state: 'on'\n  areas: Flur EG"}
        adapter = MockAdapter([reply(calls=[call("r1", {"name": "Flur"}, LIVE)]),
                               reply(calls=[call("r2", {"area": "Flur EG"}, LIVE), call("r3", {"area": "Flur OG"}, LIVE)]),
                               reply({"role": "assistant", "content": "Ja, im Flur EG und OG ist das Licht an."})])
        agent, tool = self.live_agent(adapter, [no_match, hit, hit])
        result = await agent._async_handle_message(self.input, self.log())
        self.assertEqual(result.response.speech["plain"]["speech"], "Ja, im Flur EG und OG ist das Licht an.")
        self.assertEqual(tool.calls, [{"name": "Flur"}, {"area": "Flur EG"}, {"area": "Flur OG"}])
        sent = json.loads(adapter.requests[1]["messages"][-1]["content"])
        self.assertEqual(sent["error"], no_match["error"])
        self.assertEqual(sent["candidates"], ["Flur EG", "Flur OG"])  # data field, fixed hint text
        self.assertEqual(sent["hint"], client.HINT_WITH_CANDIDATES)
        self.assertNotIn("Flur Keller", json.dumps(sent))

    async def test_alias_and_floor_lookup_candidates_from_real_registries(self):
        from custom_components.offtangent_conversation.conversation import lookup_hint_for
        hint = lambda term: lookup_hint_for(self.hass, LIVE, {"name": term}, {})
        self.assertEqual(hint("Flur unten")["candidates"], ["Flur EG"])
        self.assertEqual(hint("oberer Flur")["candidates"], ["Flur OG"])
        self.assertEqual(hint("Erdgeschoss")["candidates"], ["Flur EG"])
        self.assertEqual(hint("Garage"), {"hint": client.HINT_GENERIC})
        self.assertEqual(hint("Keller"), {"hint": client.HINT_GENERIC})  # hidden area never offered

    async def test_exposure_check_failure_is_fail_closed(self):
        from homeassistant.components.homeassistant import exposed_entities
        from homeassistant.components.homeassistant.const import DATA_EXPOSED_ENTITIES
        from custom_components.offtangent_conversation import conversation as conv
        self.assertEqual(conv._exposed_area_ids(self.hass), {self.flur_eg.id, self.flur_og.id})
        failures = {
            "store missing": unittest.mock.patch.dict(self.hass.data, {DATA_EXPOSED_ENTITIES: None}),
            "api raises": unittest.mock.patch.object(exposed_entities, "async_should_expose",
                                                     side_effect=AttributeError("changed api")),
            "api changed result": unittest.mock.patch.object(exposed_entities, "async_should_expose",
                                                             return_value="yes"),
            "api removed": unittest.mock.patch.object(exposed_entities, "async_should_expose", new=None),
        }
        for label, patch in failures.items():
            with self.subTest(label), patch:
                self.assertEqual(conv._exposed_area_ids(self.hass), set())
                for term in ("Flur", "Keller", "Flur Keller"):
                    self.assertEqual(conv.lookup_candidates_for(self.hass, LIVE, {"name": term}, {}), [])
                    self.assertEqual(conv.lookup_hint_for(self.hass, LIVE, {"name": term}, {}),
                                     {"hint": client.HINT_GENERIC})
        # End to end: the hidden area never reaches the model when the exposure check fails.
        adapter = MockAdapter([reply(calls=[call("r1", {"name": "Flur Keller"}, LIVE)]),
                               reply({"role": "assistant", "content": "nie"})])
        agent, tool = self.live_agent(adapter, [{"success": False, "error": "No exposed entities matched name 'Flur Keller'"}])
        with failures["api raises"]:
            await agent._async_handle_message(self.input, self.log())
        sent = json.loads(adapter.requests[1]["messages"][-1]["content"])
        self.assertEqual(sent["hint"], client.HINT_GENERIC); self.assertNotIn("candidates", sent)

    async def test_second_no_match_gives_fixed_text_and_no_third_round(self):
        missing = {"success": False, "error": "No exposed entities matched name 'Flur'"}
        area_missing = {"success": False, "error": "Area 'Flur' does not exist"}
        adapter = MockAdapter([reply(calls=[call("r1", {"name": "Flur"}, LIVE)]),
                               reply(calls=[call("r2", {"area": "Flur"}, LIVE)])])
        agent, tool = self.live_agent(adapter, [missing, area_missing])
        result = await agent._async_handle_message(self.input, self.log())
        self.assertEqual(result.response.speech["plain"]["speech"], "Dazu habe ich in Home Assistant nichts gefunden.")
        self.assertEqual(len(tool.calls), 2); self.assertEqual(len(adapter.requests), 2)
