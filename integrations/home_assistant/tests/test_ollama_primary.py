"""Variant B: native Ollama primary path through run_turn, relay takes over only before dispatch.

Actual HA classes, isolated instance, ONLY simulated tools and a simulated Ollama. No network.
"""
import json
import os
from dataclasses import replace
import time
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from custom_components.offtangent_conversation import ollama, turnlog  # noqa: E402
from custom_components.offtangent_conversation.client import AdapterError, run_turn, TurnProgress  # noqa: E402
from test_entity_runtime import (ActualHAEntityTests, LIVE, LiveContextTool, MockAdapter, NAME, SUCCESS,
                                 call, reply)  # noqa: E402

LOCAL = "gemma4:12b-mlx"
TOOLS = [{"type": "function", "function": {"name": NAME, "description": "x", "parameters": {"type": "object"}}}]


def o_reply(content="", calls=None, done_reason="stop", **timings):
    msg = {"role": "assistant", "content": content}
    if calls:
        msg["tool_calls"] = calls
    base = {"total_duration": 900_000_000, "load_duration": 50_000_000, "prompt_eval_count": 3100,
            "prompt_eval_duration": 120_000_000, "eval_count": 18, "eval_duration": 400_000_000}
    base.update(timings)
    return {"model": LOCAL, "message": msg, "done": True, "done_reason": done_reason, **base}


def o_call(args=None, name=NAME, cid=None):
    item = {"function": {"name": name, "arguments": args or {"name": "{{secret:url-password-10}}"}}}
    if cid:
        item["id"] = cid
    return item


class MockOllama:
    """Same contract as OllamaClient.complete (validated Reply + metrics)."""

    def __init__(self, replies):
        self.replies = replies
        self.requests = []
        self.model = LOCAL

    async def complete(self, messages, tools, session=None, metrics=None):
        self.requests.append(json.loads(json.dumps({"messages": messages, "tools": tools})))
        item = self.replies.pop(0)
        if isinstance(item, Exception):
            raise item
        if metrics is not None:
            metrics.append({k: v for k, v in item.items() if k in ollama.TIMING_KEYS})
        return ollama.validate_ollama_reply(item, LOCAL, tools)


