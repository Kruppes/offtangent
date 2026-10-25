"""Explicit opt-in control, generic endpoint/model, local HA adapter token only."""
import json

import voluptuous as vol
from homeassistant import config_entries
from homeassistant.core import callback
from homeassistant.helpers import selector

from .client import ALL_ASSIST_TOOLS, TOOL_NAME, validate_url
from .const import DEFAULT_MODEL, DOMAIN
from .fallback import local_fallback_entry


def _schema(defaults):
    return vol.Schema({
        vol.Required("url", default=defaults.get("url", "https://adapter.example.invalid/v1")): str,
        vol.Required("adapter_token", default=defaults.get("adapter_token", "")):
            selector.TextSelector({"type": "password"}),
        vol.Required("model", default=defaults.get("model", DEFAULT_MODEL)): str,
        vol.Required("control", default=defaults.get("control", False)): bool,
        vol.Required("allowed_tools", default=defaults.get("allowed_tools", "[]")): str,
        vol.Optional("fallback_agent", default=defaults.get("fallback_agent", "")):
            selector.EntitySelector({"domain": "conversation"}),
        # Optional native Ollama primary path (empty = relay only) and JSONL turn log directory.
        vol.Optional("local_url", default=defaults.get("local_url", "")): str,
        vol.Optional("local_model", default=defaults.get("local_model", "gemma4:12b-mlx")): str,
        vol.Optional("turn_log_dir", default=defaults.get("turn_log_dir", "")): str,
    })


def _validate(data):
    import re
    validate_url(data["url"])
    if not isinstance(data["control"], bool):
        raise ValueError()
    if (not re.fullmatch(r"[^\s]{16,512}", data["adapter_token"])
        or not re.fullmatch(r"[A-Za-z0-9-]{1,128}", data["model"])):
        raise ValueError()
    fallback = data.get("fallback_agent")
    if fallback not in (None, "") and (not isinstance(fallback, str) or not re.fullmatch(r"conversation\.[a-z0-9_]+", fallback)):
        raise ValueError()
    if data.get("local_url"):
        from .ollama import MODEL_NAME, validate_ollama_url
        validate_ollama_url(data["local_url"])
        model = data.get("local_model") or "gemma4:12b-mlx"
        if not MODEL_NAME.fullmatch(model) or model.endswith((":cloud", "-cloud")):
            raise ValueError()
    log_dir = data.get("turn_log_dir")
    if log_dir not in (None, "") and (not isinstance(log_dir, str)
                                      or not re.fullmatch(r"/[A-Za-z0-9._/-]{1,200}", log_dir) or ".." in log_dir):
        raise ValueError()
    names = json.loads(data["allowed_tools"])
    if (not isinstance(names, list) or len(names) > 32
        or any(not isinstance(n, str) or not (TOOL_NAME.fullmatch(n) or n == ALL_ASSIST_TOOLS) for n in names)
        or (ALL_ASSIST_TOOLS in names and (names != [ALL_ASSIST_TOOLS] or not data["control"]))
        or len(set(names)) != len(names) or (data["control"] and not names)):
        raise ValueError()


class OfftangentConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input=None):
        errors = {}
        if user_input is not None:
            try:
                _validate(user_input)
                if user_input.get("fallback_agent"):
                    local_fallback_entry(self.hass, user_input["fallback_agent"], control=user_input["control"])
            except (ValueError, TypeError, KeyError):
                errors["base"] = "invalid_config"
            else:
                return self.async_create_entry(title="Offtangent Conversation", data=user_input)
        return self.async_show_form(step_id="user", data_schema=_schema(user_input or {}), errors=errors)

    @staticmethod
    @callback
    def async_get_options_flow(config_entry):
        return OfftangentOptionsFlow()


class OfftangentOptionsFlow(config_entries.OptionsFlow):
    async def async_step_init(self, user_input=None):
        errors = {}
        if user_input is not None:
            try:
                _validate(user_input)
                if user_input.get("fallback_agent"):
                    local_fallback_entry(self.hass, user_input["fallback_agent"], control=user_input["control"])
            except (ValueError, TypeError, KeyError):
                errors["base"] = "invalid_config"
            else:
                return self.async_create_entry(title="", data=user_input)
        defaults = {**self.config_entry.data, **self.config_entry.options}
        return self.async_show_form(step_id="init", data_schema=_schema(user_input or defaults), errors=errors)
