"""Register only a new conversation entity. Never change pipelines/exposure."""
import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryNotReady, ConfigEntryError

from .client import AdapterClient, AdapterError
from .fallback import local_fallback_entry
from .ollama import OllamaClient

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    settings = {**entry.data, **entry.options}
    if settings.get("fallback_agent"):
        try:
            local_fallback_entry(hass, settings["fallback_agent"], control=settings.get("control", False))
        except ValueError as err:
            raise ConfigEntryError("invalid_local_fallback") from err
    client = AdapterClient(settings["url"], settings["adapter_token"], settings["model"])
    try:
        # Read-only advertisement; NOT inference and NOT a live-model readiness claim.
        await client.check_model()
    except AdapterError as err:
        # Keep the entity/fallback usable during relay outage (not wrong bearer/model).
        if not settings.get("fallback_agent") or str(err) not in {
            "adapter_unavailable", "adapter_unreachable", "adapter_http_429", "adapter_http_502", "adapter_http_503", "adapter_http_504"}:
            await client.close()
            raise ConfigEntryNotReady(str(err)) from err
    except BaseException:
        await client.close()
        raise
    client.local = None
    client.turn_log_dir = settings.get("turn_log_dir") or None
    if settings.get("local_url"):
        try:
            client.local = OllamaClient(settings["local_url"], settings.get("local_model") or "gemma4:12b-mlx",
                                        num_ctx=int(settings.get("local_num_ctx") or 16384),
                                        timeout=int(settings.get("local_timeout") or 15))
        except ValueError as err:
            await client.close()
            raise ConfigEntryError("invalid_local_primary") from err
        try:
            await client.local.check_model()
        except AdapterError as err:
            # Not fatal: every turn falls back to the relay until Ollama answers again.
            _LOGGER.warning("Ollama primary path not ready at setup (%s); relay fallback active", err)
    entry.runtime_data = client
    try:
        await hass.config_entries.async_forward_entry_setups(entry, [Platform.CONVERSATION])
    except BaseException:
        await _close(client)
        raise
    entry.async_on_unload(entry.add_update_listener(_async_reload))
    return True


async def _async_reload(hass: HomeAssistant, entry: ConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    if await hass.config_entries.async_unload_platforms(entry, [Platform.CONVERSATION]):
        await _close(entry.runtime_data)
        return True
    return False


async def _close(client) -> None:
    if getattr(client, "local", None) is not None:
        await client.local.close()
    await client.close()
