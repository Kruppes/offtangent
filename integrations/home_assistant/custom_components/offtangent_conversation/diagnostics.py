"""Read-only exact Assist tool schemas. Never exports token, prompts, entities or states."""
import json

from probatio import to_openapi
from homeassistant.components import conversation
from homeassistant.helpers import llm

from .client import MAX_REQUEST_BYTES, select_tools
from .const import DOMAIN


async def async_get_config_entry_diagnostics(hass, entry):
    settings = {**entry.data, **entry.options}
    allowed = set(json.loads(settings["allowed_tools"]))
    tools = []
    unsendable = []
    if settings.get("control"):
        api = await llm.async_get_api(hass, llm.LLM_API_ASSIST, llm.LLMContext(
            platform=DOMAIN, context=None, language="de", assistant=conversation.DOMAIN, device_id=None,
        ))
        selected, unsendable = select_tools(api.tools, allowed)
        tools = [{"name": tool.name, "description": tool.description or "Home Assistant Assist tool",
                  "parameters": to_openapi(tool.parameters, custom_serializer=api.custom_serializer)}
                 for tool in selected.values()]
    wire = [{"type": "function", "function": tool} for tool in tools]
    tool_bytes = len(json.dumps(wire, ensure_ascii=False).encode())
    return {"integration": DOMAIN, "model": settings["model"], "control": settings["control"],
            "tool_schema_source": "Installed HA Assist API; selected allowlist only; no tool executed",
            "tool_count": len(tools), "tool_payload_bytes": tool_bytes,
            "request_byte_limit": MAX_REQUEST_BYTES, "unsendable_tools": sorted(unsendable),
            "tools": tools}
