"""Offline only: actual aiohttp loopback wire + simulated HA callbacks. No live HA imports."""
import asyncio
import importlib.util
import json
import pathlib
import unittest
from types import SimpleNamespace

from aiohttp import web

HERE = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("offtangent_test_client", HERE / "custom_components/offtangent_conversation/client.py")
client = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = client
spec.loader.exec_module(client)
MODEL = "claude-haiku-5-5"
NAME = "homeassistant__HassTurnOff"
TOOLS = [{"type": "function", "function": {"name": NAME, "description": "Synthetic tool",
          "parameters": {"type": "object", "properties": {"name": {"type": "string"}}}}}]
SUCCESS = {"response_type": "action_done", "data": {"success": [{"id": "synthetic"}], "failed": []}}
CALL = {"id": "call_synthetic", "type": "function", "function": {"name": NAME, "arguments": '{"name":"simulated"}'}}


def envelope(message=None, finish=None):
    message = message or {"role": "assistant", "content": "Antwort."}
    return {"model": MODEL, "choices": [{"index": 0, "message": message,
            "finish_reason": finish or ("tool_calls" if message.get("tool_calls") else "stop")}]}


def tool_reply(calls=None):
    return {"role": "assistant", "content": None, "tool_calls": calls or [CALL.copy()]}


class FakeClient:
    def __init__(self, replies):
        self.replies = replies
        self.requests = []

    async def complete(self, messages, tools, session=None):
        self.requests.append(json.loads(json.dumps({"messages": messages, "tools": tools, "session": session})))
        response = self.replies.pop(0)
        return client.validate_reply(response, MODEL, tools)


class ValidationTests(unittest.TestCase):
    def test_generic_urls_require_tls_except_loopback(self):
        for url in ["https://adapter.example.invalid/v1", "http://127.0.0.1:8095/v1/", "http://[::1]:8095/v1",
                    "https://adapter.example.invalid/ha-relay/v1", "http://localhost:8095/ha-relay/v1/"]:
            self.assertEqual(client.validate_url(url), url.rstrip("/"))
        for url in ["http://private.invalid/v1", "https://user:pass@adapter.invalid/v1", "https://adapter.invalid/v1?a=b",
                    "https://adapter.invalid/v1#x", "https://adapter.invalid/v1?", "https://adapter.invalid/v1#",
                    "https://adapter.invalid/other", "https://adapter.invalid:bad/v1", "ftp://adapter.invalid/v1",
                    "https://adapter.invalid/ha-relay/../v1", "https://adapter.invalid/ha-relay/v1/other",
                    "https://adapter.invalid/v1\n", "http://127.0.0.1.evil.invalid/v1"]:
            with self.subTest(url=url), self.assertRaises(ValueError):
                client.validate_url(url)

    def test_duplicate_json_and_nonfinite_numbers_rejected(self):
        for data in ['{"a":1,"a":2}', '{"a":NaN}', '{"a":Infinity}', '{"a":1e999}', '{"a":-1e999}']:
            with self.assertRaises(ValueError):
                client.decode_json(data)

    def test_strict_batch_response_validation(self):
        valid = envelope(tool_reply())
        self.assertEqual(client.validate_reply(valid, MODEL, TOOLS).message, valid["choices"][0]["message"])
        variants = []
        for key, value in [("model", "different"), ("choices", []), ("choices", [valid["choices"][0]] * 2)]:
            variant = json.loads(json.dumps(valid)); variant[key] = value; variants.append(variant)
        for message in [{"role": "assistant", "content": "partial"},
                        {"role": "user", "content": "text"},
                        {"role": "assistant", "content": "answer", "reasoning_content": "private"},
                        {"role": "assistant", "content": None},
                        tool_reply([CALL.copy(), CALL.copy()])]:
            variants.append(envelope(message, "length" if message.get("content") == "partial" else None))
        for args in ['{"name":"x","name":"y"}', '{"name":NaN}', '{"name":1e999}', '[]', '{bad', '"x"']:
            call = json.loads(json.dumps(CALL)); call["function"]["arguments"] = args
            variants.append(envelope(tool_reply([call])))
        call = json.loads(json.dumps(CALL)); call["function"]["name"] = "shell__exec"
        variants.append(envelope(tool_reply([call])))
        for variant in variants:
            with self.subTest(variant=variant), self.assertRaises(client.AdapterError):
                client.validate_reply(variant, MODEL, TOOLS)

    def test_missing_or_partial_success_is_not_confirmation(self):
        for result in [{}, {"success": True}, {"error": "ambiguous"}, {"success": False},
                       {"response_type": "action_done", "data": {"success": [], "failed": []}},
                       {"response_type": "action_done", "data": {"success": [1], "failed": [2]}},
                       {"response_type": "error", "data": {"code": "no_valid_targets"}},
                       {"response_type": "partial_action_done", "data": {"success": [1], "failed": []}}]:
            self.assertFalse(client.confirmed_result(NAME, result))
        self.assertTrue(client.confirmed_result(NAME, SUCCESS))
        self.assertTrue(client.confirmed_result("homeassistant__GetLiveContext", {"success": True, "result": "Synthetic context"}))
        self.assertFalse(client.confirmed_result("homeassistant__GetLiveContext", {"success": True}))


