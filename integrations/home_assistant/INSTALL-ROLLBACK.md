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

- Bestehendes HTTPS-Ingress nur für `/ha-relay/v1/{models,status,chat/completions,session/discard}`
  freigeben; keine breite Freigabe von `/api` oder Admin-Endpunkten. Relay besitzt
  eigenen Bearer, normale Offtangent-Userauth wird dadurch nicht ersetzt.
  Ohne gültige opt-in-Datei ist der Relay nicht verfügbar. Dateikonfiguration
  wird beim Backendstart gelesen; Aktivierung/Änderung braucht kontrollierten
  Backendneustart, keine HA-/Providerprozess-Duplikate.
- GET `/ha-relay/v1/models` und `/ha-relay/v1/status` mit privatem Bearer
  prüfen. Catalog allein ist keine Inferenzbereitschaft; `unknown` ist zulässig,
  `ready` erst nach verifiziertem Relay-Inferenzresultat. Refresh-Ablauf darf `null`
  bleiben. Danach verpflichtender freigegebener harmloser Relayroundtrip mit
  `tools: []` (siehe unten); Status/Providerhealth ersetzt dieses Gate nicht.
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

## Status und Loginwarnung im Betrieb

- `/ha-relay/v1/status` ist ein rein lesender Auth-Beobachtungsstatus, kein
  Inferenztest. `ready` beruht auf einer zuvor erfolgreichen Relay-Inferenz;
  ein GET beweist weder aktuelle Upstream-Erreichbarkeit noch Modell-Wire-ID.
- HA pollt initial und minütlich. Bei Poll-/Antwortfehler wird
  `provider_auth_state=relay_unavailable` publiziert, nicht der alte `ready`-Wert.
  `auth_status_last_success_at` und `auth_status_last_error_at` sind UTC-Zeitpunkte
  der letzten erfolgreichen/fehlgeschlagenen **Statusabfrage** (keine Turnzeiten).
  Der Fehlerzeitpunkt bleibt nach Erholung als Historie sichtbar. Ausfallerkennung
  erfolgt spätestens beim nächsten Poll, nicht unmittelbar beim Netzausfall.
- `relogin_required` erzeugt eine persistente Warnung mit fester ID je Entry,
  ohne Duplikate. Zentraler Re-Login verändert den Credentialstamp: Status kann
  zunächst `unknown` sein und `relogin_required=false`, die vorhandene Warnung
  bleibt aber absichtlich stehen. Auch ein Pollausfall löscht sie nicht.
  Erst eine erfolgreiche Relay-Inferenz (`ready`, direkt oder beim nächsten Poll
  beobachtet) löscht die Warnung. Nicht zur Warnungsbeseitigung Aktionen auslösen.
- Backend-Auth-Beobachtungen sind bewusst **nur RAM**: Backendneustart verliert
  erkannte Refresh-/Re-Loginfehler; dann `unknown`/`access_expired`, bis ein neuer
  Turn frische Evidenz liefert. Auch HA-Pollzeitpunkte sind RAM und gehen bei
  Entryreload/HA-Neustart verloren. Keine persistierte Authgesundheit behaupten.

## Harmloses Relay-Gate nach externem Deploy (vor HA-Steuerung)

Erst nach Main-Nachreview und gesonderter Deploymentfreigabe; hier nicht ausgeführt.
Direkt an `POST /ha-relay/v1/chat/completions`, privater dedizierter Relay-Bearer,
kein HA-Agent oder `conversation.process`. Private Relaykonfig `tools: []` belassen:

```json
{
  "model": "claude-haiku-5-5",
  "messages": [{"role": "user", "content": "Antworte nur mit OK."}],
  "tools": [],
  "tool_choice": "none",
  "stream": false
}
```

Genau ein Versuch, keine automatischen POST-Retries. Erwartet: HTTP 200, exakt
gepinntes Modell, `finish_reason=stop`, Textantwort, keine `tool_calls`; anschließend
Status `ready`. Zeit, HTTPcode, Modell, Finishreason und toolcall-Anzahl redigiert
festhalten; keine Tokens/Header/private URLs. Ein abweichendes Modell oder
`incomplete_or_wrong_model` bleibt ein Stop-Gate (Wire-ID bisher nur offline
geprüft). Bei Fehler keine Tools/Voice-Zuordnung aktivieren, keine API-Key- oder
Modellausweichroute: externen Rollback/Analyseweg verwenden.

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

## Update einer installierten Komponente (0.1.0 -> 0.2.0, Branch fix/boot-warnings)

Nur nach Review und Deployfreigabe, zusammen mit dem Backend-Deploy des Branches.
Quelle ist ausschließlich `integrations/home_assistant/custom_components/offtangent_conversation/`
aus dem reviewten Commit (`git archive <sha> integrations/home_assistant/custom_components/offtangent_conversation`),
keine Tests, kein `__pycache__`.

1. Bestand sichern: Ordner `/config/custom_components/offtangent_conversation` nach
   `/config/offtangent_conversation.bak-<YYYYMMDD-HHMM>` kopieren (außerhalb von
   `custom_components`, sonst lädt HA die Kopie als zweite Integration), `__pycache__`
   weglassen, `sha256sum` von Host und Backup vergleichen.
2. Vorher prüfen, dass der Host dem bisherigen Repo-Stand entspricht (sha256 aller
   `*.py`, `manifest.json`, `strings.json`, `translations/de.json`). Abweichung = Stop.
3. Die 14 Dateien aus dem Archiv über den Ordner kopieren (geändert in 0.2.0:
   `__init__.py`, `config_flow.py`, `const.py`, `conversation.py`, `manifest.json`,
   `ollama.py`, `strings.json`, `translations/de.json`), `__pycache__` löschen.
4. `ha core check`, dann `ha core restart`. Ein Reload des Config-Entrys reicht nicht:
   Python-Module werden nur beim Start neu geladen.
5. Nachher: sha256 Host == Archiv; Entry geladen; im HA-Log keine Fehler von
   `offtangent_conversation`. Der bestehende Entry hat kein `local_keep_alive` und
   bekommt den Default `15m` (vorher fest -1). Wer dauerhaft geladen will, setzt im
   Options-Flow `-1`; ein Speichern des Options-Flows lädt nur diesen Entry neu.
6. Prüfen, passiv und ohne Aktoren: keine eigene Testäußerung, keine Probe-Frage. Der
   Warm-Ping startet erst nach dem ersten lokalen Turn seit dem Neustart (vorher fehlt ihm
   der Prompt). Deshalb den nächsten regulären Sprach-Turn des Haushalts abwarten; der
   Warm-Ping danach (Intervall 5 min) liefert den Nachweis. Kommt kein regulärer Turn, wird
   nicht nachgeholfen; die Prüfung bleibt offen, bis einer kommt.

   Nachweis: spätestens 5 min nach diesem regulären Turn steht im Turn-Log ein
   `"kind": "warm"`-Eintrag ohne `error` (mit `prompt_eval_count`/`wall_ms`); im Ollama-Log auf dem Mac keine 500 mehr
   zum Warm-Ping. Ein Warm-Eintrag mit `"error": "preempted_by_turn"` ist normal: ein
   Nutzer-Turn hat einen laufenden Ping abgebrochen, statt auf ihn zu warten. Ohne HA-Pings
   entlädt Ollama das Modell nach 15 min (`ollama ps` auf dem Mac).

Rollback: Backup-Ordner zurückkopieren, `__pycache__` löschen, `ha core check`,
`ha core restart`. Der Options-Wert `local_keep_alive` bleibt im Entry stehen und wird
von 0.1.0 ignoriert.
