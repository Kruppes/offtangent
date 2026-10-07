# Home Assistant via MQTT

The optional, instance-wide Home Assistant MQTT integration publishes **aggregated numeric metrics only**, without using a model. It is off by default. Only admins may configure it under **Settings → System → Home Assistant (MQTT)** (`/settings/homeAssistantMqtt`). It does not require an HA token or a connection from HA to Offtangent.

1. In Home Assistant, enable the MQTT integration and connect it to a broker such as Mosquitto. Enable MQTT Discovery (default prefix `homeassistant`). Make a dedicated broker account with publish permission for `offtangent/#` and `homeassistant/sensor/offtangent/#` (adapt these to your chosen topics). Do not give Offtangent permissions for unrelated topics.
2. In Offtangent, enter broker host, port (`1883` for MQTT, `8883` commonly for MQTT over TLS), TLS, username and password. A password is stored encrypted via the built-in secret store; it is never returned to the browser. TLS validates the broker certificate using Node.js trust roots; for a custom CA provide it to the Node process separately.
3. Choose a unique **client ID**, **base topic** (default `offtangent`) and **discovery prefix** (default `homeassistant`); select the four groups independently. Set the periodic interval (default 60 seconds, allowed 10–3600 seconds). Click Save, then Enable and Save. **Test connection** deliberately publishes a retained `online` state and then `offline` to the configured status topic; it does not create Discovery entities.
4. The MQTT device “Offtangent” appears in HA. Availability is the retained `offtangent/status` (`online` / `offline`); an MQTT Last Will publishes `offline` after an ungraceful disconnect. Quota snapshots are event-driven; usage/activity are polled. Missing quota windows do not generate sensors. Quota sensors expire after 1200 seconds without updates, to avoid displaying stale limits as fresh.

Example HA dashboard card (substitute the actual entity IDs shown in your HA instance):

```yaml
type: entities
title: Offtangent
entities:
  - sensor.offtangent_limit_anthropic_five_hour
  - sensor.offtangent_limit_anthropic_five_hour_reset
  - sensor.offtangent_tokens_today_total
  - sensor.offtangent_cost_month_total
  - sensor.offtangent_running_tasks
```

Example topics: `homeassistant/sensor/offtangent/limit_anthropic_five_hour/config` (retained discovery), `offtangent/limit_anthropic_five_hour/state` (retained 0–100 integer), `offtangent/status` (availability). Other groups use `tokens_<period>_<kind>`, `cost_<period>_<kind>` (period `today` or `month`, kind `total` or a known provider family); `messages_today`, `running_tasks`, `failed_tasks_today`, `last_cron_run`, `version`. Discovery for deselected sensors is removed with an empty retained message while connected. A manifest in `config/mqtt-discovery-topics.json` records prior discovery topics for cleanup across restarts. If the broker is unreachable while disabling, cleanup is pending until MQTT is enabled and connected again; the module **never connects while disabled**. Manual broker cleanup may be needed when changing brokers while disconnected.

**Privacy:** no messages, task names/prompts, account IDs, provider account IDs, error details or plans are published. Provider usage is restricted to known provider families; multiple subscriber accounts of the same type are collapsed to maximum quota utilization. Metrics are instance-wide rather than per user. The broker connection must be secured by the administrator; plain MQTT is supported but not encrypted.
