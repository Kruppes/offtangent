"""keep_alive option and keep-warm timeout of the local Ollama path.

The timeout tests use a slow aiohttp server on 127.0.0.1 (loopback only, no LAN): the turn timeout
must still cut a user request, while the keep-warm ping gets its own, longer budget.
"""
import asyncio
import json
import logging
from pathlib import Path
import sys
import unittest

from aiohttp import web

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from custom_components.offtangent_conversation import config_flow, const, ollama  # noqa: E402
from custom_components.offtangent_conversation.client import AdapterError  # noqa: E402
import test_ollama_primary as primary  # noqa: E402  (module import: its TestCases are not collected twice)
from test_ollama_primary import LOCAL, TOOLS, o_call, o_reply  # noqa: E402

FLOW = {"url": "https://example.invalid/v1", "adapter_token": "x" * 24, "model": "another-model-1",
        "control": True, "allowed_tools": '["homeassistant__HassTurnOff"]', "local_url": "http://127.0.0.1:11434"}


class KeepAliveOptionTests(unittest.TestCase):
    def test_parse_keep_alive_accepts_durations_and_minus_one(self):
        for value, expected in (("15m", "15m"), ("1h", "1h"), ("90s", "90s"), ("500ms", "500ms"), (" 30m ", "30m"),
                                ("-1", -1), (-1, -1), ("0", 0), (0, 0)):
            with self.subTest(value=value):
                self.assertEqual(ollama.parse_keep_alive(value), expected)

    def test_parse_keep_alive_rejects_everything_else(self):
        for value in ("", "15", "-2", "15 m", "1d", "m", "01m", "15m;", True, None, 1.5, "1234567m", {"a": 1}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                ollama.parse_keep_alive(value)

    def test_client_default_is_15m_and_minus_one_stays_possible(self):
        self.assertEqual(const.DEFAULT_KEEP_ALIVE, "15m")

        async def build():
            default = ollama.OllamaClient("http://127.0.0.1:1", LOCAL)
            forever = ollama.OllamaClient("http://127.0.0.1:1", LOCAL, keep_alive="-1")
            try:
                return (default.payload([], TOOLS)["keep_alive"], forever.payload([], TOOLS)["keep_alive"],
                        default.warm_timeout, default.timeout)
            finally:
                await default.close()
                await forever.close()
        self.assertEqual(asyncio.run(build()), ("15m", -1, 60, 20))

    def test_client_rejects_bad_keep_alive_and_warm_timeout(self):
        async def build(**kwargs):
            ollama.OllamaClient("http://127.0.0.1:1", LOCAL, **kwargs)
        for kwargs in ({"keep_alive": "forever"}, {"warm_timeout": 0}, {"warm_timeout": 301}, {"warm_timeout": True},
                       {"warm_timeout": "60"}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                asyncio.run(build(**kwargs))

    def test_flow_validates_keep_alive_and_offers_it_with_default(self):
        config_flow._validate(FLOW)  # option missing (entries from 0.1.0): accepted, default applies
        for value in ("15m", "-1", "0", "2h", ""):
            with self.subTest(value=value):
                config_flow._validate({**FLOW, "local_keep_alive": value})
        for value in ("forever", "15", "-5"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                config_flow._validate({**FLOW, "local_keep_alive": value})
        defaults = {str(k): k.default() for k in config_flow._schema({}).schema if str(k) == "local_keep_alive"}
        self.assertEqual(defaults, {"local_keep_alive": "15m"})
        kept = {str(k): k.default() for k in config_flow._schema({"local_keep_alive": -1}).schema
                if str(k) == "local_keep_alive"}
        self.assertEqual(kept, {"local_keep_alive": "-1"})

    def test_options_strings_and_translation_carry_the_new_field(self):
        base = Path(config_flow.__file__).parent
        for name in ("strings.json", "translations/de.json"):
            data = json.loads((base / name).read_text())
            with self.subTest(file=name):
                self.assertIn("local_keep_alive", data["config"]["step"]["user"]["data"])
                self.assertIn("local_keep_alive", data["options"]["step"]["init"]["data"])
        self.assertEqual(json.loads((base / "manifest.json").read_text())["version"], "0.2.0")


class SlowOllama:
    """Loopback /api/chat that answers after `delay` seconds and records each request body."""

    def __init__(self, delay):
        self.delay, self.bodies = delay, []

    async def __aenter__(self):
        async def chat(request):
            self.bodies.append(await request.json())
            await asyncio.sleep(self.delay)
            return web.json_response(o_reply("ok", prompt_eval_count=5882))
        app = web.Application()
        app.router.add_post("/api/chat", chat)
        self.runner = web.AppRunner(app)
        await self.runner.setup()
        site = web.TCPSite(self.runner, "127.0.0.1", 0)
        await site.start()
        self.url = "http://127.0.0.1:%d" % site._server.sockets[0].getsockname()[1]
        return self

    async def __aexit__(self, *exc):
        await self.runner.cleanup()


class WarmTimeoutTests(unittest.IsolatedAsyncioTestCase):
    async def test_warm_ping_outlives_the_turn_timeout(self):
        async with SlowOllama(1.5) as server:
            client = ollama.OllamaClient(server.url, LOCAL, timeout=1, warm_timeout=5)
            try:
                with self.assertRaises(AdapterError) as err:  # user turn: still cut at local_timeout
                    await client.complete([{"role": "user", "content": "u"}], TOOLS)
                self.assertEqual(str(err.exception), "ollama_timeout")
                timing = await client.warm("system", TOOLS)  # same session, own budget
            finally:
                await client.close()
        self.assertEqual(timing["prompt_eval_count"], 5882)
        self.assertGreaterEqual(timing["wall_ms"], 1400)
        warm_body = server.bodies[-1]
        self.assertEqual((warm_body["keep_alive"], warm_body["options"]["num_predict"]), ("15m", 1))

    async def test_warm_ping_past_its_budget_reports_timeout(self):
        async with SlowOllama(2) as server:
            client = ollama.OllamaClient(server.url, LOCAL, timeout=5, warm_timeout=1)
            try:
                with self.assertRaises(AdapterError) as err:
                    await client.warm("system", TOOLS)
            finally:
                await client.close()
        self.assertEqual(str(err.exception), "ollama_timeout")


class KeepWarmLoggingTests(primary.OllamaPrimaryEntityTests):
    """Reuses the real-HA entity fixture; only the keep-warm failure path is exercised here."""

    async def test_failed_ping_logs_debug_not_warning_and_lands_in_turn_log(self):
        agent, relay = self.primary([o_reply(calls=[o_call()]), o_reply("Das Licht ist aus.")])
        await agent._async_handle_message(self.input, self.log())

        async def warm(prompt, tools):
            raise AdapterError("ollama_timeout")
        relay.local.warm = warm
        logger = logging.getLogger("custom_components.offtangent_conversation.conversation")
        with self.assertNoLogs(logger, level=logging.INFO):
            await agent._keep_warm()
        with self.assertLogs(logger, level=logging.DEBUG) as logs:
            await agent._keep_warm()
        self.assertTrue(any("Keep-warm ping" in line and "ollama_timeout" in line for line in logs.output))
        recs = await self.records()
        self.assertEqual([r.get("error") for r in recs if r["kind"] == "warm"], ["ollama_timeout", "ollama_timeout"])

    async def _slow_warm(self, relay):
        """Install a keep-warm ping that hangs (like a cold 60 s ping) until cancelled."""
        state = {"started": asyncio.Event(), "cancelled": False, "calls": 0}

        async def warm(prompt, tools):
            state["calls"] += 1
            state["started"].set()
            try:
                await asyncio.sleep(60)
            except asyncio.CancelledError:
                state["cancelled"] = True
                raise
            return {"prompt_eval_count": 1}
        relay.local.warm = warm
        return state

    async def test_turn_cancels_a_running_ping_instead_of_waiting_for_it(self):
        agent, relay = self.primary([o_reply(calls=[o_call()]), o_reply("Das Licht ist aus."),
                                     o_reply(calls=[o_call()]), o_reply("Das Licht ist aus.")])
        await agent._async_handle_message(self.input, self.log())  # first local turn: gives the warm payload
        state = await self._slow_warm(relay)
        ping = asyncio.create_task(agent._keep_warm())
        await asyncio.wait_for(state["started"].wait(), 5)

        await agent._keep_warm()  # a second ping while one runs is skipped, not stacked
        self.assertEqual(state["calls"], 1)

        loop = asyncio.get_running_loop()
        started = loop.time()
        result = await asyncio.wait_for(agent._async_handle_message(self.input, self.log()), 5)
        self.assertLess(loop.time() - started, 2)  # did not wait for the 60 s ping
        self.assertEqual(result.response.speech["plain"]["speech"], "Das Licht ist aus.")
        await asyncio.wait_for(ping, 5)  # the interval callback ends cleanly, no exception
        self.assertTrue(state["cancelled"])
        self.assertIsNone(agent._warm_task)
        recs = await self.records()
        self.assertEqual([r.get("error") for r in recs if r["kind"] == "warm"], ["preempted_by_turn"])
        self.assertEqual([r["path"] for r in recs if r["kind"] == "agent"], ["ollama", "ollama"])

    async def test_outer_cancel_of_the_ping_still_propagates(self):
        agent, relay = self.primary([o_reply(calls=[o_call()]), o_reply("Das Licht ist aus.")])
        await agent._async_handle_message(self.input, self.log())
        state = await self._slow_warm(relay)
        ping = asyncio.create_task(agent._keep_warm())
        await asyncio.wait_for(state["started"].wait(), 5)
        ping.cancel()  # e.g. HA shutdown: not a turn preemption, must not be swallowed
        with self.assertRaises(asyncio.CancelledError):
            await ping
        self.assertTrue(state["cancelled"])
        self.assertIsNone(agent._warm_task)
        recs = await self.records()
        self.assertEqual([r for r in recs if r["kind"] == "warm"], [])

    async def _assert_outer_cancel_propagates(self, cancel_in_order):
        agent, relay = self.primary([o_reply(calls=[o_call()]), o_reply("Das Licht ist aus.")])
        await agent._async_handle_message(self.input, self.log())
        state = await self._slow_warm(relay)
        ping = asyncio.create_task(agent._keep_warm())
        await asyncio.wait_for(state["started"].wait(), 5)
        cancel_in_order(agent, ping)  # both in the same loop tick, before the ping resumes
        with self.assertRaises(asyncio.CancelledError):
            await asyncio.wait_for(ping, 5)
        self.assertTrue(state["cancelled"])
        self.assertIsNone(agent._warm_task)
        self.assertEqual(agent._warm_preempted_tasks, set())  # no mark leaks into the next ping
        recs = await self.records()
        self.assertEqual([r for r in recs if r["kind"] == "warm"], [])

    async def test_outer_cancel_right_after_a_preemption_still_propagates(self):
        def preempt_then_cancel(agent, ping):
            agent._preempt_warm()  # a user turn starts ...
            ping.cancel()  # ... and HA shuts down before the ping callback resumed
        await self._assert_outer_cancel_propagates(preempt_then_cancel)

    async def test_preemption_right_after_an_outer_cancel_does_not_swallow_it(self):
        def cancel_then_preempt(agent, ping):
            ping.cancel()
            agent._preempt_warm()
        await self._assert_outer_cancel_propagates(cancel_then_preempt)

    async def test_a_preemption_mark_does_not_carry_over_to_the_next_ping(self):
        agent, relay = self.primary([o_reply(calls=[o_call()]), o_reply("Das Licht ist aus.")])
        await agent._async_handle_message(self.input, self.log())
        state = await self._slow_warm(relay)
        first = asyncio.create_task(agent._keep_warm())
        await asyncio.wait_for(state["started"].wait(), 5)
        agent._preempt_warm()
        await asyncio.wait_for(first, 5)  # preempted: ends cleanly
        state["started"].clear()
        second = asyncio.create_task(agent._keep_warm())
        await asyncio.wait_for(state["started"].wait(), 5)
        second.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await asyncio.wait_for(second, 5)
        recs = await self.records()
        self.assertEqual([r.get("error") for r in recs if r["kind"] == "warm"], ["preempted_by_turn"])


# Only the new test above runs from the inherited fixture class; its own tests run in their module.
for _name in [n for n in dir(primary.OllamaPrimaryEntityTests) if n.startswith("test_")]:
    setattr(KeepWarmLoggingTests, _name, None)


if __name__ == "__main__":
    unittest.main()
