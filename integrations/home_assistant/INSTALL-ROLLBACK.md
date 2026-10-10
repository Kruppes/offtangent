# Installation / Rollback — NICHT in dieser Phase ausführen

## Stop-Gates

1. Frischer unabhängiger Main-Reviewer bestätigt Diff/Tests/HA-APIs und Sicherheits-
   grenzen. Autorenchecks sind ausdrücklich kein unabhängiges Review.
2. Dokumentierte Drittclient-Autorisierung **und abonnementexklusive Abrechnung**
   sind geklärt; der derzeit fehlende erlaubte Anthropic-Livetransport wird separat
   implementiert, negativ getestet und unabhängig reviewt. Gate nicht wegpatchen.
3. Neue Explizitfreigabe für externes Offtangent-Deploy, HA-Dateiinstallation und
   Voice-Preview-Zuordnung. Kein Selfdeploy des laufenden Containers.

Ohne alle drei Gates gibt es keine produktive Haiku-Installation. Das derzeitige
Paket kann nach Review allenfalls in einer isolierten Mock-HA-Umgebung installiert
werden. Die Schritte unten sind die konkrete spätere Reihenfolge, kein Runbook
zum Umgehen der Authsperre.

## A. Private Sicherung und Bestandaufnahme (später)

- HA-Backup über HA erstellen, verschlüsselt privat speichern. Keine produktive
  `.storage` in Git, Review-ZIP oder allgemeine Logs kopieren.
- Read-only notieren/fingerprinting: Ollama ConfigEntry inklusive Options/Modell,
  alle bestehenden Pipelines inklusive preferred-ID, STT/TTS-IDs und Sprachen,
  Entity-Exposure, Voice-Preview-Device und dessen aktuelle Assist-Select-Option.
  Auch Adapterdienst-/Proxykonfiguration sichern. Nichts an fremden Entries ändern.
- Nur konkrete Voice-Preview-`select.…_assist_pipeline`-Entity über Device Registry/
  Geräteeinstellungen identifizieren; keine geratenen Entity-IDs verwenden.

## B. Neuer Adapterlistener und generische HA-Integration (später)

- Release/Deployment ausschließlich extern über den bereits genehmigten Betreiber-
  weg; eigenständiger opt-in Listener, nicht der Main-/Interview-Router.
- Neuen zufälligen HA-Bearer lokal privat erzeugen (mindestens 32 Randombytes).
  SHA256 in private Adapterkonfig, Rohwert nur an diese neue HA ConfigEntry.
  **Nie** Anthropic-Access/Refresh-Credentials kopieren oder HA zugänglich machen.
- Privates `ha-inference.json`, chmod 0600; Beispiel ausschließlich Template:

```json
{
  "enabled": true,
  "transport": "anthropic-oauth",
  "thinking": "low",
  "tokenSha256": "<SHA256-des-NEUEN-HA-Bearers>",
  "providerId": "<vorhandene-freigegebene-Anthropic-OAuth-Provider-ID>",
  "model": "claude-haiku-5-5",
  "tools": [],
  "timeoutMs": 100000,
  "maxBodyBytes": 262144,
  "maxCallsPerHour": 100
}
```

- Bestehender CLI: `DATA_DIR=/data pnpm exec tsx scripts/ha-inference.mts
  /ABSOLUT/privat/ha-inference.json 3107`; vorhandene Dienstumgebung nutzt bestehende
  verschlüsselte Providerkonfiguration/OAuth-Lifecycle. Kein Credentialexport.
  Aktuelle Version antwortet weiterhin 503 auf Haiku-Inferenz; Start kein Authbeleg.
- Nur Loopback-Port veröffentlichen, davor TLS-Proxy mit HA-Netzallowlist, ohne
  Redirects/POST-Retries, 256-KiB-Bodylimit und passender Timeoutgrenze. Nur
  `/v1/models` und `/v1/chat/completions` routen. Kein automatischer Start dieses
  Listeners durch die Branch, keine neue Compose-/Firewallkonfiguration geliefert.
- Nur `custom_components/offtangent_conversation/` in HA-Konfigverzeichnis kopieren.
  Neue Custom-Domain erfordert zuverlässig einen **einmalig vorab abgestimmten HA-
  Neustart** zur Integrationsentdeckung; Optionsänderungen danach Entry-Reload.
  Keine Installation in dieser Phase; Restart nicht ohne Nutzerfreigabe auslösen.
- Einstellungen → Geräte & Dienste → Integration hinzufügen → Offtangent
  Conversation. HTTPS-Adapterbasis endet `/v1`, neuer HA-Bearer,
  Modell `claude-haiku-5-5`, zunächst **Steuerung AUS**, Allowlist `[]`.
  Neue Entity eindeutig benennen. Vorhandene Ollama Entity nicht anfassen.
