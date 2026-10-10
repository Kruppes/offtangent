"""Entry lifecycle with actual HA module APIs and synthetic manager/client, no HA host."""
import asyncio
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from homeassistant.const import Platform
from homeassistant.exceptions import ConfigEntryNotReady

from custom_components import offtangent_conversation as integration
from custom_components.offtangent_conversation.config_flow import _validate


class LifecycleTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.client = SimpleNamespace(check_model=AsyncMock(), close=AsyncMock())
        self.manager = SimpleNamespace(async_forward_entry_setups=AsyncMock(),
                                       async_unload_platforms=AsyncMock(return_value=True),
                                       async_reload=AsyncMock())
        self.hass = SimpleNamespace(config_entries=self.manager)
        self.entry = SimpleNamespace(data={"url": "https://synthetic.invalid/v1", "adapter_token": "synthetic-value-123456", "model": "claude-haiku-5-5"},
                                     options={"model": "synthetic-override"}, entry_id="synthetic-entry",
                                     async_on_unload=Mock(), add_update_listener=Mock(return_value=lambda: None))
        self.patch = patch.object(integration, "AdapterClient", return_value=self.client)
        self.factory = self.patch.start()
        self.addCleanup(self.patch.stop)

    async def test_setup_forwards_only_new_conversation_options_override_and_unloads(self):
        self.assertTrue(await integration.async_setup_entry(self.hass, self.entry))
        self.factory.assert_called_once_with("https://synthetic.invalid/v1", "synthetic-value-123456", "synthetic-override")
        self.manager.async_forward_entry_setups.assert_awaited_once_with(self.entry, [Platform.CONVERSATION])
        self.entry.add_update_listener.assert_called_once_with(integration._async_reload)
        self.entry.async_on_unload.assert_called_once()
        self.assertIs(self.entry.runtime_data, self.client)
        self.assertTrue(await integration.async_unload_entry(self.hass, self.entry))
        self.client.close.assert_awaited_once()

    async def test_readiness_failure_closes_client_and_never_forwards(self):
        self.client.check_model.side_effect = integration.AdapterError("model_not_advertised")
        with self.assertRaises(ConfigEntryNotReady):
            await integration.async_setup_entry(self.hass, self.entry)
        self.client.close.assert_awaited_once()
        self.manager.async_forward_entry_setups.assert_not_awaited()

    async def test_cancellation_closes_client_and_propagates(self):
        self.client.check_model.side_effect = asyncio.CancelledError()
        with self.assertRaises(asyncio.CancelledError):
            await integration.async_setup_entry(self.hass, self.entry)
        self.client.close.assert_awaited_once()
        self.manager.async_forward_entry_setups.assert_not_awaited()

    async def test_platform_setup_failure_closes_and_does_not_register_listener(self):
        self.manager.async_forward_entry_setups.side_effect = RuntimeError("synthetic setup failure")
        with self.assertRaises(RuntimeError):
            await integration.async_setup_entry(self.hass, self.entry)
        self.client.close.assert_awaited_once()
        self.entry.add_update_listener.assert_not_called()

    async def test_unload_refusal_leaves_client_open_and_options_reload_only_this_entry(self):
        self.entry.runtime_data = self.client
        self.manager.async_unload_platforms.return_value = False
        self.assertFalse(await integration.async_unload_entry(self.hass, self.entry))
        self.client.close.assert_not_awaited()
        await integration._async_reload(self.hass, self.entry)
        self.manager.async_reload.assert_awaited_once_with("synthetic-entry")

    async def test_config_rejects_bad_allowlists_controls_credentials_and_urls(self):
        base = {**self.entry.data, "control": True, "allowed_tools": '["homeassistant__HassTurnOff"]'}
        _validate(base)
        bad = [{"allowed_tools": "[]"}, {"allowed_tools": '["bash"]'},
               {"allowed_tools": '["HassTurnOff","HassTurnOff"]'},
               {"control": "false"}, {"adapter_token": "short"},
               {"url": "http://synthetic.invalid/v1"}, {"model": "any/model"},
               {"allowed_tools": "NaN"}]
        for change in bad:
            with self.subTest(change=change), self.assertRaises((ValueError, TypeError)):
                _validate({**base, **change})


if __name__ == "__main__":
    unittest.main()
