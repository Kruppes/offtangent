"""Offline fixture driver, NOT a HA service: loopback Node adapter, one simulated action."""
import asyncio
import importlib.util
import json
from pathlib import Path
import sys
from urllib.parse import urlsplit

# This wire fixture exercises the unchanged, HA-independent production client.
# Import its exact source rather than bootstrapping the HA integration package:
# the Node image deliberately does not contain the entire HA runtime.
spec = importlib.util.spec_from_file_location(
    "offtangent_bridge_client",
    Path(__file__).resolve().parents[1] / "custom_components/offtangent_conversation/client.py",
)
client_module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = client_module
spec.loader.exec_module(client_module)
AdapterClient, run_turn = client_module.AdapterClient, client_module.run_turn


async def main():
    url = sys.argv[1]
    if urlsplit(url).hostname != "127.0.0.1" or urlsplit(url).scheme != "http":
        raise RuntimeError("This fixture permits only a local mock adapter")
    name = "homeassistant__HassTurnOff"
    tool = {"type": "function", "function": {"name": name,
            "description": "Synthetic Assist tool. Never executes.",
            "parameters": {"type": "object", "properties": {"name": {"type": "string"}},
                           "required": ["name"], "additionalProperties": False}}}
    calls = []

    def validate(tool_name, args):
        if tool_name != name or args != {"name": "Simuliertes Licht"}:
            raise RuntimeError("Unexpected synthetic action")
        return args

    async def simulate(call_id, tool_name, args):
        calls.append({"id": call_id, "name": tool_name, "arguments": args})
        return {"response_type": "action_done", "data": {"success": [{"id": "synthetic-light"}], "failed": []}}

    client = AdapterClient(url, "ha-fixture-" * 4, "claude-haiku-5-5")
    try:
        await client.check_model()
        result = await run_turn(client, "Nur synthetische HA Werkzeuge, kein Offtangent-Agent.",
                                "Schalte simuliertes Licht aus.", [tool], validate, simulate)
        assert len(calls) == 1 and not result.failed
        assert result.text == "Home Assistant hat die Aktion bestätigt."
        print(json.dumps({"mode": "OFFLINE ONLY", "transport": "Python aiohttp -> real loopback Node HTTP -> intercepted real pi-ai SDK",
                          "model": client.model, "simulated_calls": calls, "final": result.text,
                          "messages": result.messages}, ensure_ascii=False))
    finally:
        await client.close()


if __name__ == "__main__":
    asyncio.run(main())
