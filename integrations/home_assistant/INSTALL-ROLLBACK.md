# Installation / Rollback — nach unabhängigem Review, NICHT bereits ausgeführt

## Stop-Gates

1. Unabhängiger Reviewer bestätigt vollständigen Diff, Sicherheitsgrenzen,
   tatsächliche HA-APIs und Testbelege. Autorenchecks sind kein unabhängiges Review.
2. Danach explizite Freigabe für externes Offtangent-Deploy, HA-Dateiinstallation
   und ausschließlich die Voice-Preview-Zuordnung. Kein Selfdeploy des laufenden
   Containers; normales externes Deployverfahren verwenden.
3. Bestehende zentrale Anthropic-Anmeldung funktioniert für den gepinnten
   Provider/Haiku. Kein separates Credential-Verfahren oder Header-/Identitypatch,
   kein API-Key-/Credits-Fallback. Technische Probes beweisen keine Abo-Abrechnung.

Der ehemalige pauschale `anthropic_subscription_auth_blocked` ist durch den
freigegebenen **bestehenden zentralen Providerpfad** ersetzt, nicht durch einen
neuen Proxy. Vor Review bleiben Merge, Deploy und HA-Umschaltung gesperrt.

## A. Private Sicherung und Bestandaufnahme

- Privates HA-Backup erstellen. Bestehende Ollama Entries/Options/Subentries,
  Entity-/Exposureauswahl, Pipelines, preferred-ID, Voice-Preview-Geräteoption,
  STT/TTS/Wakeword/Sprachen und aktuelle Backendversion rein lesend sichern.
  Kein unredigierter `.storage`-/Schema-/Credentialexport in Git/Reviewpaket.
- Backendkonfiguration/TLS-Routing privat sichern. Refresh-/Accessdateien nicht
  kopieren: der Relay verwendet denselben vorhandenen zentralen Providerstore.
- Exakte vorhandene Provider-ID und aktiviertes `claude-haiku-5-5` über normale
  Providerverwaltung prüfen. Lokalen Ollama-Agenten nur auswählen, nie verändern.

## B. Backend opt-in aktivieren (nach Freigabe)

- Reviewten Backend/Core-Code extern zusammen deployen; regulären Core-vor-
  Backend-Build ausführen. Nicht mit dem älteren `/app`-Core-dist dieses Review-
  Worktrees mischen. Eigener Prozess oder Listener ist nicht erforderlich.
- Einen **neuen ausschließlich HA-spezifischen** Bearer kryptographisch erzeugen,
  in privatem Passwortspeicher halten. SHA-256 davon in
  `${DATA_DIR}/config/ha-inference.json` ablegen (Modus **0600**, reguläre Datei,
  kein Symlink, nicht group/world-readable). SHA-256 ist ein Auth-Verifier und
  ebenfalls privat. Keine Produktionswerte aus diesem Beispiel übernehmen:

```json
{
  "enabled": true,
  "transport": "anthropic-oauth",
  "tokenSha256": "REPLACE_WITH_64_LOWERCASE_HEX_SHA256",
  "providerId": "REPLACE_WITH_EXISTING_CENTRAL_PROVIDER_ID",
  "model": "claude-haiku-5-5",
  "thinking": "low",
  "timeoutMs": 15000,
  "maxBodyBytes": 262144,
  "maxCallsPerHour": 60,
  "tools": []
}
```

- Bestehendes HTTPS-Ingress nur für `/ha-relay/v1/{models,auth/status,chat/completions}`
  freigeben; keine breite Freigabe von `/api` oder Admin-Endpunkten. Relay besitzt
  eigenen Bearer, normale Offtangent-Userauth wird dadurch nicht ersetzt.
  Ohne gültige opt-in-Datei ist der Relay nicht verfügbar. Dateikonfiguration
  wird beim Backendstart gelesen; Aktivierung/Änderung braucht kontrollierten
  Backendneustart, keine HA-/Providerprozess-Duplikate.
- GET `/ha-relay/v1/models` und `/ha-relay/v1/auth/status` mit privatem Bearer
  prüfen. Catalog allein ist keine Inferenzbereitschaft; `unknown` ist zulässig,
  `ready` erst nach verifiziertem Relay-Inferenzresultat. Refresh-Ablauf darf `null`
  bleiben. Optional freigegebener harmloser Relayroundtrip mit `tools: []`.
  **Kein** `conversation.process`, Aktorservice oder Automationstest.
