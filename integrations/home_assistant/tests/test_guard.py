"""Offline: local-path target guard (guard.py) inside client.run_turn, and answer hygiene."""
import asyncio
import importlib.util
import json
import pathlib
import sys
import unittest

HERE = pathlib.Path(__file__).resolve().parents[1] / "custom_components/offtangent_conversation"


def load(name):
    spec = importlib.util.spec_from_file_location("offtangent_guard_test_" + name, HERE / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


client = load("client")
guard = load("guard")
MODEL = "local"
OFF, ON, LIVE = "HassTurnOff", "HassTurnOn", "GetLiveContext"
TOOLS = [{"type": "function", "function": {"name": n, "description": "t", "parameters": {"type": "object", "properties": {
    "name": {"type": "string"}, "area": {"type": "string"}, "floor": {"type": "string"},
    "domain": {"type": "array", "items": {"type": "string"}}}}}} for n in (OFF, ON, LIVE, "HassSetPosition")]
SUCCESS = {"response_type": "action_done", "data": {"success": [{"id": "x"}], "failed": []}}

T = guard.Target
DEVICES = [
    T("light.esstisch", "light", "Esszimmer", "Erdgeschoss", "Lampe Esstisch"),
    T("light.flur", "light", "Flur", "Erdgeschoss", "Spots Flur"),
    T("light.klo", "light", "Gästeklo", "Erdgeschoss", "Licht Klo"),
    T("light.buero", "light", "Büro", "Erdgeschoss", "Yeelight Büro", ("Deckenlicht Büro",)),
    T("light.kueche", "light", "Küche", "Erdgeschoss", "Küchenlicht"),
    T("switch.keller", "switch", None, None, "Licht Keller Unterbau"),
    T("light.ohne_area", "light", None, None, "Shelly Mini"),
    T("light.buero2", "light", "Büro", "Erdgeschoss", "Spots Büro"),
    T("light.buero3", "light", "Büro", "Erdgeschoss", "Stehlampe Büro"),
    T("light.buero4", "light", "Büro", "Erdgeschoss", "Leiste Büro"),
    T("cover.buero", "cover", "Büro", "Erdgeschoss", "Rollladen Büro"),
]
WORLD = guard.World(areas={"Esszimmer": "Erdgeschoss", "Flur": "Erdgeschoss", "Gästeklo": "Erdgeschoss",
                           "Büro": "Erdgeschoss", "Küche": "Erdgeschoss", "Schlafzimmer": "Obergeschoss"},
                    floors={"Erdgeschoss", "Obergeschoss"}, floor_aliases={"EG": "Erdgeschoss"},
                    words={"lampe", "esstisch", "spots", "flur", "licht", "klo", "yeelight", "küchenlicht",
                           "keller", "unterbau", "shelly", "mini", "rollladen", "stehlampe", "leiste"})


def resolve(name, args):
    out = []
    for t in DEVICES:
        if args.get("name") and args["name"].casefold() not in [n.casefold() for n in (t.name, *t.aliases)]:
            continue
        if args.get("area") and args["area"] != t.area:
            continue
        if args.get("floor") and args["floor"] != t.floor:
            continue
        if args.get("domain") and t.domain not in args["domain"]:
            continue
        out.append(t)
    return out


def call(name, args, n=0):
    return {"id": f"call_{name}_{n}", "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}


def msg(*calls, content=None):
    return {"role": "assistant", "content": content, "tool_calls": list(calls)} if calls else {"role": "assistant", "content": content}


class Fake:
    def __init__(self, replies):
        self.replies, self.requests = list(replies), []

    async def complete(self, messages, tools, session=None):
        self.requests.append(json.loads(json.dumps(messages)))
        m = self.replies.pop(0)
        return client.validate_reply({"model": MODEL, "choices": [{"index": 0, "message": m,
            "finish_reason": "tool_calls" if m.get("tool_calls") else "stop"}]}, MODEL, TOOLS)


def run(text, replies, weather=None, world=WORLD, validate=None):
    fake, ran = Fake(replies), []
    g = guard.Guard(text, world, resolve, weather)

    async def dispatch(call_id, name, args):
        ran.append((name, args))
        return SUCCESS if client.is_mutating(name) else {"success": True, "result": "Wetter: bewölkt"}

    out = asyncio.run(client.run_turn(fake, "sys", text, TOOLS, validate or (lambda n, a: a), dispatch, guard=g))
    return out, ran, g, fake


class GuardTests(unittest.TestCase):
    def test_exception_never_hits_kitchen_feedback_then_confirm(self):
        # c04 (gemma/qwen 1b): floor-wide off incl. Küche + unscoped switch -> fed back, nothing ran.
        text = "Mach alle Lichter im Erdgeschoss aus, außer in der Küche."
        out, ran, g, fake = run(text, [
            msg(call(OFF, {"floor": "Erdgeschoss", "domain": ["light"]})),
            msg(*[call(OFF, {"area": a, "domain": ["light"]}, i) for i, a in enumerate(["Esszimmer", "Flur", "Gästeklo", "Büro"])]),
        ])
        self.assertEqual(ran, [])
        self.assertEqual(g.events[0]["guard_blocked"], "feedback")
        self.assertEqual(g.events[0]["reason"], "exception_target")
        self.assertIn("light.kueche", g.events[0]["targets"])
        self.assertEqual(g.events[1]["guard_blocked"], "confirm")  # 7 lights in 4 areas -> "ja" first
        self.assertTrue(out.text.endswith("Soll ich das machen?"))
        self.assertNotIn("light.kueche", g.events[1]["targets"])
        self.assertEqual(len(g.pending), 4)

    def test_unscoped_entities_are_out_of_scope(self):
        text = "Mach die Lichter im Esszimmer aus."
        out, ran, g, _ = run(text, [msg(call(OFF, {"name": "Licht Keller Unterbau"})),
                                    msg(call(OFF, {"name": "Shelly Mini"}, 1))])
        self.assertEqual(ran, [])
        self.assertEqual([e["reason"] for e in g.events], ["out_of_scope", "out_of_scope"])
        self.assertEqual([e["guard_blocked"] for e in g.events], ["feedback", "clarify"])

    def test_repeat_of_blocked_batch_asks(self):
        text = "Mach alles im Erdgeschoss aus außer Küche."
        bad = call(OFF, {"floor": "Erdgeschoss"})
        out, ran, g, _ = run(text, [msg(bad), msg(bad)])
        self.assertEqual(ran, [])
        self.assertIn("nichts geschaltet", out.text)

    def test_unknown_area_clarifies(self):
        # c11 (qwen 1b): "Garage" is no area -> question, never an action.
        out, ran, g, _ = run("Mach das Licht in der Garage an.", [msg(call(ON, {"name": "Licht Keller Unterbau"}))])
        self.assertEqual(ran, [])
        self.assertEqual(g.events[0]["guard_blocked"], "clarify")
        self.assertIn("Garage", out.text)

    def test_no_match_fed_back_once_then_corrected(self):
        # Phase 2 M1 (gemma): partial name "Deckenlicht" matched nothing -> one correction round, nothing ran.
        out, ran, g, fake = run("Mach das Licht im Büro an.", [
            msg(call(ON, {"name": "Yeelight", "area": "Büro", "domain": ["light"]})),
            msg(call(ON, {"name": "Yeelight Büro", "area": "Büro", "domain": ["light"]}, 1)),
            msg(content="Ich habe das Yeelight im Büro eingeschaltet."),
        ])
        self.assertEqual([e["guard_blocked"] for e in g.events], ["feedback"])
        self.assertEqual(g.events[0]["reason"], "no_match")
        self.assertEqual(ran, [(ON, {"name": "Yeelight Büro", "area": "Büro", "domain": ["light"]})])
        self.assertIn("GUARD", fake.requests[1][-1]["content"])
        # Hint: exact names in the same area sharing a word; only the matching one, nothing dispatched.
        # Hint: the exact names HA knows in that area (incl. aliases); nothing dispatched by the hint.
        self.assertIn("Exakte Namen in Büro: Yeelight Büro (auch: Deckenlicht Büro); Spots Büro; "
                      "Stehlampe Büro; Leiste Büro.", fake.requests[1][-1]["content"])

    def test_confirm_text_names_each_name_once(self):
        targets = [T("light.a", "light", "Flur", None, "Spots Flur EG"), T("switch.a", "switch", "Flur", None, "Spots Flur EG"),
                   T("light.b", "light", "Büro", None, "Yeelight Büro")]
        self.assertEqual(guard._names(targets), "Spots Flur EG, Yeelight Büro")

    def test_no_match_hint_empty_without_area_or_on_resolver_error(self):
        g = guard.Guard("Mach Yeelight an.", WORLD, resolve)
        self.assertEqual(g._candidates(ON, {"name": "Yeelight"}), "")
        # More than four candidates: no list (too long to help).
        self.assertEqual(g._candidates(ON, {"name": "X", "floor": "Erdgeschoss"}), "")

        def broken(*_):
            raise RuntimeError("x")
        g = guard.Guard("Mach Yeelight an.", WORLD, broken)
        self.assertEqual(g._candidates(ON, {"name": "Yeelight", "area": "Büro"}), "")

    def test_no_match_twice_clarifies(self):
        out, ran, g, _ = run("Mach das Licht im Büro an.", [
            msg(call(ON, {"name": "Yeelight", "area": "Büro"})),
            msg(call(ON, {"name": "Deckenlampe", "area": "Büro"}, 1)),
        ])
        self.assertEqual(ran, [])
        self.assertEqual([e["guard_blocked"] for e in g.events], ["feedback", "clarify"])
        self.assertIn("nichts geschaltet", out.text)

    def test_rain_condition_not_met_blocks_cover(self):
        # c03 (gemma 1): cover only if it actually rains.
        out, ran, g, _ = run("Wenn es draußen gerade regnet, mach den Rolladen im Büro zu.",
                             [msg(call("HassSetPosition", {"area": "Büro", "domain": ["cover"]}))],
                             weather=lambda: [("Forecast Home", "cloudy")])
        self.assertEqual(ran, [])
        self.assertEqual(g.events[0]["reason"], "condition_not_met")
        self.assertIn("regnet", out.text)

    def test_rain_condition_met_runs(self):
        out, ran, g, _ = run("Wenn es regnet, mach den Rollladen im Büro zu.",
                             [msg(call("HassSetPosition", {"area": "Büro", "domain": ["cover"]})), msg(content="Zu.")],
                             weather=lambda: [("Forecast Home", "rainy")])
        self.assertEqual(len(ran), 1)

    def test_condition_without_weather_fails_closed(self):
        out, ran, g, _ = run("Falls jemand klingelt, mach das Licht im Flur an.", [msg(call(ON, {"area": "Flur"}))])
        self.assertEqual(ran, [])
        self.assertEqual(g.events[0]["reason"], "condition_unverified")

    def test_single_area_many_lights_runs(self):
        out, ran, g, _ = run("Mach das Licht im Büro an.", [msg(call(ON, {"area": "Büro", "domain": ["light"]})),
                                                            msg(content="Das Licht im Büro ist an.")])
        self.assertEqual(len(ran), 1)
        self.assertEqual(g.events, [])

    def test_multi_domain_needs_confirmation(self):
        out, ran, g, _ = run("Mach im Büro alles aus.", [msg(call(OFF, {"area": "Büro"}))])
        self.assertEqual(ran, [])
        self.assertEqual(g.events[0]["reason"], "multi_domain")

    def test_read_only_batches_pass(self):
        out, ran, g, _ = run("Wie ist das Wetter in der Garage?", [msg(call(LIVE, {})), msg(content="Bewölkt.")])
        self.assertEqual(ran, [(LIVE, {})])
        self.assertEqual(g.events, [])

    def test_no_world_blocks_actions(self):
        out, ran, g, _ = run("Mach das Licht im Flur an.", [msg(call(ON, {"area": "Flur"}))], world=None)
        self.assertEqual(ran, [])
        self.assertEqual(g.events[0]["reason"], "guard_world_unavailable")

    def test_invalid_args_fed_back_once_then_raise(self):
        def validate(name, args):
            if not isinstance(args.get("area", ""), str):
                raise ValueError("expected str for dictionary value @ data['area']")
            return args
        out, ran, g, fake = run("Mach das Licht im Flur an.", [
            msg(call(ON, {"area": ["Flur"]})), msg(call(ON, {"area": "Flur"}, 1)), msg(content="Flurlicht ist an.")],
            validate=validate)
        self.assertEqual(ran, [(ON, {"area": "Flur"})])
        self.assertEqual(g.events[0]["guard_blocked"], "invalid_args")
        self.assertIn("ungültige Werkzeug-Argumente", fake.requests[1][-1]["content"])
        with self.assertRaises(ValueError):
            run("Mach das Licht im Flur an.", [msg(call(ON, {"area": ["Flur"]})), msg(call(ON, {"area": ["Flur", "x"]}, 1))],
                validate=validate)

    def test_relay_path_without_guard_unchanged(self):
        fake, ran = Fake([msg(call(OFF, {"floor": "Erdgeschoss"})), msg(content="Aus.")]), []

        async def dispatch(call_id, name, args):
            ran.append(name)
            return SUCCESS
        out = asyncio.run(client.run_turn(fake, "sys", "außer Küche", TOOLS, lambda n, a: a, dispatch))
        self.assertEqual(ran, [OFF])

    def test_confirmation_words(self):
        for yes in ("ja", "Ja.", "ja bitte", "mach das", "Okay"):
            self.assertTrue(guard.is_confirmation(yes), yes)
        for no in ("nein", "ja aber nur im Flur", "mach das Licht an"):
            self.assertFalse(guard.is_confirmation(no), no)

    def test_run_confirmed_dispatches_batch(self):
        ran = []

        async def dispatch(call_id, name, args):
            ran.append((name, args))
            return SUCCESS
        out = asyncio.run(client.run_confirmed([(OFF, {"area": "Flur"}), (OFF, {"area": "Büro"})],
                                               lambda n, a: a, dispatch))
        self.assertEqual(len(ran), 2)
        self.assertFalse(out.failed)
        self.assertEqual(out.messages[0]["tool_calls"][0]["function"]["name"], OFF)


class HygieneTests(unittest.TestCase):
    def test_think_tail_and_duplicate_removed(self):
        # qwen 1b live: "A\n</think>\n\nA"
        self.assertEqual(client.clean_speech("Das Licht ist an.\n</think>\n\nDas Licht ist an."), "Das Licht ist an.")
        self.assertEqual(client.clean_speech("<think>hm</think>Es ist 10 Uhr."), "Es ist 10 Uhr.")
        self.assertEqual(client.clean_speech("Erst.\n\nZweit.\n\nErst."), "Erst.\n\nZweit.")
        self.assertEqual(client.clean_speech("Kurz."), "Kurz.")
        self.assertEqual(client.clean_speech("Das Licht ist an. Das Licht ist an."), "Das Licht ist an.")
        self.assertEqual(client.clean_speech("Ja. Ja."), "Ja. Ja.")  # too short to judge: untouched

    def test_think_only_answer_is_not_spoken(self):
        with self.assertRaises(client.AdapterError):
            run("Hallo", [msg(content="<think>nur gedacht</think>")])

    def test_hygiene_applies_to_final_answer(self):
        out, ran, g, _ = run("Wie spät?", [msg(content="Es ist zehn.\n</think>\n\nEs ist zehn.")])
        self.assertEqual(out.text, "Es ist zehn.")


if __name__ == "__main__":
    unittest.main()
