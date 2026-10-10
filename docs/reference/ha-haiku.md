# Haiku 5.5 / HA-Relay — aktueller Reviewstand 2026-10-10

## Verbindliche Architektur

`HA Custom ConversationEntity → bestehendes Offtangent-Backend /ha-relay/v1 →
bestehender zentraler Anthropic-Abo-Provider (claude-haiku-5-5)`.

Kein separater Proxy-/Claude-/Refreshprozess, eigener HA-Providerstore,
API-Key-/Credits-Fallback, neue Identity-/Header-Manipulation oder Änderung anderer
Pipelines/Ollama/STT/TTS. HA bekommt ausschließlich seinen neuen Relaybearer.
Der Relay nutzt `getApiKeyForProvider`, `buildModel`, `streamSimple` und den
vorhandenen `refreshOAuthCredentialsLocked`; bestehendes SDK-Verhalten bleibt
unverändert. Der frühere Prototyp-Authblocker ist historisch, nicht der heutige
Produktionsdefault. Der bestehende Codex-Prototyp-/Interviewpfad bleibt erhalten.
Keine neue Zulässigkeitsrecherche; technische Tests beweisen keine Vertrags-
oder Abo-Abrechnungszusage.

## Implementierte Sicherheitsgrenzen

- Backend-Opt-in in privater regulärer `${DATA_DIR}/config/ha-inference.json`;
  SHA-256 Relay-Verifier, exakter zentraler OAuth-Provider-/Modellpin, schemaexakte
  Assist-Allowlist. Abwesend/deaktiviert/ungültig bedeutet unavailable.
  Eigener Relaybearer schützt auch Models/Authstatus; kein Zugriff auf Admin-APIs.
- Access-Expiry getrennt von notwendigem Re-Login, unbekannte Refresh-Expiry `null`.
  Credentialbezogener Authzustand invalidiert bei zentraler Credentialänderung.
  HA pollt Authstatus beim Hinzufügen und minütlich, Loginwarnung dedupliziert.
  Kein Token/Upstreambody in Diagnosen, Status oder Fehlermeldungen.
- Upstream-401: ein Inferenz-POST, zentrale Refresh-Reparatur, **kein** Inferenzreplay.
  403/429: kein Refresh-/Identitäts-/Provider-/Creditswechsel. `maxRetries: 0`.
- Buffer bis vollständigem Modellresultat; Modell-/API-/SSE-/Tool-/Argumentprüfung,
  Duplicate-JSON-/NaN-/Infinity-/Truncation-Schutz, Request-/Output-/Raten-/Zeitlimits,
  Disconnect/Cancellation und kein nur teilweise ausgelieferter Toolbatch.
- Signiertes Thinking verbleibt nur im kurzlebigen In-Memory-Sessionvault.
  Exakter HA-Folgeprefix/Toolschema-Pin und einmals verwendbare Continuation-ID
  verhindern Transcript-Swaps/Replay. HA-ChatLog markiert Tools extern ausgeführt.
- Eigene Mehrturn-History, keine Offtangent-Memory/SOUL/fremden Agentenprompts.
  Conversation-ID plus Gerät/Satellit, begrenzte Sessions/Nachrichten und TTL.
- Mutationsbestätigung ausschließlich aus strukturiertem HA-Ergebnis; danach
  feste Bestätigung ohne Folgeinferenz. Query-/Infotools dürfen zum Modell zurück;
  Datum/Zeit/Enum serialisieren deterministisch. Unbekannte Typen fail closed.
- Lokaler Fallback nur vor **jeglichem** Tool-Dispatch. Bei möglicher/teilweiser
  Aktion, Timeout, Cancellation, Wiederholung oder unklarer Bestätigung niemals
  Fallback/Retry. Eigene Fallback-Conversation-ID, sichtbare Degradationsantwort,
  Zähler/Entityattribute, keine Ollama-Konfigänderung oder Steuerungseskalation.

## Tatsächliche Messung (kein Live-Relay-/HA-E2E)

Am 2026-10-10 10:39:36 UTC wurde der bereits laufende **normale** Backend-
Providerhealthpfad `/api/providers/{id}/test` mit `modelId: claude-haiku-5-5`
aufgerufen. Bestehender Healthprompt: `Respond with OK only.`; keine Tools/HA.
Resultat: HTTP **200**, `success: true`, `status: healthy`, `modelId:
claude-haiku-5-5`, gemeldete Modelllatenz **603 ms**, gemessener Gesamtrequest
**622 ms**. Der vorhandene Healthpfad aktualisiert nur Providerhealthstatus.
Kein Roh-Wire-/Tokenusage-/TTFT-/Kosten- oder Live-Relayausführungsbeleg aus
Healthresponse; diese Werte werden ausdrücklich nicht erfunden.

Offline-Gates: `scripts/test-ha-haiku.sh /ABSOLUT/HA-VENV/bin/python /ABSOLUT/out`.
Runtime: HA 2026.9.4 / Python 3.14.2 / aiohttp 3.14.3 / probatio 0.11.4 /
voluptuous 0.16.0 / vorhandenes pi-ai 1.0.0. Der Lauf prüft Core-tsc und sämtliche
Backendquellen/tests gegen dieses Worktree-Core mit `scripts/tsconfig-ha-backend.json`
(keine Ausschlüsse); Shared `/app/node_modules` würde sonst alten Core-dist laden.

Echte lokale HTTP-/Bibliothekstests mit **synthetischen** Modellen/Tools:
1. Python-aiohttp → Node-Seam → echte SDK/SSE-Verarbeitung → genau ein simulierter
   Toolcallback, feste strukturierte HA-Bestätigung und keine redundante Inferenz.
2. Python-aiohttp → reale Express-Mount `/ha-relay/v1` → Models/Authstatus/Completion;
   synthetischer Provider, null Tools/Services, `Synthetic OK`.
3. Echte HA ChatLog/LLMContext/Voluptuous mit synthetischer APIInstance; Mehrturn,
   Query-Serialisierung, Teilfehler, Fallback-Isolierung und aktiver Loginwarnung.

Nicht behauptet: installierte HA-/Voice-Preview-End-to-End-Validierung,
STT/TTS-/Aktor-/Automationstests, Produktions-Tool-Wireakzeptanz, bestehende
HA-Konfig-Vorher/Nachher-Messung, Rollback-Ausführung, hassfest, vollständiger
Monorepo-Build oder externe unabhängige Reviewfreigabe. Authstatus `ready` entsteht
nur aus verifiziertem Relayresultat, nicht Models-Catalog oder Healthprobe.

## Review und spätere Installation

Installierbares Paket: `integrations/home_assistant/custom_components/offtangent_conversation/`.
Details/privates Setup/Voice-Preview-only-Rollback:
`integrations/home_assistant/INSTALL-ROLLBACK.md`.

**Vor unabhängigem Review kein Merge, Deploy, HA-Installation oder Pipelinewechsel.**
Unabhängiger Reviewer prüft vor allem Auth-/Refreshabgrenzung, Fallback-nie-nach-
Dispatch, Multi-Device-Memorygrenzen, Query-/Mutationssemantik und echte HA-APIs.
