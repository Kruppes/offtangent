# Offtangent Conversation — eigenständiges HA-Integrationspaket

**Experimental, REVIEW ONLY. Haiku-Livetransport ist auth-blockiert.** Dieses Paket
wird hier nicht installiert; es ersetzt weder Ollama noch eine bestehende Pipeline.

## Dateien / Verhalten

`custom_components/offtangent_conversation/` ist die installierbare Integration,
`tests/` bleibt ausschließlich im Reviewpaket. Keine Drittanbieteranforderungen:
HA selbst liefert aiohttp, probatio und voluptuous. Getestete Version: HA 2026.9.4,
Python 3.14.2. Ältere HA-Versionen sind nicht als kompatibel freigegeben.

- Eigene ConfigEntry/ConversationEntity, Options-Reload und sauberes Unload.
- HTTPS erforderlich außer Loopback-HTTP; keine URL-Credentials, Query/Fragment,
  Redirects, Proxy-Umgebung, POST-Retries oder Modell-/Credentialfallbacks.
- `/v1/models` ist nur Konfigurationsadvertisement, keine Livebereitschaft.
- Deutscher sicherer Prompt (`const.py`) und unabhängige neue Modellkonversation
  für jede Äußerung. Keine Offtangent-Memory-/SOUL-Anbindung, keine Übernahme
  anderer Agentenprompts/History. Pronomen/Folgebezüge müssen neu geklärt werden.
- Steuerung AUS als Default. Bei AN: ausschließlich vom installierten Assist API
  bereitgestellte und explizit allowlistete Tools; bestehende Entity-Exposure bleibt
  unverändert. Aktuelle Namenspaces unterstützt, keine Toolumbenennung.
- Vollständige Batchvalidierung inklusive nativer HA-Voluptuous-Schemas vor erstem
  Dispatch; Dispatch nur über `llm.APIInstance.async_call_tool`, niemals direkte
  `hass.services.async_call`- oder beliebige Aktor-Services.
- Maximal drei Inferenzrunden / acht Calls pro Batch; exakte wiederholte Toolcalls
  werden abgewiesen. Bei fehlender/teilweiser Bestätigung oder Tooltimeout: keine
  Folgeaktion, kein Retry. Timeout kann bereits erfolgte Aktion bedeuten.
- Lock pro Entity ohne Warteschlange: parallele Nachfrage meldet busy, kein späterer
  unerwarteter Auftrag. 110 Sekunden Turnlimit, 100 Sekunden HTTP-Limit.
- HA-Erfolg wird ausschließlich aus strukturierten Assist-Ergebnissen abgeleitet.
  Nach bestätigten Mutationen wird eine kurze feste HA-Bestätigung gesprochen,
  nicht ungeprüfte Modell-Erfolgsprosa. Keine Wahrheitserkennung per Regex.
- ChatLog-Toolcalls werden als extern ausgeführt markiert; kein zweiter Dispatch.
- Read-only-Diagnostics liefert exakte ausgewählte Toolschemata, nie Adaptertoken,
  Adapter-URL oder Assist-Systemprompt. Toolschemata können selbst installations-
  spezifische Details enthalten: **lokal privat behandeln**, nicht unredigiert
  veröffentlichen. Keine Aktionsausführung zum Schemaexport.

Der Authfehler wird in HA als "Der Assistent ist derzeit nicht verfügbar. Ein
Aktionserfolg ist nicht bestätigt." ausgegeben, ohne Upstreambody oder Credentials.
Bei einer echten HA-Installation wären eigene Bearerwerte in HA ConfigEntry-
Storage enthalten: Dateirechte/Backups schützen, nicht in Git oder Diagnoseexport.

## Tests / Grenzen

`scripts/test-ha-haiku.sh /ABSOLUT/HA-VENV/bin/python /workspace/ha-review-output`
führt die begrenzte TypeScript-Regression, echte SDK mit vollständig simuliertem
Anthropic-Wire, Python-Client-zu-Node-HTTP-Bridge und HA-Bibliotheks-/Clienttests aus.
Die Bridge führt genau einen synthetischen Toolcallback aus, keinen HA-Service.
Die eigentliche HA-Entity wird separat mit echtem HA ChatLog/LLMContext und
synthetischem APIInstance/Tool getestet. Kein End-to-End-Test einer installierten
HA-Produktivinstanz. Keine STT-/TTS-/Voice-Hardwaretests oder Produktivlatenzen.

Keine Promptsicherung kann semantisch jeden Modellfehler verhindern. Bestehende
Assist-Exposure ist notwendige, keine neue zusätzliche Berechtigungsprüfung.
Keine vollständige Device-/Area-Auflösung im Adapter; diese bleibt beim echten
Assist-Intenttool. Ein unbestätigtes Ergebnis wird konservativ nicht als Erfolg
behandelt. Modelle ohne passenden strukturierten Assist-Resulttyp erhalten keine
Erfolgserfindung. Kein beliebiges neu angebotenes Tool wird automatisch freigegeben.

Installation und Voice-Preview-only-Rollback: `INSTALL-ROLLBACK.md`.
Auth-Primärquellen und noch blockierte Liveschritte: `../../docs/reference/ha-haiku.md`.
