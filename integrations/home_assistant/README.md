# Offtangent Conversation — Reviewpaket, nicht installiert

Separater deutscher HA-Konversationsagent: **HA → `/ha-relay/v1` im bestehenden
Offtangent-Backend → bestehender zentraler Anthropic-Abo-Provider/Refresh**.
HA speichert nur einen neuen Relay-Bearer; keine Anthropic-Anmeldung, Kopie des
Providerstores, eigener Proxy-/Claude-Prozess oder API-/Credits-Fallback.
Der normale Provider/SDK-Pfad und dessen vorhandenes Identity-/Header-Verhalten
bleiben unverändert; der Relay fügt keine neue Identitätsmanipulation hinzu.
Ein technischer Erfolg ist keine Aussage über Vertragsbedingungen/Abrechnung.

## Grenzen und Verhalten

- Eigene ConfigEntry/ConversationEntity, deutscher sicherer Prompt,
  Options-Reload und sauberes Unload. Steuerung standardmäßig **AUS**.
- HTTPS außer Loopback-HTTP; Basis exakt `/v1` oder `/ha-relay/v1`.
  Keine URL-Credentials, Query/Fragment, Redirects, Proxy-Umgebung oder POST-Retries.
- Nur aktuelle Assist-Tools und explizite Allowlist, einschließlich nativer
  Namespaces. Vollständige Batch-/Voluptuous-Validierung vor erstem Dispatch.
  Ausschließlich `llm.APIInstance.async_call_tool`, kein direkter Aktorservice.
- Maximal acht Inferenzrunden, acht Calls je Batch. Wiederholte Toolcalls werden
  abgewiesen. 110 Sekunden Turnlimit, 100 Sekunden HTTP-Limit.
  Entity-Lock ohne Warteschlange verhindert verspätete parallele Aufträge.
- Bestätigte Mutationen enden sofort mit fester, aus HA-Ergebnissen abgeleiteter
  Erfolgsantwort. Keine redundante Folgeinferenz, kein Wiederholen unbestätigter
  Aktionen. Query-/Info-Ergebnisse dürfen regulär zum Modell zurück, ohne sie
  fälschlich als Aktionsbestätigung behandeln zu müssen.
  Datums-/Zeit-/Enumwerte werden deterministisch serialisiert; unbekannte Typen,
  doppelte JSON-Schlüssel und nichtendliche Zahlen scheitern geschlossen.
- Mehrturn: nur eigene, begrenzte In-Memory-History je Conversation-ID **und**
  Gerät/Satellit, 30 Minuten TTL, maximal 64 Sessions/12 Nachrichten je Session.
  Kein Import fremder ChatLogs, Offtangent-Memory, SOUL oder anderer Agentenprompts.
  Modell-Toolsignaturen verbleiben im separaten serverseitigen Vault (5 Minuten,
  maximal 16 laufende Tool-Sessions); HA erhält
  sie nicht. Folgebezüge dürfen nie unbekannte Geräte erraten.
- `/ha-relay/v1/status`: Access-Ablauf separat, unbekannte Refresh-Laufzeit `null` statt
  erfundenem festen Ablaufdatum. Zentraler Locked-Refresh; bei Upstream-401 nur
  Credential-Reparatur, **kein** Replay des Inferenz-POST. Erst nächster eigener
  Turn darf erneut inferieren. 403/429 wechseln weder Identität noch Provider.
- HA pollt Authstatus beim Hinzufügen und minütlich rein lesend. Notwendiger
  Re-Login erzeugt eine deduplizierte persistente Warnung; verifiziert reparierter
  Zustand (`ready` nach Relay-Inferenz) löscht sie; `unknown` nach zentralem
  Re-Login oder ein Pollausfall löschen sie nicht. Bei Pollfehler wird
  `provider_auth_state=relay_unavailable` mit UTC-Fehlerzeitpunkt publiziert.
  Entityattribute zeigen auch den letzten erfolgreichen Pollzeitpunkt; beide
  Zeitpunkte und Backend-Auth-Beobachtungen sind bewusst RAM, nicht persistent.
  Entity/Diagnostics zeigen Authzustand, letzten Pfad und Degradationszähler,
  nicht die Credentials. Lifecycle/Neustartgrenzen: `INSTALL-ROLLBACK.md`.
- Optional genau ein bestehender lokaler Ollama-Agent als Ersatz: lokale URL,
  Ollama-Eintrag/Subentry und keine zusätzliche Steuerungsfreigabe prüfen.
  Nur **vor jeglichem Tool-Dispatch** darf ein Relayfehler auf diesen Agenten
  wechseln. Nach möglicher Ausführung/Timeout/Teilversagen kein Fallback oder
  Retry. Ersatz beginnt mit sicht-/hörbarer Degradationsmeldung und eigener
  Conversation-ID. Vorhandene Ollama-Konfiguration wird nicht verändert.
- Diagnose-Schemas können private Entity-/Area-Enums enthalten: lokal privat
  behandeln. Keine Tokens, URLs oder Assist-Systemprompts im Diagnoseexport.

## Reproduktion

```sh
scripts/test-ha-haiku.sh /ABSOLUT/HA-VENV/bin/python /ABSOLUT/evidence
```

Getestet: Python 3.14.2, HA 2026.9.4, aiohttp 3.14.3, probatio 0.11.4,
voluptuous 0.16.0; keine Drittanbieterrequirements in der Integration.
Das Skript führt begrenzte Vitest-Regressionssuite, Core-tsc, **alle** Backend-
Quellen/Tests mit worktree-eigener Core-Auflösung sowie Python-/AST-/JSON-Checks
aus. Die Backend-Prüfung verwendet `scripts/tsconfig-ha-backend.json`, weil dieses
Worktree `/app/node_modules` und dessen älteren Core-dist gemeinsam nutzt; keine
Tests werden ausgeschlossen, die Produktions-tsconfigs bleiben unverändert.
Zwei echte aiohttp/HTTP-Bridges sind offline: SDK mit synthetischen Wireevents und
simuliertem Tool sowie Python-Client gegen die tatsächliche Express-Relay-Mount.
Keine reale HA-Instanz/Services, STT-/TTS-/Voice-Hardwaretests oder Live-Relay-E2E.
Kein hassfest oder vollständiger Monorepo-Build als bestanden behauptet.

Installation und Voice-Preview-only-Rollback: `INSTALL-ROLLBACK.md`.
Architektur und aktuelle Evidenzgrenzen: `../../docs/reference/ha-haiku.md`.