class OllamaWireTests(unittest.TestCase):
    def test_messages_convert_arguments_to_objects_and_name_tool_results(self):
        out = ollama.to_ollama_messages([
            {"role": "system", "content": "s"}, {"role": "user", "content": "u"},
            {"role": "assistant", "content": None, "tool_calls": [
                {"id": "c1", "type": "function", "function": {"name": NAME, "arguments": '{"name": "a"}'}}]},
            {"role": "tool", "tool_call_id": "c1", "content": '{"ok": 1}'}])
        self.assertEqual(out[2]["tool_calls"][0]["function"]["arguments"], {"name": "a"})
        self.assertEqual(out[3], {"role": "tool", "content": '{"ok": 1}', "tool_name": NAME})

    def test_payload_sets_keep_alive_num_ctx_think_off_per_request(self):
        client = ollama.OllamaClient.__new__(ollama.OllamaClient)
        client.model, client.num_ctx, client.keep_alive = LOCAL, 16384, -1
        body = client.payload([{"role": "user", "content": "u"}], TOOLS)
        self.assertEqual((body["keep_alive"], body["options"]["num_ctx"], body["think"], body["stream"]),
                         (-1, 16384, False, False))

    def test_reply_validation(self):
        r = ollama.validate_ollama_reply(o_reply(calls=[o_call()]), LOCAL, TOOLS)
        self.assertEqual(r.message["tool_calls"][0]["function"]["name"], NAME)
        self.assertTrue(r.message["tool_calls"][0]["id"].startswith("call_"))
        self.assertIsNone(r.message["content"])
        self.assertEqual(ollama.validate_ollama_reply(o_reply(" Hallo "), LOCAL, TOOLS).message["content"], "Hallo")
        for bad in (o_reply(calls=[o_call(name="shell__exec")]),   # tool not offered
                    o_reply("abgeschnitten", done_reason="length"),  # truncated answer never spoken
                    o_reply(""),                                     # empty answer
                    {**o_reply("x"), "model": "other"},              # wrong model
                    {**o_reply("x"), "done": False}):
            with self.assertRaises(AdapterError):
                ollama.validate_ollama_reply(bad, LOCAL, TOOLS)

    def test_stable_prompt_moves_clock_out_of_system_prompt(self):
        prompt = "A\nStatic Context: x\nCurrent time is 23:04:05. Today's date is 2026-10-21.\n"
        stable, line = ollama.stable_prompt(prompt)
        self.assertEqual(stable, "A\nStatic Context: x\n")
        self.assertEqual(line, "Current time is 23:04:05. Today's date is 2026-10-21.")
        self.assertEqual(ollama.stable_prompt("no clock"), ("no clock", None))

    def test_compact_prompt_one_line_per_device_head_unchanged(self):
        head = "Du bist ein Assistent.\nRegeln.\n"
        prompt = (head + "Static Context: An overview of the areas and the devices in this smart home:\n"
                  "- names: Yeelight Büro, Deckenlicht Büro\n  domain: light\n  areas: Büro\n"
                  "- names: Alle Rolläden\n  domain: cover\n\nWhen controlling Home Assistant always call the intent tool")
        out = ollama.compact_prompt(prompt)
        self.assertTrue(out.startswith(head))  # cached prompt start unchanged
        self.assertIn("- Yeelight Büro, Deckenlicht Büro (light, Büro)\n- Alle Rolläden (cover)\n"
                      + ollama.LOCAL_HINTS + "\n\nWhen controlling", out)
        self.assertIn("Aliase EINES Geräts", out)
        self.assertNotIn("names:", out)
        self.assertLess(len(out) - len(ollama.LOCAL_HINTS), len(prompt))
        # Unknown shape: left exactly as it is, nothing guessed.
        odd = prompt.replace("  areas: Büro", "  something odd")
        self.assertEqual(ollama.compact_prompt(odd), odd)
        self.assertEqual(ollama.compact_prompt("no context"), "no context")

    def test_compact_tools_keep_names_order_and_parameters(self):
        long = "Provides real-time information about the CURRENT state of devices. " + "Use this tool for many things. " * 10
        tools = [{"type": "function", "function": {"name": "a__X", "description": long, "parameters": {
                     "type": "object", "required": ["q"], "properties": {"q": {"type": "string", "description": long}}}}},
                 {"type": "function", "function": {"name": "b__Y", "description": "Short.", "parameters": {"type": "object", "properties": {}}}}]
        out = ollama.compact_tools(tools)
        self.assertEqual([t["function"]["name"] for t in out], ["a__X", "b__Y"])
        self.assertLessEqual(len(out[0]["function"]["description"]), ollama.DESC_MAX)
        self.assertTrue(out[0]["function"]["description"].endswith("."))
        self.assertEqual(out[0]["function"]["parameters"]["required"], ["q"])
        self.assertEqual(set(out[0]["function"]["parameters"]["properties"]), {"q"})
        self.assertEqual(out[1], tools[1])
        self.assertEqual(len(tools[0]["function"]["description"]), len(long))  # input untouched

    def test_config_rejects_cloud_models_and_bad_urls(self):
        for url, model in (("http://h:11434", "gemma4:31b-cloud"), ("http://u:p@h:11434", LOCAL),
                           ("ftp://h", LOCAL), ("http://h:11434/api", LOCAL)):
            with self.assertRaises(ValueError):
                ollama.OllamaClient(url, model)


class OllamaRunTurnTests(unittest.IsolatedAsyncioTestCase):
    async def test_metered_turn_collects_timings_per_call(self):
        local = MockOllama([o_reply(calls=[o_call()]), o_reply("Ist aus.")])
        metered = ollama.MeteredTurn(local)
        progress = TurnProgress()

        async def dispatch(cid, name, args):
            return SUCCESS
        out = await run_turn(metered, "s", "Licht aus", TOOLS, lambda n, a: a, dispatch, progress=progress)
        self.assertTrue(progress.dispatched)
        self.assertEqual(len(metered.calls), 2)
        summary = turnlog.summarize_ollama(metered.calls)
        self.assertEqual((summary["prompt_eval_s_first"], summary["eval_s"], summary["prompt_tokens_first"]),
                         (0.12, 0.8, 3100))
        self.assertTrue(out.text)