- Ein neuer ConfigEntry-/Entity-Readback bestätigt nur Konfiguration. Danach erst
  genehmigter harmloser Modellroundtrip mit technisch ausgeschalteten Aktionstools.
  **Kein** `conversation.process` oder Aktor-/Automation-Service zur Verifikation.
  Harmloser Test direkt über abgesicherten Adapter mit `tools: []`, nicht einen
  steuerungsfähigen HA-Agenten kontaktieren.

## C. Exakte erlaubte Assist-Tools vorbereiten (später)

- Allowlist zunächst gezielt setzen; Steuerung nur nach Freigabe an dieser neuen
  Entry AN. Keine globale Exposureänderung. Maximal 32 Namen, native Namespaces
  beibehalten. Kein execute_services-/Shell-/Script-/Automationtool zulassen.
- Neue Entry → Diagnosedaten herunterladen: `tools` enthält exakt die ausgewählten
  installierten Assist-Toolbeschreibungen und JSON-Schemas. Rein lesend, kein
  Dispatch. Lokal privat ablegen; mögliche private Enumdetails nicht veröffentlichen.
- Diese ausgewählten `tools` exakt in private Adapterkonfig übernehmen. Native
  Schemaexport gegen Reviewerfreigabe prüfen, danach Listenerkonfig neu laden
  durch kontrollierten Dienstrestart. Beispielschemas aus Tests nie dafür nutzen.
- Nur Offline-/Mocktools für Toolcall/Result/Final-Verifikation verwenden. Aktoren
  nicht zur Integrationstestung schalten. API-Argumentvalidierung ist keine
  Garantie semantischer Geräteauflösung; Exposure/Berechtigungen beibehalten.

## D. AUSSCHLIESSLICH Voice Preview zuordnen (später)

- NEUE Assist-Pipeline `Voice Preview – Haiku` anlegen. STT/TTS/Wakeword/Sprachen
  exakt aus der bisherigen Voice-Preview-Pipeline übernehmen, einzig
  Conversation Engine = neue Offtangent Entity. Bestehende Pipeline **nicht**
  überschreiben und neue Pipeline **nicht** zur preferred/default erklären.
- Auf dem konkreten Voice-Preview-Gerät dessen Assist-Pipeline-Auswahleintrag auf
  den exakten Namen der neuen Pipeline setzen (UI). Keine anderen Satelliten,
  mobile App, Automationen oder Defaults ändern. Kein Aktorservice als Test.
- Read-only-Readback: neue Pipeline/Entity/Selectoption prüfen; alle bestehenden
  Ollama Entry-/Options-/Pipeline-/Exposure-/STT-/TTS-Fingerprints unverändert
  vergleichen. Produktivbackup ist privat. Nicht behaupten, Hardware/STT/TTS
  seien mit Offline-Tests validiert worden.

Primärquelle für gerätespezifische Select-Zuordnung: Nabu Casa Support,
"Changing the selected assistant" (geöffnet 2026-10-10):
https://raw.githubusercontent.com/NabuCasa/support/main/src/voice-pe/customizing/automations-scripts.md
Die HTML-Support-URL lieferte 403; der offizielle Repository-Quelltext wurde gelesen.
Dieser nennt `select.…_assist_pipeline` und den exakten Assistantnamen. Hier wird
bewusst kein select-Service zur Verifikation ausgeführt.

## Rollback (später, ohne Aktoren)

1. Nur Voice-Preview-Assist-Select auf die zuvor gesicherte konkrete Option zurück.
2. Neue Pipeline löschen, sobald nichts mehr auf sie zeigt. Preferred-ID unverändert.
3. Nur neue Offtangent Entry entfernen/unload; HTTP-Session schließt. Ollama unverändert.
4. Eigenständigen HA-Adapterdienst/TLS-Route deaktivieren, neuen HA-Bearer widerrufen.
   Vorherige Proxy-/Dienstdateien gezielt aus Backup wiederherstellen.
5. Nur neu kopierten Custom-Component-Ordner entfernen; falls nötig abgestimmter
   HA-Neustart. Keine globale `.storage`-Rücksicherung über inzwischen fremde Änderungen.
6. Dieselben read-only Bestandsfingerprints prüfen. Kein `light.turn_on/off`,
   `switch`, `cover`, `automation.trigger`, `conversation.process` oder STT/TTS-Livejob.

Rollback ist beschrieben, **nicht** produktiv ausgeführt oder als getestet behauptet.
