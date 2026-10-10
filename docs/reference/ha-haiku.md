# Haiku 5.5 / separater Home-Assistant-Agent — REVIEW ONLY

Stand: 2026-10-10. **Nicht produktiv installiert, nicht gemergt, nicht deployed.**

## Ergebnis und harte Grenze

Der HA-Wireadapter akzeptiert die explizite Kombination
`transport: "anthropic-oauth"`, `model: "claude-haiku-5-5"`, `thinking: "low"`.
Der Default-Transport gibt dabei **HTTP 503 / `anthropic_subscription_auth_blocked`**
zurück, BEVOR Providerdaten oder Credentials geladen werden. Es gibt weder
HTTP-/Config-Bypass noch API-Key-, Usage-Credit-, Modell- oder Codex-Fallback.
Das ist kein erfolgreich implementierter Live-Haiku-Transport. Die bestehende
Codex-Implementierung bleibt bestehen; sie ist keine Ausweichroute für Haiku.

Implementiert und getestet sind das generische HA-Integrationspaket, der neue
separate Conversation-Agent und die vollständige native Tool/Thinking-Wire-Seam.
Die installierte pi-ai SDK wird mit komplett abgefangenem Netztransport getestet.
Ein echter ungefährlicher Modellroundtrip wurde **wegen Auth-/Abrechnungsgrenze
nicht ausgeführt**. Frühere Benchmark-Erfolge sind kein Nachweis dieser Freigabe.
Unabhängiges Main-Review ist noch offen. Review allein hebt das Authgate nicht auf.

## Geöffnete Primärquellen / Authbefund

1. https://code.claude.com/docs/en/legal-and-compliance
   Abschnitt "Authentication and credential use": OAuth unterstützt gewöhnliche
   Nutzung von Claude Code und anderen nativen Anthropic-Anwendungen. Entwickler
   eigener Anwendungen sollen Console API-Key oder unterstützte Cloudprovider
   nutzen. Unverändertes Claude Code ist ausdrücklich ein anderes Szenario.
2. https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account
   Abschnitt "Authenticating to subscription plans": Anthropic kann bestimmte
   Dritttools bei aktivierten Usage Credits zulassen, aber deren Nutzung von
   Credits statt Abolimits abziehen. Dritttools mit falsch dargestellter Identität
   oder Routing von Dritttraffic gegen Abolimits werden ausdrücklich untersagt.

Beide Quellen wurden 2026-10-10 geöffnet. **Nicht** die pauschale Behauptung,
OAuth für Dritttools sei immer unmöglich: Die dokumentierte mögliche Zulassung
enthält eine vom Nutzer nicht genehmigte Credit-Abrechnung. Eine technisch
akzeptierte Antwort bestätigt weder Nutzungsfreigabe noch abonnementexklusive
Abrechnung.

Quellcodebefund: `provider-config.ts#buildModel` setzt für `anthropic-oauth`
`user-agent: claude-cli/...`. Die installierte SDK ergänzt `x-app: cli` und den
Systemblock `You are Claude Code, Anthropic's official CLI for Claude.`. Der
reproduzierbare **synthetische** Wiretest erfasst dies, ohne echte Credentials zu
laden. Header entfernen/ändern oder Identität weiter imitieren, um durchzukommen,
ist keine hier autorisierte Lösung. Bestehende Provider-/OAuth-Lifecycle-Dateien
wurden nicht verändert. Kein Secretstore, Credentialexport oder Tokenrefresh.

Vor Aktivierung erforderlich: belastbare Autorisierung für diesen konkreten
Drittclient **und** Nachweis der verlangten Abo-only-Abrechnung; anschließend
explizit unabhängig reviewte Implementierung des erlaubten Transportes. Die
aktuelle Gate-Zeile darf nicht einfach gelöscht werden. Ein nativer CLI-/Agent-
SDK-Neuentwurf oder kostenpflichtiger API-/Credits-Weg ist eine neue Entscheidung,
kein stiller Fallback dieses Pakets.