class OllamaPrimaryEntityTests(unittest.IsolatedAsyncioTestCase):
    agent, log, asyncTearDown_base = ActualHAEntityTests.agent, ActualHAEntityTests.log, ActualHAEntityTests.asyncTearDown

    async def asyncSetUp(self):
        await ActualHAEntityTests.asyncSetUp(self)
        self.logdir = tempfile.TemporaryDirectory(dir=self.temp.name)
        await self.real_world()

    async def real_world(self):
        """Real HA registries + exposure for the local-path guard: one exposed light whose name is
        the synthetic tool argument (Flur, EG), a kitchen light, an unassigned switch."""
        from homeassistant.components import conversation
        from homeassistant.components.homeassistant import exposed_entities
        from homeassistant.components.homeassistant.const import DATA_EXPOSED_ENTITIES
        from homeassistant.helpers import area_registry as ar, device_registry as dr
        from homeassistant.helpers import entity_registry as er, floor_registry as fr
        dr.async_setup(self.hass)
        for registry in (fr, ar, dr, er):
            await registry.async_load(self.hass, load_empty=True)
        eg = fr.async_get(self.hass).async_create("Erdgeschoss", aliases={"EG"})
        areas = ar.async_get(self.hass)
        flur = areas.async_create("Flur", floor_id=eg.floor_id)
        kueche = areas.async_create("Küche", floor_id=eg.floor_id)
        store = exposed_entities.ExposedEntities(self.hass)
        await store.async_initialize()
        self.hass.data[DATA_EXPOSED_ENTITIES] = store
        ents = er.async_get(self.hass)
        for domain, uid, name, area in (("light", "flur", o_call()["function"]["arguments"]["name"], flur),
                                        ("light", "kueche", "Küchenlicht", kueche),
                                        ("switch", "keller", "Licht Keller Unterbau", None)):
            entry = ents.async_get_or_create(domain, "test", uid, suggested_object_id=uid, original_name=name)
            if area is not None:
                ents.async_update_entity(entry.entity_id, area_id=area.id)
            self.hass.states.async_set(entry.entity_id, "on", {"friendly_name": name})
            exposed_entities.async_expose_entity(self.hass, conversation.DOMAIN, entry.entity_id, True)

    async def asyncTearDown(self):
        await self.hass.async_block_till_done()
        self.logdir.cleanup()
        await self.asyncTearDown_base()

    def primary(self, local_replies, relay_replies=()):
        relay = MockAdapter(list(relay_replies))
        relay.local = MockOllama(list(local_replies))
        relay.turn_log_dir = self.logdir.name
        return self.agent(relay), relay

    async def records(self):
        await self.hass.async_block_till_done()
        files = list(Path(self.logdir.name).rglob("turns-*.jsonl"))
        return [json.loads(line) for f in files for line in f.read_text().splitlines()]

    async def test_local_success_runs_tool_once_relay_untouched_and_logs_timings(self):
        agent, relay = self.primary([o_reply(calls=[o_call()]), o_reply("Das Licht ist aus.")])
        old_tz = os.environ.get("TZ")
        os.environ["TZ"] = "Europe/Berlin"  # non-UTC host zone: the agent record must still be UTC
        time.tzset()
        try:
            result = await agent._async_handle_message(self.input, self.log())
        finally:
            if old_tz is None:
                os.environ.pop("TZ", None)
            else:
                os.environ["TZ"] = old_tz
            time.tzset()
        self.assertEqual(len(self.tool.calls), 1)
        self.assertEqual(relay.requests, [])
        self.assertEqual(agent._last_path, "ollama")
        system = relay.local.requests[0]["messages"][0]["content"]
        self.assertNotIn("Current time is", system)  # stable prefix for the prompt cache
        self.assertIn("Current time is", relay.local.requests[0]["messages"][-1]["content"])
        self.assertTrue(result.response.speech["plain"]["speech"])
        recs = await self.records()
        self.assertEqual(len(recs), 1)
        rec = recs[0]
        self.assertEqual((rec["kind"], rec["path"], rec["model"], rec["text"]),
                         ("agent", "ollama", LOCAL, self.input.text))
        self.assertTrue(rec["ts"].endswith("+00:00"))  # UTC, same as the pipeline records
        self.assertEqual(rec["ollama"]["calls"], 2)
        self.assertEqual(rec["ollama"]["prompt_eval_s_first"], 0.12)
        self.assertEqual(rec["tools"][0]["name"], NAME)
        self.assertEqual(rec["tools"][0]["arguments"], {"name": "{{secret:url-password-10}}"})
        self.assertIn("success", rec["tools"][0]["result"])
        self.assertEqual(rec["answer"], result.response.speech["plain"]["speech"])

    async def test_guard_real_ha_exception_area_fed_back_never_dispatched(self):
        self.input = replace(self.input, text="Mach alle Lichter im Erdgeschoss aus, außer in der Küche.")
        both = [o_call(), o_call({"name": "Küchenlicht"}, cid="k")]
        agent, relay = self.primary([o_reply(calls=both), o_reply(calls=both)])
        result = await agent._async_handle_message(self.input, self.log())
        self.assertEqual(self.tool.calls, [])
        self.assertEqual(relay.requests, [])
        rec = (await self.records())[0]
        self.assertEqual([e["guard_blocked"] for e in rec["guard"]], ["feedback", "clarify"])
        self.assertIn("light.kueche", rec["guard"][0]["targets"])
        self.assertIn("nichts geschaltet", result.response.speech["plain"]["speech"])

    async def test_guard_real_ha_unknown_area_clarifies(self):
        self.input = replace(self.input, text="Mach das Licht in der Garage an.")
        agent, relay = self.primary([o_reply(calls=[o_call({"name": "Licht Keller Unterbau"})])])
        result = await agent._async_handle_message(self.input, self.log())
        self.assertEqual(self.tool.calls, [])
        self.assertIn("Garage", result.response.speech["plain"]["speech"])
        rec = (await self.records())[0]
        self.assertEqual(rec["guard"][0]["reason"], "unknown_area:Garage")

    async def test_guard_real_ha_confirm_then_yes_runs_held_batch(self):
        self.input = replace(self.input, text="Mach das Küchenlicht und das Kellerlicht aus.")
        two = [o_call({"name": "Küchenlicht"}, cid="a"), o_call({"name": "Licht Keller Unterbau"}, cid="b")]
        agent, relay = self.primary([o_reply(calls=two)])
        first = await agent._async_handle_message(self.input, self.log())
        self.assertEqual(self.tool.calls, [])
        self.assertTrue(first.response.speech["plain"]["speech"].endswith("Soll ich das machen?"))
        self.input = replace(self.input, text="Ja")
        await agent._async_handle_message(self.input, self.log())
        self.assertEqual(len(self.tool.calls), 2)
        self.assertEqual(len(relay.local.requests), 1)  # the "ja" runs the held batch, no model round
        recs = await self.records()
        self.assertEqual(recs[0]["guard"][0]["reason"], "multi_domain")
        self.assertTrue(recs[1]["guard"][0]["guard_confirmed"])

    async def test_keep_warm_reuses_last_local_prompt_and_tools(self):
        agent, relay = self.primary([o_reply(calls=[o_call()]), o_reply("Das Licht ist aus.")])
        warmed = []

        async def warm(prompt, tools):
            warmed.append((prompt, tools))
            return {"prompt_eval_count": 10, "wall_ms": 5}
        relay.local.warm = warm
        await agent._keep_warm()  # before the first local turn: nothing to warm
        self.assertEqual(warmed, [])
        await agent._async_handle_message(self.input, self.log())
        await agent._keep_warm()
        self.assertEqual(len(warmed), 1)
        sent = relay.local.requests[0]
        self.assertEqual(warmed[0][0], sent["messages"][0]["content"])  # identical prompt start
        self.assertEqual(warmed[0][1], sent["tools"])
        self.assertEqual(len(self.tool.calls), 1)  # the ping runs no tool
        recs = await self.records()
        self.assertEqual([r["kind"] for r in recs], ["agent", "warm"])
        self.assertEqual(recs[1]["prompt_eval_count"], 10)

    async def test_ollama_unreachable_relay_takes_over_before_dispatch(self):
        agent, relay = self.primary([AdapterError("ollama_unreachable")], [reply(calls=[call()]), reply()])
        await agent._async_handle_message(self.input, self.log())
        self.assertEqual(len(self.tool.calls), 1)
        self.assertEqual(len(relay.requests), 2)
        self.assertEqual(agent._last_path, "relay")
        self.assertEqual(agent._local_failures, 1)
        self.assertNotIn("Current time is", relay.requests[0]["messages"][-1]["content"])
        rec = (await self.records())[0]
        self.assertEqual((rec["path"], rec["local_error"]), ("relay", "ollama_unreachable"))

    async def test_ollama_timeout_relay_takes_over(self):
        agent, relay = self.primary([TimeoutError()], [reply()])
        await agent._async_handle_message(self.input, self.log())
        self.assertEqual(len(relay.requests), 1)
        self.assertEqual(agent._last_path, "relay")

    async def test_invalid_local_reply_falls_back_without_running_anything(self):
        agent, relay = self.primary([o_reply(calls=[o_call(name="shell__exec")])], [reply()])
        await agent._async_handle_message(self.input, self.log())
        self.assertEqual(self.tool.calls, [])
        self.assertEqual(len(relay.requests), 1)

    async def test_local_fault_after_confirmed_action_speaks_ha_confirmation_no_relay(self):
        agent, relay = self.primary([o_reply(calls=[o_call()]), AdapterError("ollama_timeout")], [reply()])
        result = await agent._async_handle_message(self.input, self.log())
        self.assertEqual(len(self.tool.calls), 1)  # exactly once, never repeated
        self.assertEqual(relay.requests, [])
        self.assertEqual(agent._last_path, "ollama")
        self.assertTrue(result.response.speech["plain"]["speech"])

    async def test_local_fault_after_lookup_never_reaches_relay(self):
        tool = LiveContextTool([{"success": True, "result": "- names: Flur\n  state: 'on'"}])
        self.api.tools[:] = [tool]
        relay = MockAdapter([reply()])
        relay.local = MockOllama([o_reply(calls=[o_call({"name": "Flur"}, name=LIVE)]),
                                  AdapterError("ollama_timeout")])
        relay.turn_log_dir = self.logdir.name
        agent = self.agent(relay, allowed=[LIVE])
        await agent._async_handle_message(self.input, self.log())
        self.assertEqual(len(tool.calls), 1)
        self.assertEqual(relay.requests, [])  # never repeat a dispatched turn on the relay
        self.assertEqual(agent._last_path, "ollama_failed_after_tool")
        rec = (await self.records())[0]
        self.assertEqual((rec["path"], rec["local_error"]), ("ollama_failed_after_tool", "ollama_timeout"))

    async def test_without_local_client_relay_path_is_unchanged(self):
        relay = MockAdapter([reply()])
        agent = self.agent(relay)
        await agent._async_handle_message(self.input, self.log())
        self.assertEqual(len(relay.requests), 1)
        self.assertEqual(agent._last_path, "relay")
        self.assertIsNone(agent._turn_log_dir)


