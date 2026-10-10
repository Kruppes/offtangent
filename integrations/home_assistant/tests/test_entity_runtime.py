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
from unittest.mock import AsyncMock, patch

from homeassistant.components import conversation
from homeassistant.components.conversation.chat_log import ChatLog, UserContent
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import Context, HomeAssistant
from homeassistant.helpers import llm
import voluptuous as vol

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from custom_components.offtangent_conversation import config_flow, diagnostics
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
        return self.result


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

    def log(self):
        log = ChatLog(self.hass, "offline-conversation")
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
        self.assertEqual(log.content[3].tool_result, SUCCESS)
        self.assertEqual(log.content[-1].content, "Home Assistant hat die Aktion bestätigt.")
        self.assertEqual(result.response.speech["plain"]["speech"], "Home Assistant hat die Aktion bestätigt.")
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


class ActualHAConfigFlowTests(unittest.TestCase):
    def test_config_flow_accepts_generic_model_and_explicit_restricted_allowlist(self):
        data = {"url": "https://example.invalid/v1", "adapter_token": "synthetic-token-only", "model": "another-model-1",
                "control": True, "allowed_tools": '["homeassistant__HassTurnOff"]'}
        config_flow._validate(data)
        for key, value in [("url", "http://insecure.invalid/v1"), ("adapter_token", "short"),
                           ("allowed_tools", "[]"), ("allowed_tools", '["shell__exec"]'),
                           ("allowed_tools", '["HassTurnOff","HassTurnOff"]'), ("model", "bad/model")]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                config_flow._validate({**data, key: value})
        form = config_flow._schema(data)
        self.assertIn("adapter_token", {str(k) for k in form.schema})
