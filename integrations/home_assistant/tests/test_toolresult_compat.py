"""HA 2026.9 (dict tool results) and 2026.10 (llm.ToolResult) compatibility; offline, no services.

Covers the review probes of bb9be4e0: HA error flag is a lock, bare data is never a synthetic
action confirmation, non-mapping data is a safe error, ChatLog serialisation never crashes.
"""
from dataclasses import dataclass, field
import unittest
from unittest.mock import patch

from homeassistant.helpers import llm

from custom_components.offtangent_conversation import client
from custom_components.offtangent_conversation import conversation as conv


@dataclass
class FakeToolResult:
    """Mirrors HA 2026.10 llm.ToolResult(data, error)."""
    data: object
    error: bool = False


# Real class when installed (HA >= 2026.10), else the stub with the same fields.
ToolResult = getattr(llm, "ToolResult", FakeToolResult)
NEW_HA = hasattr(llm, "ToolResult")


@dataclass
class OldToolResultContent:  # HA 2026.9
    agent_id: str
    tool_call_id: str
    tool_name: str
    tool_result: dict = field(default_factory=dict)


@dataclass
class NewToolResultContent:  # HA 2026.10
    agent_id: str
    tool_call_id: str
    tool_name: str
    result: FakeToolResult = None


ACTION_DONE = {"response_type": "action_done", "data": {"success": [{"name": "Lamp"}], "failed": []}}


def judged(name, data, error=False):
    """normalize -> client.confirmed_result, exactly the runtime path of dispatch + run_turn."""
    out = conv.normalize_tool_result(name, ToolResult(data=data, error=error))
    return out, client.confirmed_result(name, out)


class HaErrorFlagIsALockTests(unittest.TestCase):
    """P0: ToolResult.error=True can never become a confirmation, whatever data says."""

    def test_contradicting_success_with_error_flag(self):
        for name in ("script__demo", "my_custom__write", "media_player__play_media", "todo__get_items"):
            with self.subTest(name=name):
                out, ok = judged(name, {"success": True, "result": "OK"}, error=True)
                self.assertFalse(ok)
                self.assertIs(out["error"], True)
                self.assertIs(out["success"], False)

    def test_intent_action_done_with_error_flag(self):
        out, ok = judged("homeassistant__HassTurnOff", ACTION_DONE, error=True)
        self.assertFalse(ok)
        self.assertIs(out["error"], True)
        self.assertEqual(out["response_type"], "action_done")

    def test_error_message_kept_and_input_not_mutated(self):
        data = {"error": "Calendar not found"}
        out, ok = judged("calendar__get_events", data, error=True)
        self.assertFalse(ok)
        self.assertEqual(out, {"error": "Calendar not found"})
        bare = {"message": "boom"}
        out, ok = judged("script__demo", bare, error=True)
        self.assertEqual((out, ok), ({"message": "boom", "error": True}, False))
        self.assertEqual(bare, {"message": "boom"})

    def test_chatlog_flag_comes_from_ha_flag_even_if_payload_lost_it(self):
        with patch.object(conv.conversation, "ToolResultContent", NewToolResultContent), \
             patch.object(conv.llm, "ToolResult", FakeToolResult, create=True):
            self.assertIs(conv.tool_result_content_kwargs({"success": True}, True)["result"].error, True)
            self.assertIs(conv.tool_result_content_kwargs({"success": True}, False)["result"].error, False)
            for payload in ({"error": "x"}, {"success": False}, {"error": True}):
                self.assertIs(conv.tool_result_content_kwargs(payload, False)["result"].error, True)


class NoSyntheticConfirmationTests(unittest.TestCase):
    """P1: bare data with error=False only confirms for verified HA 2026.10 contracts."""

    def test_negative_indicators_in_bare_data_block_first(self):
        for name in ("script__demo", "my_custom__write", "llm__GetDateTime", "homeassistant__GetLiveContext"):
            for data in ({"error": "script failed"}, {"success": False}, {"result": {"error": "failed"}}):
                with self.subTest(name=name, data=data):
                    out, ok = judged(name, data)
                    self.assertFalse(ok)
                    self.assertNotEqual(out.get("success"), True)

    def test_empty_data_is_never_confirmed(self):
        for name in ("script__demo", "my_custom__write", "llm__GetDateTime", "todo__get_items",
                     "homeassistant__GetLiveContext", "homeassistant__HassTurnOn"):
            with self.subTest(name=name):
                self.assertFalse(judged(name, {})[1])

    def test_custom_or_unknown_tool_bare_data_stays_unconfirmed(self):
        for name in ("my_custom__write", "custom__run", "media_player__search_media", "shell__exec"):
            with self.subTest(name=name):
                out, ok = judged(name, {"done": True, "result": "written"})
                self.assertFalse(ok)
                self.assertTrue(out[client.UNCONFIRMED])
                self.assertEqual(out["result"], {"done": True, "result": "written"})  # data still visible

    def test_custom_tool_with_explicit_success_contract(self):
        self.assertTrue(judged("media_player__play_media", {"success": True})[1])
        self.assertFalse(judged("my_custom__write", {"success": False})[1])

    def test_script_action_tool_contract(self):
        # helpers/llm.py ActionTool: {"result": service_response} only after blocking=True call returned.
        self.assertEqual(judged("script__demo", {"result": {"var": 1}}), ({"success": True, "result": {"var": 1}}, True))
        self.assertTrue(judged("script__demo", {"result": None})[1])
        self.assertFalse(judged("script__demo", {"result": None, "extra": 1})[1])

    def test_read_only_native_contracts_still_answer(self):
        now = {"date": "2026-10-20", "time": "12:00:00", "timezone": "CEST", "weekday": "Tuesday"}
        cases = [
            ("llm__GetDateTime", now, {"success": True, "result": now}),
            ("homeassistant__GetLiveContext", {"result": "- names: Lampe\n  state: 'on'"},
             {"success": True, "result": "- names: Lampe\n  state: 'on'"}),
            ("todo__get_items", {"items": [{"summary": "Milch"}]}, {"success": True, "result": [{"summary": "Milch"}]}),
            ("calendar__get_events", {"events": []}, {"success": True, "result": []}),
        ]
        for name, data, expected in cases:
            with self.subTest(name=name):
                self.assertEqual(judged(name, data), (expected, True))
                self.assertFalse(client.is_mutating(name))  # no action claimed, read result only
        self.assertFalse(judged("llm__GetDateTime", {"date": "x"})[1])  # contract shape is exact
        self.assertFalse(judged("homeassistant__GetLiveContext", {"result": ["not", "text"]})[1])

    def test_intent_responses_unchanged(self):
        self.assertEqual(judged("homeassistant__HassTurnOff", ACTION_DONE), (ACTION_DONE, True))
        query = {"response_type": "query_answer", "data": {"success": [], "failed": []}}
        self.assertTrue(judged("homeassistant__HassGetState", query)[1])
        err = {"response_type": "error", "data": {"code": "no_valid_targets"}}
        self.assertFalse(judged("homeassistant__HassTurnOff", err)[1])

    def test_legacy_dict_passes_through_identically(self):
        for legacy in ({"success": True}, {"response_type": "x", "data": {}}, {"error": "x"}, {}):
            self.assertIs(conv.normalize_tool_result("my_custom__do", legacy), legacy)