- Bearer-/Providerdateien niemals in Logs, Shellhistory, Screenshots oder Git.

## C. Neue HA-Integration/Entry

- Nur `custom_components/offtangent_conversation/` aus dem geprüften Install-ZIP
  kopieren, keine Tests/Evidence oder existierenden Ollama-Dateien. Für erstmalige
  Custom-Component-Erkennung kann ein abgestimmter HA-Neustart nötig sein;
  danach Options-Reload verwenden. In dieser Phase ist kein Restart freigegeben.
- Neue Integration **Offtangent Conversation** hinzufügen: HTTPS-Basis
  `https://offtangent.example.invalid/ha-relay/v1`, neuer Relay-Bearer,
  Modell `claude-haiku-5-5`, Steuerung **AUS**, Allowlist `[]`.
  Optional bestehenden lokalen Ollama-Conversation-Agenten auswählen.
- Fallbackvalidierung verlangt echte lokale Ollama-Konfiguration/Subentry und
  verhindert Steuerungseskalation. Remote-/Cloud-/fremde Agenten werden abgewiesen.
  Bei Relayausfall bleibt eine korrekt konfigurierte Entry mit lokalem Ersatz
  ladbar; falscher Relaybearer und ungültige Konfiguration bleiben Setupfehler.
- Rein lesend Entry/Entity zurücklesen. Authstatus ist als Entityattribute sichtbar;
  Loginwarnung pollt automatisch/minütlich und ist dedupliziert. Keine feste
  Refresh-Laufzeit behaupten; nötig werdenden Login ausschließlich zentral erneuern.

## D. Allowlist und ausschließlich Voice Preview (später)

- Steuerung ausschließlich nach eigener Freigabe an der neuen Entry aktivieren.
  Nur bestehende Assist-Exposure/Tools übernehmen; keine globale Exposureänderung,
  kein Shell-/Script-/Automation-/execute_services-Tool.
- Diagnosedaten dieser Entry exportieren: exakte allowlistete Tools mit nativen
  Namespaces/Schemas privat halten. Diese Schemas nach Review in die private
  Relaydatei übernehmen; synthetische Testschema-Beispiele niemals produktiv nutzen.
- Neue Assist-Pipeline `Voice Preview – Haiku` erstellen: STT/TTS/Wakeword/Sprache
  aus bestehender Voice-Preview-Pipeline unverändert übernehmen; nur Conversation
  Engine auf neue Offtangent Entity. Nicht preferred/default setzen, vorhandene
  Pipeline nicht überschreiben.
- Nur am konkreten Voice-Preview-Gerät dessen Assist-Pipeline-Auswahl auf diesen
  neuen Namen setzen. Andere Satelliten, Apps, Automationen und Defaults unverändert.
- Rein lesend alle gesicherten Fingerprints vergleichen. Keine Aktoren bewegen
  und Hardware/STT/TTS nicht mit Offline-Tests als validiert darstellen.
  Gerätezuordnung ist über UI-Select möglich; hier keinerlei Select-Service-Test.

## Rollback (beschrieben, nicht produktiv getestet)

1. Ausschließlich Voice-Preview-Auswahl auf die gesicherte vorherige Pipeline zurück.
2. Neue Pipeline entfernen, wenn keine Zuordnung mehr darauf zeigt; preferred bleibt.
3. Neue Offtangent Entry entfernen/unload: Polltimer und HTTP-Session schließen;
   bestehende Ollama-Entries/Optionen/Models/Exposure bleiben unangetastet.
4. Relay in eigener Datei `enabled: false` oder Datei entfernen und kontrolliert
   Backend neu starten; ausschließlich zugehöriges Ingress deaktivieren. Neuen
   Relaybearer widerrufen. Zentrale Provideranmeldung **nicht** löschen/zurückrollen.
5. Nur neu installierten Custom-Component-Ordner entfernen, nötigen Restart abstimmen.
   Backendrevision bei Bedarf extern auf gesicherte vorherige Version zurücksetzen.
   Kein globales `.storage`-Restore über inzwischen fremde Änderungen.
6. Dieselben rein lesenden Fingerprints prüfen; keine `conversation.process`,
   `automation.trigger`, `light`, `switch`, `cover`, STT-/TTS-Livejobs als Rollbacktest.
