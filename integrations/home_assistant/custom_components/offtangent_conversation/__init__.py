"""Register only a new conversation entity. Never change pipelines/exposure."""
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryNotReady

from .client import AdapterClient, AdapterError


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    settings = {**entry.data, **entry.options}
    client = AdapterClient(settings["url"], settings["adapter_token"], settings["model"])
    try:
        # Read-only advertisement; NOT inference and NOT a live-model readiness claim.
        await client.check_model()
    except AdapterError as err:
        await client.close()
        raise ConfigEntryNotReady(str(err)) from err
    except BaseException:
        await client.close()
        raise
    entry.runtime_data = client
    try:
        await hass.config_entries.async_forward_entry_setups(entry, [Platform.CONVERSATION])
    except BaseException:
        await client.close()
        raise
    entry.async_on_unload(entry.add_update_listener(_async_reload))
    return True


async def _async_reload(hass: HomeAssistant, entry: ConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    if await hass.config_entries.async_unload_platforms(entry, [Platform.CONVERSATION]):
        await entry.runtime_data.close()
        return True
    return False