class BoundaryTests(unittest.TestCase):
    """P2: non-mapping data never confirms and never crashes ChatLog creation."""

    def test_non_mapping_toolresult_data_is_safe_error(self):
        for data in (None, [], [1], "OK", 5):
            for name in ("script__demo", "llm__GetDateTime", "my_custom__write"):
                with self.subTest(data=data, name=name):
                    out, ok = judged(name, data)
                    self.assertEqual(out, {"error": conv.INVALID_TOOL_RESULT})
                    self.assertFalse(ok)

    def test_non_mapping_legacy_result_is_safe_error(self):
        for value in (None, [], "OK"):
            self.assertEqual(conv.normalize_tool_result("x__y", value), {"error": conv.INVALID_TOOL_RESULT})

    def test_chatlog_kwargs_never_crash_on_non_mapping_payload(self):
        for payload in ([], None, "x", 3):
            with self.subTest(payload=payload):
                kw = conv.tool_result_content_kwargs(payload)
                content = conv.conversation.ToolResultContent(agent_id="a", tool_call_id="1", tool_name="t", **kw)
                if NEW_HA:
                    self.assertIs(content.result.error, True)
                    self.assertEqual(content.result.data, {"error": conv.INVALID_TOOL_RESULT})
                else:
                    self.assertEqual(kw, {"tool_result": {"error": conv.INVALID_TOOL_RESULT}})


class NotFoundTests(unittest.TestCase):
    """Optional: read-only lookups answer "not found"; actions keep the confirmation rule."""

    def test_read_only_not_found_shapes(self):
        live = conv.normalize_tool_result("homeassistant__GetLiveContext", ToolResult(
            data={"error": "No exposed entities matched name 'Keller'"}, error=True))
        self.assertTrue(client.not_found("homeassistant__GetLiveContext", live))
        self.assertTrue(client.not_found("homeassistant__HassGetState", {"error": conv.NOT_FOUND}))
        self.assertTrue(client.not_found("homeassistant__HassGetState",
                                         {"response_type": "error", "data": {"code": "no_valid_targets"}}))

    def test_actions_and_other_errors_are_never_not_found(self):
        err = {"response_type": "error", "data": {"code": "no_valid_targets"}}
        self.assertFalse(client.not_found("homeassistant__HassTurnOff", err))
        self.assertFalse(client.not_found("my_custom__write", {"error": conv.NOT_FOUND}))
        self.assertFalse(client.not_found("homeassistant__GetLiveContext", {"error": "Some other failure"}))
        self.assertFalse(client.not_found("homeassistant__HassGetState", {"error": "tool_result_unconfirmed"}))


class ToolResultContentKwargsTests(unittest.TestCase):
    def test_old_dataclass_uses_tool_result_dict(self):
        payload = {"success": True}
        with patch.object(conv.conversation, "ToolResultContent", OldToolResultContent):
            kw = conv.tool_result_content_kwargs(payload)
            self.assertEqual(kw, {"tool_result": payload})
            OldToolResultContent(agent_id="a", tool_call_id="1", tool_name="t", **kw)

    def test_new_dataclass_uses_toolresult(self):
        with patch.object(conv.conversation, "ToolResultContent", NewToolResultContent), \
             patch.object(conv.llm, "ToolResult", FakeToolResult, create=True):
            kw = conv.tool_result_content_kwargs({"success": True})
            self.assertEqual(list(kw), ["result"])
            self.assertEqual(kw["result"], FakeToolResult({"success": True}, False))
            NewToolResultContent(agent_id="a", tool_call_id="1", tool_name="t", **kw)

    def test_installed_ha_dataclass_accepts_kwargs(self):
        # Real installed HA (2026.9.4 gate venv, 2026.10.2 compat venv): construction must work.
        kw = conv.tool_result_content_kwargs({"success": True})
        conv.conversation.ToolResultContent(agent_id="a", tool_call_id="1", tool_name="t", **kw)


if __name__ == "__main__":
    unittest.main()