class EngineTests(unittest.IsolatedAsyncioTestCase):
    async def test_toolcall_result_final_is_sequential_and_success_derived_from_ha(self):
        f = FakeClient([{**envelope(tool_reply()), "ha_session": "synthetic-vault"}, envelope({"role": "assistant", "content": "Alles wurde ausgeschaltet, auch andere Geräte!"})])
        calls = []
        async def dispatch(cid, name, args):
            calls.append((cid, name, args)); return SUCCESS
        result = await client.run_turn(f, "Nur HA sicher", "Simuliertes Licht aus", TOOLS, lambda n, a: a, dispatch)
        self.assertEqual(calls, [(CALL["id"], NAME, {"name": "simulated"})])
        self.assertEqual(len(f.requests), 1)
        self.assertEqual(json.loads(result.messages[-2]["content"]), SUCCESS)
        self.assertEqual(result.text, "Home Assistant hat die Aktion bestätigt.")
        self.assertNotIn("andere Geräte", result.text)
        self.assertFalse(result.failed)

    async def test_query_reply_and_clarification_execute_nothing(self):
        for text in ["Welches Licht meinst du?", "Ich bin nicht sicher."]:
            f = FakeClient([envelope({"role": "assistant", "content": text})])
            async def no_dispatch(*args):
                self.fail("No action expected")
            result = await client.run_turn(f, "Sicher", "Licht", TOOLS, lambda n, a: a, no_dispatch)
            self.assertEqual(result.text, text)

    async def test_all_batch_arguments_validated_before_any_execution(self):
        call2 = json.loads(json.dumps(CALL)); call2["id"] = "second"; call2["function"]["arguments"] = '{"name":5}'
        f = FakeClient([envelope(tool_reply([CALL, call2]))])
        dispatched = []
        def validate(name, args):
            if not isinstance(args["name"], str):
                raise ValueError("bad_slot")
            return args
        async def dispatch(*args):
            dispatched.append(args); return SUCCESS
        with self.assertRaises(ValueError):
            await client.run_turn(f, "Sicher", "Licht aus", TOOLS, validate, dispatch)
        self.assertEqual(dispatched, [])

    async def test_errors_ambiguity_missing_success_stop_followup_and_retry(self):
        errors = [{"error": "ambiguous"}, {}, {"success": False}, {"response_type": "error", "data": {"code": "no_valid_targets"}},
                  {"response_type": "action_done", "data": {"success": [1], "failed": [2]}}]
        for error in errors:
            call2 = json.loads(json.dumps(CALL)); call2["id"] = "second"; call2["function"]["arguments"] = '{"name":"other"}'
            f = FakeClient([envelope(tool_reply([CALL, call2]))])
            dispatched = []
            async def dispatch(*args):
                dispatched.append(args); return error
            result = await client.run_turn(f, "Sicher", "Licht", TOOLS, lambda n, a: a, dispatch)
            self.assertTrue(result.failed)
            self.assertIn("nicht eindeutig bestätigt", result.text)
            self.assertEqual(len(dispatched), 1)
            self.assertEqual(len(f.requests), 1)

    async def test_action_timeout_is_unconfirmed_never_retry(self):
        f = FakeClient([envelope(tool_reply())])
        count = 0
        async def dispatch(*args):
            nonlocal count; count += 1; raise TimeoutError()
        result = await client.run_turn(f, "Sicher", "Licht", TOOLS, lambda n, a: a, dispatch)
        self.assertTrue(result.failed); self.assertEqual(count, 1); self.assertEqual(len(f.requests), 1)

    async def test_repeated_action_blocked_even_with_new_call_id(self):
        second = json.loads(json.dumps(CALL)); second["id"] = "fresh-id"
        f = FakeClient([envelope(tool_reply()), envelope(tool_reply([second]))])
        count = 0
        async def dispatch(*args):
            nonlocal count; count += 1; return SUCCESS
        result = await client.run_turn(f, "Sicher", "Licht", TOOLS, lambda n, a: a, dispatch)
        self.assertEqual(count, 1)
        self.assertEqual(len(f.requests), 1)  # A repeated model command is never requested.
        self.assertFalse(result.failed)

    async def test_cancellation_does_not_dispatch_again_or_request_followup(self):
        f = FakeClient([envelope(tool_reply())])
        async def dispatch(*args):
            raise asyncio.CancelledError()
        with self.assertRaises(asyncio.CancelledError):
            await client.run_turn(f, "Sicher", "Licht", TOOLS, lambda n, a: a, dispatch)
        self.assertEqual(len(f.requests), 1)

    async def test_query_datetime_and_enum_serialization_preserves_information(self):
        from datetime import date, datetime, time, timezone
        from enum import Enum
        class Unit(Enum):
            CELSIUS = "°C"
        name = "homeassistant__HassGetCurrentDate"
        tool = {"type": "function", "function": {**TOOLS[0]["function"], "name": name}}
        call = {**CALL, "function": {"name": name, "arguments": "{}"}}
        f = FakeClient([envelope(tool_reply([call])), envelope({"role": "assistant", "content": "Der simulierte Tag ist der 10. Oktober."})])
        async def dispatch(*args):
            return {"response_type": "query_answer", "data": {"failed": [], "date": date(2026, 10, 10),
                "timestamp": datetime(2026, 10, 10, 12, 0, tzinfo=timezone.utc), "time": time(12, 0), "unit": Unit.CELSIUS}}
        outcome = await client.run_turn(f, "Sicher", "Datum?", [tool], lambda n, a: a, dispatch)
        self.assertFalse(outcome.failed)
        self.assertEqual(outcome.text, "Der simulierte Tag ist der 10. Oktober.")
        self.assertEqual(len(f.requests), 2)
        payload = client.decode_json(outcome.messages[3]["content"])
        self.assertEqual(payload["data"], {"failed": [], "date": "2026-10-10", "timestamp": "2026-10-10T12:00:00+00:00", "time": "12:00:00", "unit": "°C"})
        self.assertNotIn("Aktion bestätigt", outcome.text)

    async def test_unknown_result_type_is_unconfirmed_without_followup(self):
        f = FakeClient([envelope(tool_reply())])
        async def dispatch(*args):
            return {**SUCCESS, "unknown": object()}
        progress = client.TurnProgress()
        result = await client.run_turn(f, "Sicher", "Simulierte Aktion", TOOLS, lambda n, a: a, dispatch, progress=progress)
        self.assertTrue(progress.dispatched)
        self.assertTrue(result.failed)
        self.assertEqual(len(f.requests), 1)
        self.assertIn("nicht eindeutig bestätigt", result.text)

    async def test_readcontext_tool_roundtrip_uses_result_not_action_confirmation(self):
        tool = {"type": "function", "function": {**TOOLS[0]["function"], "name": "homeassistant__GetLiveContext"}}
        call = {**CALL, "function": {"name": tool["function"]["name"], "arguments": "{}"}}
        f = FakeClient([envelope(tool_reply([call])), envelope({"role": "assistant", "content": "Das simulierte Licht ist aus."})])
        async def dispatch(*args):
            return {"success": True, "result": "Synthetic light off"}
        result = await client.run_turn(f, "Sicher", "Status?", [tool], lambda n, a: a, dispatch)
        self.assertEqual(result.text, "Das simulierte Licht ist aus.")


class HTTPTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.posts = []
        self.discards = []
        self.mode = "ok"
        self.received = asyncio.Event()
        async def models(request):
            return web.json_response({"data": [{"id": MODEL}]})
        async def complete(request):
            self.posts.append({"headers": dict(request.headers), "body": await request.json()})
            self.received.set()
            if self.mode == "429":
                return web.json_response({"secret": "must-not-leak"}, status=429)
            if self.mode == "503":
                return web.json_response({"error": "anthropic_subscription_auth_blocked"}, status=503)
            if self.mode == "redirect":
                return web.Response(status=302, headers={"Location": "https://must-not-follow.invalid/v1"})
            if self.mode == "slow":
                await asyncio.sleep(1.5)
            if self.mode == "oversized":
                return web.Response(text='{"padding":"' + "x" * 262145 + '"}', content_type="application/json")
            if self.mode == "truncated":
                return web.json_response(envelope({"role": "assistant", "content": "partial"}, "length"))
            if len(self.posts) == 1:
                return web.json_response({**envelope(tool_reply()), "ha_session": "synthetic-session"})
            return web.json_response(envelope({"role": "assistant", "content": "Simulation bestätigt."}))
        async def discard(request):
            self.discards.append(await request.json())
            return web.json_response({"discarded": True})
        app = web.Application(); app.router.add_get("/v1/models", models); app.router.add_post("/v1/chat/completions", complete); app.router.add_post("/v1/session/discard", discard)
        self.runner = web.AppRunner(app); await self.runner.setup()
        self.site = web.TCPSite(self.runner, "127.0.0.1", 0); await self.site.start()
        port = self.site._server.sockets[0].getsockname()[1]
        self.adapter = client.AdapterClient(f"http://127.0.0.1:{port}/v1", "synthetic-test-token-not-real", MODEL, timeout=1)

    async def asyncTearDown(self):
        await self.adapter.close(); await self.runner.cleanup()

    async def test_actual_aiohttp_simulated_toolcall_result_final_wire(self):
        await self.adapter.check_model()
        async def dispatch(*args):
            return SUCCESS
        result = await client.run_turn(self.adapter, "German prompt", "Simulated action", TOOLS, lambda n, a: a, dispatch)
        self.assertEqual(result.text, "Home Assistant hat die Aktion bestätigt.")
        self.assertEqual(len(self.posts), 1)
        self.assertEqual(self.posts[0]["body"]["model"], MODEL)
        self.assertFalse(self.posts[0]["body"]["stream"])
        self.assertIsNone(result.session)  # Successful action vault is closed; no completion replay.
        self.assertEqual(self.discards, [{"ha_session": "synthetic-session"}])
        self.assertEqual(self.posts[0]["headers"]["Authorization"], "Bearer synthetic-test-token-not-real")
        for forbidden in ["temperature", "reasoning_effort", "agent", "user", "max_tokens"]:
            self.assertNotIn(forbidden, self.posts[0]["body"])

    async def test_429_authblock_and_redirect_have_one_attempt_no_body_leak(self):
        for mode in ["429", "503", "redirect"]:
            self.mode = mode; self.posts.clear()
            with self.assertRaises(client.AdapterError) as err:
                await self.adapter.complete([], TOOLS)
            self.assertNotIn("must-not-leak", str(err.exception)); self.assertEqual(len(self.posts), 1)

    async def test_timeout_has_one_attempt(self):
        self.mode = "slow"
        with self.assertRaisesRegex(client.AdapterError, "adapter_unavailable"):
            await self.adapter.complete([], TOOLS)
        self.assertEqual(len(self.posts), 1)

    async def test_cancelled_http_does_not_retry(self):
        self.mode = "slow"
        task = asyncio.create_task(self.adapter.complete([], TOOLS))
        await self.received.wait(); task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(len(self.posts), 1)

    async def test_oversized_and_truncated_response_never_expose_partial_action(self):
        for mode in ["oversized", "truncated"]:
            self.mode = mode; self.posts.clear()
            with self.assertRaises(client.AdapterError):
                await self.adapter.complete([], TOOLS)
            self.assertEqual(len(self.posts), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
