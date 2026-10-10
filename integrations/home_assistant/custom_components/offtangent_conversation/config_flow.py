"""Explicit opt-in control, generic endpoint/model, local HA adapter token only."""
import json

import voluptuous as vol
from homeassistant import config_entries
from homeassistant.core import callback
from homeassistant.helpers import selector

from .client import TOOL_NAME, validate_url
from .const import DEFAULT_MODEL, DOMAIN


def _schema(defaults):
    return vol.Schema({
        vol.Required("url", default=defaults.get("url", "https://adapter.example.invalid/v1")): str,
        vol.Required("adapter_token", default=defaults.get("adapter_token", "")):
            selector.TextSelector({"type": "password"}),
        vol.Required("model", default=defaults.get("model", DEFAULT_MODEL)): str,
        vol.Required("control", default=defaults.get("control", False)): bool,
        vol.Required("allowed_tools", default=defaults.get("allowed_tools", "[]")): str,
    })


def _validate(data):
    import re
    validate_url(data["url"])
    if not isinstance(data["control"], bool):
        raise ValueError()
    if (not re.fullmatch(r"[^\s]{16,512}", data["adapter_token"])
        or not re.fullmatch(r"[A-Za-z0-9-]{1,128}", data["model"])):
        raise ValueError()
    names = json.loads(data["allowed_tools"])
    if (not isinstance(names, list) or len(names) > 32
        or any(not isinstance(n, str) or not TOOL_NAME.fullmatch(n) for n in names)
        or len(set(names)) != len(names) or (data["control"] and not names)):
        raise ValueError()


class OfftangentConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input=None):
        errors = {}
        if user_input is not None:
            try:
                _validate(user_input)
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
            except (ValueError, TypeError, KeyError):
                errors["base"] = "invalid_config"
            else:
                return self.async_create_entry(title="", data=user_input)
        defaults = {**self.config_entry.data, **self.config_entry.options}
        return self.async_show_form(step_id="init", data_schema=_schema(user_input or defaults), errors=errors)
