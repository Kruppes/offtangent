"""Read-only validation of an explicitly selected existing local Ollama agent."""
import ipaddress
from urllib.parse import urlsplit

from homeassistant.const import CONF_LLM_HASS_API
from homeassistant.helpers import entity_registry


def local_fallback_entry(hass, target, *, control):
    record = entity_registry.async_get(hass).async_get(target) if target else None
    entry = hass.config_entries.async_get_entry(record.config_entry_id) if record else None
    if not entry or entry.domain not in {"ollama", "ollama_conversation"}:
        raise ValueError("fallback_not_local_ollama")
    settings = {**entry.data, **entry.options}
    if record.config_subentry_id:
        subentry = entry.subentries.get(record.config_subentry_id)
        if not subentry or subentry.subentry_type != "conversation":
            raise ValueError("fallback_subentry_missing")
        settings.update(subentry.data)
    model = settings.get("model", "")
    if not isinstance(model, str) or not model or model.endswith((":cloud", "-cloud")):
        raise ValueError("fallback_model_not_local")
    raw_url = settings.get("url") or settings.get("base_url")
    url = urlsplit(raw_url or "")
    if url.scheme not in {"http", "https"} or not url.hostname or url.username or url.password:
        raise ValueError("fallback_url_unverified")
    try:
        addr = ipaddress.ip_address(url.hostname)
        private = addr.is_private and not addr.is_unspecified and not addr.is_multicast
    except ValueError:
        private = url.hostname == "localhost" or url.hostname.endswith((".local", ".lan", ".internal"))
    if not private:
        raise ValueError("fallback_url_not_local")
    # Never turn control-OFF into control-ON by delegating to another entry.
    if not control and settings.get(CONF_LLM_HASS_API):
        raise ValueError("fallback_control_scope")
    return entry
