"""Read-only exact Assist tool schemas. Never exports token, prompts, entities or states."""
import json

from probatio import to_openapi
from homeassistant.components import conversation
from homeassistant.helpers import llm

from .client import TOOL_NAME
from .const import DOMAIN


async def async_get_config_entry_diagnostics(hass, entry):
    settings = {**entry.data, **entry.options}
    allowed = set(json.loads(settings["allowed_tools"]))
    tools = []
    if settings.get("control"):
        api = await llm.async_get_api(hass, llm.LLM_API_ASSIST, llm.LLMContext(
            platform=DOMAIN, context=None, language="de", assistant=conversation.DOMAIN, device_id=None,
        ))
        tools = [{"name": tool.name, "description": tool.description or "Home Assistant Assist tool",
                  "parameters": to_openapi(tool.parameters, custom_serializer=api.custom_serializer)}
                 for tool in api.tools if tool.name in allowed and TOOL_NAME.fullmatch(tool.name)]
    return {"integration": DOMAIN, "model": settings["model"], "control": settings["control"],
            "tool_schema_source": "Installed HA Assist API; selected allowlist only; no tool executed",
            "tools": tools}
