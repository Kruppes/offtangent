"""Offline validation of existing local agent selection. Never invokes an agent or HA service."""
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from custom_components.offtangent_conversation import fallback


class LocalSelectionTests(unittest.TestCase):
    def setUp(self):
        self.record = SimpleNamespace(config_entry_id="synthetic-entry", config_subentry_id=None)
        self.entry = SimpleNamespace(domain="ollama", data={"url": "http://ollama.local:11434", "model": "synthetic:8b"}, options={}, subentries={})
        self.registry = SimpleNamespace(async_get=lambda target: self.record if target == "conversation.synthetic" else None)
        self.hass = SimpleNamespace(config_entries=SimpleNamespace(async_get_entry=lambda entry_id: self.entry))
        self.patch = patch.object(fallback.entity_registry, "async_get", return_value=self.registry)
        self.patch.start(); self.addCleanup(self.patch.stop)

    def test_existing_local_agent_is_read_only_and_no_control_escalation(self):
        self.assertIs(fallback.local_fallback_entry(self.hass, "conversation.synthetic", control=False), self.entry)
        self.assertEqual(self.entry.options, {})
        self.entry.options["llm_hass_api"] = ["assist"]
        with self.assertRaisesRegex(ValueError, "fallback_control_scope"):
            fallback.local_fallback_entry(self.hass, "conversation.synthetic", control=False)
        self.assertIs(fallback.local_fallback_entry(self.hass, "conversation.synthetic", control=True), self.entry)

    def test_unknown_remote_credentials_cloud_models_and_foreign_agents_rejected(self):
        with self.assertRaises(ValueError):
            fallback.local_fallback_entry(self.hass, "conversation.missing", control=False)
        for url in ["https://api.example.com", "http://8.8.8.8", "ftp://localhost", "http://user:synthetic@localhost", "http://0.0.0.0", "http://224.0.0.1"]:
            self.entry.data["url"] = url
            with self.subTest(url=url), self.assertRaises(ValueError):
                fallback.local_fallback_entry(self.hass, "conversation.synthetic", control=False)
        self.entry.data["url"] = "http://localhost:11434"
        for model in ["synthetic:cloud", "synthetic:120b-cloud", "", None]:
            self.entry.data["model"] = model
            with self.subTest(model=model), self.assertRaises(ValueError):
                fallback.local_fallback_entry(self.hass, "conversation.synthetic", control=False)
        self.entry.data["model"] = "synthetic:8b"; self.entry.domain = "offtangent_conversation"
        with self.assertRaises(ValueError):
            fallback.local_fallback_entry(self.hass, "conversation.synthetic", control=False)

    def test_ollama_conversation_subentry_scope_is_validated_not_parent_only(self):
        self.record.config_subentry_id = "synthetic-subentry"
        with self.assertRaisesRegex(ValueError, "fallback_subentry_missing"):
            fallback.local_fallback_entry(self.hass, "conversation.synthetic", control=False)
        self.entry.subentries = {"synthetic-subentry": SimpleNamespace(subentry_type="conversation", data={"model": "synthetic:cloud"})}
        with self.assertRaisesRegex(ValueError, "fallback_model_not_local"):
            fallback.local_fallback_entry(self.hass, "conversation.synthetic", control=False)
        self.entry.subentries["synthetic-subentry"].data = {"model": "synthetic:8b"}
        self.assertIs(fallback.local_fallback_entry(self.hass, "conversation.synthetic", control=False), self.entry)