## Protokoll

Bestehender opt-in Loopbacklistener und eigener HA-Bearer bleiben getrennt von
Main-Router, Interview-Auth, Agenten, SOUL, Memory und Datenbank.

- Tools: explizite Allowlist UND exakt gepinnte Schemas, maximal 32; echte HA-Assist-
  Namen `Hass…` / `GetLiveContext`, optional namespaced (z.B.
  `homeassistant__HassTurnOff`). Kein beliebiges Service-/Shelltool.
- Haiku: ausschließlich explizites Low-Thinking; Sampling, caller effort und
  service tier werden abgewiesen. Kein `thinking: off` oder Modellfallback.
- Native Assistant-Nachricht mit Thinking und opaque Signatur bleibt serverseitig
  in einer nicht persistenten Vault. Weder Thinking noch Signatur verlassen sie.
- `ha_session` ist ein einmaliger, fünf Minuten gültiger Fortsetzungshandle,
  gebunden an exakt denselben Nachrichtenprefix und dieselben Tools. Nur genau
  die ausstehenden Resultate sind erlaubt. Replay, fremde Assistant-History,
  geänderter Prefix/Tools/Handle und zusätzliche Usernachrichten schlagen fehl.
- Keine neue Sitzung mit vom Client rekonstruierter signierter Assistant-History.
  Alle Browser-/HA-Aufrufer müssen diese Extension unterstützen. Der hier
  gelieferte Pythonclient tut dies; unmodifizierte Standardclients tun es nicht.
- Ganze Modellantwort wird vor Ausgabe geprüft: Modellpin, vollständiger Stream,
  Stopgrund, Tools/Argumente und Größenlimits. Kein partieller Action-Stream.
- Structured `success:false`, `error` und HA `response_type:error` markieren native
  Toolresults als Fehler. Keine Regex-Behauptung über Wahrheit von Modellprosa.

Der Offline-SDK-Wiretest sendet adaptive thinking, summarized display,
`output_config.effort: low`, `max_tokens: 4096`, kein temperature und keine fallbacks.
Das ist der tatsächliche simulierte SDK-Payload, **kein** Live-API-Akzeptanz- oder
Latenz-/Kostenbeleg. Die Mock-Modellmetadaten werden explizit im Test aufgebaut;
die spätere autorisierte Providerauflösung/Haiku-Metadaten müssen gesondert
verifiziert werden. Die heute produktive Haiku-Provideranbindung bleibt blockiert.

## HA-Paket

Siehe `integrations/home_assistant/README.md` und `INSTALL-ROLLBACK.md`.
`offtangent_conversation` erstellt ausschließlich eine neue ConfigEntry/Entity.
Die Optionen sind generisch: URL, eigener Adapterbearer, exakte Modell-ID,
Steuerung standardmäßig AUS, explizite Toolnamenliste. Keine OAuth-Credentials
in HA, keine fremde ConfigEntry-/Pipeline-/Exposure-Mutation.

Geprüft gegen **Home Assistant 2026.9.4, Python 3.14.2, probatio 0.11.4,
aiohttp 3.14.3, voluptuous 0.16.0** in einem isolierten Offline-Harness. Dieser nutzt
die echte ChatLog/LLMContext/Voluptuous/ToolInput-Bibliothek und ausschließlich
synthetische Toolimplementierungen ohne Serviceaufrufe oder reale Zustände.
Keine HA-Produktivinstallation und kein HACS-/hassfest-/Gesamtsuite-Gate behauptet.

Reproduzierbarkeit und exakte Befehle: `scripts/test-ha-haiku.sh`. Die Python-
Umgebung muss zuvor die HA-2026.9.4-Abhängigkeiten enthalten. Das Script installiert
nichts und nutzt kein Produktions-DATA_DIR. Größere Testumgebung/Installcache liegt
auf dem zuvor verifizierten NAS; kleine Reviewdateien liegen in /workspace.