class PipelineRecordTests(unittest.TestCase):
    def test_finished_voice_run_becomes_one_record(self):
        ev = [
            {"type": "run-start", "timestamp": "2026-10-22T01:00:00+00:00", "data": {"conversation_id": "c1"}},
            {"type": "stt-start", "timestamp": "2026-10-22T01:00:00.100000+00:00", "data": {"engine": "stt.x"}},
            {"type": "stt-end", "timestamp": "2026-10-22T01:00:01.300000+00:00", "data": {"stt_output": {"text": "Licht aus"}}},
            {"type": "intent-start", "timestamp": "2026-10-22T01:00:01.300000+00:00", "data": {"engine": "conversation.o", "intent_input": "Licht aus"}},
            {"type": "intent-end", "timestamp": "2026-10-22T01:00:02.100000+00:00", "data": {"processed_locally": True, "intent_output": {
                "conversation_id": "c1", "response": {"response_type": "action_done", "speech": {"plain": {"speech": "Aus"}}, "data": {}}}}},
            {"type": "tts-start", "timestamp": "2026-10-22T01:00:02.100000+00:00", "data": {"engine": "tts.x"}},
            {"type": "tts-end", "timestamp": "2026-10-22T01:00:02.400000+00:00", "data": {}},
            {"type": "run-end", "timestamp": "2026-10-22T01:00:02.500000+00:00", "data": None},
        ]
        rec = turnlog.pipeline_record("p", "r", ev)
        self.assertEqual((rec["stt_text"], rec["path"], rec["answer"], rec["conversation_id"]),
                         ("Licht aus", "local_intent", "Aus", "c1"))
        self.assertEqual(rec["latency_s"], {"stt": 1.2, "intent": 0.8, "tts": 0.3, "total": 2.5})
        self.assertIsNone(turnlog.pipeline_record("p", "r", ev[:-1]))  # still running
        self.assertIsNone(turnlog.pipeline_record("p", "r", [ev[0], ev[-1]]))  # wake word only

    def test_append_line_writes_daily_jsonl(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[3], prefix=".tl-") as d:
            turnlog.append_line(d, {"a": "ä"})
            turnlog.append_line(d, {"a": 2})
            files = list(Path(d).rglob("turns-*.jsonl"))
            self.assertEqual(len(files), 1)
            self.assertEqual([json.loads(x)["a"] for x in files[0].read_text().splitlines()], ["ä", 2])


if __name__ == "__main__":
    unittest.main()
