/**
 * Synthetic corpus for the secret detector (plan 2026-09-26, gate V1, risk R8).
 *
 * EVERY value in this file is FAKE and generated with a seeded PRNG. There is
 * no real credential here, not even an expired one, and no personal data — the
 * only names used are Alice and Bob. The file is listed in the gitleaks
 * allowlist (.gitleaks.toml) because its whole purpose is to look like leaked
 * material to a scanner.
 *
 * Gate: 0 missed positives and 0 false positives, for both tiers.
 */

export interface CorpusPositive {
  /** Stable id, used in test output. */
  id: string
  /** Tier the sample must be caught in. `strong` samples must also be caught in `user`. */
  tier: 'strong' | 'user'
  text: string
  /** Exact secret values the detector must report, in order of appearance. */
  expect: Array<{ kind: string; value: string }>
}

export interface CorpusNegative {
  id: string
  text: string
}

// --- synthetic token material ----------------------------------------------

const GHP = 'ghp_IvhnXqk7OEXxY2dGDZBMvQDoCkDb1au5mEJJ'
const GHO = 'gho_qhu95rqxeJg5yyryTkGcp2Ze4vRzRtRDeI9G'
const GHS = 'ghs_R6I2UNdBtJCFNgWDZowk0mgmaKH6CzdeJukE'
const GHU = 'ghu_97tObC1fLD7nwgi5Z6XkpAoLmt9Ln7bOykx2'
const GH_PAT = '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'
const ANT_KEY = 'sk-ant-api03-6Wrf8UK3JUCj2fDSArLUVzIkhFNV5yhz3Z4Dw3AsEeOk7iWJ14RPnxNl97qMJrmN'
const OAI_PROJ = 'sk-proj-aWuzgRZaFyi3QTEyRYSr65UFPZiiymFuP7AooaOY50MqJWLK'
const OAI_KEY = 'sk-5ylJUfhGZvZFPaQg6NNr1muuaM1uvnx6ErYJMRTCWUQKrmkB'
const AKIA = 'AKIAEY2YHMXBZVF6I37X'
const ASIA = 'ASIA7ZDP7YNNFQWIQZCL'
const SLACK_B = 'xoxb-665317396913-774341478785-bewzdfy7nId7gjDgW2UGI6v9'
const SLACK_P = 'xoxp-299256047756-72Ut6Brmdo0cLuPJsthPy2Tl'
const SLACK_A = 'xoxa-279168996258-DVA2JIsNSDSEsPG7izDT'
const SLACK_S = 'xoxs-873938645323-6AcL6fEZz4hQoSM31JKe'
const GLPAT = 'glpat-C7wSRARjFJMtEo7de7MY'
const GOOGLE_KEY = 'AIzatawhvZjGSCs1JEsOLw0N6KFQBbaANcJC8qi'
const JWT_HS = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJkZW1vLXVzZXIiLCJuYW1lIjoiQWxpY2UgRXhhbXBsZSIsImlhdCI6MTcwMDAwMDAwMH0.yLfOY137yan-MAlWhlNgrJCHh0Qk7t9Fma0diM7lOQV'
const JWT_RS = 'eyJhbGciOiJSUzI1NiIsImtpZCI6ImRlbW8ta2V5LTEifQ.eyJpc3MiOiJodHRwczovL2F1dGguZXhhbXBsZS5jb20iLCJleHAiOjE4MDAwMDAwMDB9.wQXqgT26IXXCMppbTAzo16IfC0HhrD40RS-zBshquQ3Mq-Pk2jzIfoEUTrEU0EbDDF65O3bwogl1jTUI8NL5BT'
const NOT_A_JWT = 'eyJub3Rhand0Ijp0cnVlLCJraW5kIjoiY29uZmlnIn0.02gJuamgzovcfs7g8r6e.fyUAXtm7TPpB0oSuVt0d'

const PEM_RSA = [
  '-----BEGIN RSA PRIVATE KEY-----',
  'P/4gyesZj9ug2mUdjgk0KNwqxZWRhrX32kUZPxiZp56xMID7a8nHlejllSXZSu79',
  'cB0XKOcZweI5BxrQG/bPvAv/LrJO+YxZWCKslGCPOYbce/lfzbd+HSyouB7jp377',
  '-----END RSA PRIVATE KEY-----',
].join('\n')

const PEM_EC = [
  '-----BEGIN EC PRIVATE KEY-----',
  'LRgid0MrSlxGsZipr/KHED7jKjhZ25UxrFu7Omf+waBV06SebfuGO7iJc5HsfDHe',
  '-----END EC PRIVATE KEY-----',
].join('\n')

const PEM_OPENSSH = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'M/rEZPwXnB/XEKjStHpMv6l5grjmWCVT01ilmcvwDBSU2sBS+6He3pzHxUQR3NYh0hIQbX',
  '-----END OPENSSH PRIVATE KEY-----',
].join('\n')

const PEM_PLAIN = [
  '-----BEGIN PRIVATE KEY-----',
  'M+GDP4DYHyEowYprGgRpDUeILvCDZ2xtm/Cy8cDpsExeU6lAZa7BtWytnKQfv+Qr',
  '-----END PRIVATE KEY-----',
].join('\n')

const PEM_PGP = [
  '-----BEGIN PGP PRIVATE KEY BLOCK-----',
  '',
  'Wdrzv7dmD0jk9vQR5lsmoSSVsD1FsKf3lC+iV2zOFEJpUus1Sb5owp7hwoZ3fvYa',
  '-----END PGP PRIVATE KEY BLOCK-----',
].join('\n')

const PEM_PUBLIC = [
  '-----BEGIN PUBLIC KEY-----',
  'Wdrzv7dmD0jk9vQR5lsmoSSVsD1FsKf3lC+iV2zOFEJpUus1Sb5owp7hwoZ3fvYa',
  '-----END PUBLIC KEY-----',
].join('\n')

const CERT_BLOCK = [
  '-----BEGIN CERTIFICATE-----',
  'Wdrzv7dmD0jk9vQR5lsmoSSVsD1FsKf3lC+iV2zOFEJpUus1Sb5owp7hwoZ3fvYa',
  '-----END CERTIFICATE-----',
].join('\n')

// Luhn-valid, synthetic, brand prefixes only.
const CARD_VISA = '4028008008688643'
const CARD_VISA19 = '4746464448406080600'
const CARD_MC = '5524202068466448'
const CARD_MC2 = '2221988264064689'
const CARD_AMEX = '374044282626601'
const CARD_DISCOVER = '6011104468040849'

const SHA256_HEX = 'aabd0d22e7bd560baa640ed9fdd9dec169a363aefffa1aae09669f4d6a50cc49'
const GIT_SHA = '1bc70e2df738c3c0604a35953d12ad0925c9953a'
const DOCKER_DIGEST = '5b86fb3e0aefd7fc63f7f8e555a9cb7c151e61ece2681c59318437f2575889ba'
const MD5_HEX = 'b512937762e6e44b753d4f51042afb2e'
const B64_BLOB = 'Wdrzv7dmD0jk9vQR5lsmoSSVsD1FsKf3lC+iV2zOFEJpUus1Sb5owp7hwoZ3fvYa7uygHoUOKiK4zCnE20A1htbV'
const NPM_INTEGRITY = 'sha512-k6w13jgbgBpmLS7olsUsonOhc+mb32YuHhDZKUbu6CrBVPqRozrd2J4wImELHa7MVvi7VI5qeBFljNn2BV0DeQ=='

/** Values the positives are built from, exported for store/boundary tests. */
export const CORPUS_TOKENS = {
  GHP, GHO, GHS, GHU, GH_PAT, ANT_KEY, OAI_PROJ, OAI_KEY, AKIA, ASIA,
  SLACK_B, SLACK_P, SLACK_A, SLACK_S, GLPAT, GOOGLE_KEY, JWT_HS, JWT_RS,
  CARD_VISA, CARD_MC, CARD_AMEX, PEM_RSA,
}

// --- positives --------------------------------------------------------------

export const CORPUS_POSITIVES: CorpusPositive[] = [
  { id: 'gh-classic', tier: 'strong', text: `git remote set-url origin https://${GHP}@example.com/alice/demo.git`, expect: [{ kind: 'github-token', value: GHP }] },
  { id: 'gh-oauth', tier: 'strong', text: `export GITHUB_OAUTH=${GHO}`, expect: [{ kind: 'github-token', value: GHO }] },
  { id: 'gh-server', tier: 'strong', text: `the action used ${GHS} to push`, expect: [{ kind: 'github-token', value: GHS }] },
  { id: 'gh-user', tier: 'strong', text: `{"token": "${GHU}"}`, expect: [{ kind: 'github-token', value: GHU }] },
  { id: 'gh-fine-grained', tier: 'strong', text: `GH_TOKEN=${GH_PAT}`, expect: [{ kind: 'github-token', value: GH_PAT }] },
  { id: 'anthropic', tier: 'strong', text: `ANTHROPIC_API_KEY=${ANT_KEY}`, expect: [{ kind: 'anthropic-key', value: ANT_KEY }] },
  { id: 'anthropic-prose', tier: 'strong', text: `Der Schlüssel ${ANT_KEY} liegt in der .env`, expect: [{ kind: 'anthropic-key', value: ANT_KEY }] },
  { id: 'openai-project', tier: 'strong', text: `OPENAI_API_KEY=${OAI_PROJ}`, expect: [{ kind: 'openai-key', value: OAI_PROJ }] },
  { id: 'openai-classic', tier: 'strong', text: `curl -H "Authorization: Bearer ${OAI_KEY}" https://api.example.com/v1/models`, expect: [{ kind: 'openai-key', value: OAI_KEY }] },
  { id: 'aws-akia', tier: 'strong', text: `aws_access_key_id = ${AKIA}`, expect: [{ kind: 'aws-access-key', value: AKIA }] },
  { id: 'aws-asia', tier: 'strong', text: `temporary credentials: ${ASIA}`, expect: [{ kind: 'aws-access-key', value: ASIA }] },
  { id: 'slack-bot', tier: 'strong', text: `SLACK_BOT_TOKEN=${SLACK_B}`, expect: [{ kind: 'slack-token', value: SLACK_B }] },
  { id: 'slack-user', tier: 'strong', text: `slack user token ${SLACK_P} rotated`, expect: [{ kind: 'slack-token', value: SLACK_P }] },
  { id: 'slack-app', tier: 'strong', text: `legacy app token ${SLACK_A}`, expect: [{ kind: 'slack-token', value: SLACK_A }] },
  { id: 'slack-workspace', tier: 'strong', text: `workspace token ${SLACK_S}`, expect: [{ kind: 'slack-token', value: SLACK_S }] },
  { id: 'gitlab-pat', tier: 'strong', text: `glab auth login --token ${GLPAT}`, expect: [{ kind: 'gitlab-token', value: GLPAT }] },
  { id: 'google-key', tier: 'strong', text: `https://maps.example.com/api/js?key=${GOOGLE_KEY}&v=weekly`, expect: [{ kind: 'google-api-key', value: GOOGLE_KEY }] },
  { id: 'jwt-hs256', tier: 'strong', text: `Authorization: Bearer ${JWT_HS}`, expect: [{ kind: 'jwt', value: JWT_HS }] },
  { id: 'jwt-rs256', tier: 'strong', text: `session cookie contained ${JWT_RS} and expired`, expect: [{ kind: 'jwt', value: JWT_RS }] },
  { id: 'pem-rsa', tier: 'strong', text: `cat id_rsa\n${PEM_RSA}\n`, expect: [{ kind: 'private-key', value: PEM_RSA }] },
  { id: 'pem-ec', tier: 'strong', text: PEM_EC, expect: [{ kind: 'private-key', value: PEM_EC }] },
  { id: 'pem-openssh', tier: 'strong', text: PEM_OPENSSH, expect: [{ kind: 'private-key', value: PEM_OPENSSH }] },
  { id: 'pem-plain', tier: 'strong', text: `key material:\n${PEM_PLAIN}`, expect: [{ kind: 'private-key', value: PEM_PLAIN }] },
  { id: 'pem-pgp', tier: 'strong', text: PEM_PGP, expect: [{ kind: 'private-key', value: PEM_PGP }] },
  { id: 'url-postgres', tier: 'strong', text: 'DATABASE_URL=postgres://appuser:Tr0ub4dor-3xy@db.example.com:5432/appdb', expect: [{ kind: 'url-password', value: 'Tr0ub4dor-3xy' }] },
  { id: 'url-https', tier: 'strong', text: 'clone https://alice:s3cr3t-Pa55word@git.example.com/alice/demo.git now', expect: [{ kind: 'url-password', value: 's3cr3t-Pa55word' }] },
  { id: 'url-redis', tier: 'strong', text: 'redis://default:zW7-kelp-9912@cache.example.internal:6379/0', expect: [{ kind: 'url-password', value: 'zW7-kelp-9912' }] },
  { id: 'url-amqp', tier: 'strong', text: 'amqp://bob:Ha5elnuss-2026@queue.example.org:5672/%2f', expect: [{ kind: 'url-password', value: 'Ha5elnuss-2026' }] },
  { id: 'card-visa', tier: 'strong', text: `Kartennummer ${CARD_VISA} gültig bis 12/29`, expect: [{ kind: 'card-number', value: CARD_VISA }] },
  { id: 'card-visa-spaces', tier: 'strong', text: '4028 0080 0868 8643 ist die Karte', expect: [{ kind: 'card-number', value: '4028 0080 0868 8643' }] },
  { id: 'card-visa19', tier: 'strong', text: `card ${CARD_VISA19}`, expect: [{ kind: 'card-number', value: CARD_VISA19 }] },
  { id: 'card-mc', tier: 'strong', text: `mastercard ${CARD_MC}`, expect: [{ kind: 'card-number', value: CARD_MC }] },
  { id: 'card-mc2', tier: 'strong', text: `2-series ${CARD_MC2}`, expect: [{ kind: 'card-number', value: CARD_MC2 }] },
  { id: 'card-amex-groups', tier: 'strong', text: '3740 442826 26601 amex', expect: [{ kind: 'card-number', value: '3740 442826 26601' }] },
  { id: 'card-amex', tier: 'strong', text: `amex ${CARD_AMEX}`, expect: [{ kind: 'card-number', value: CARD_AMEX }] },
  { id: 'card-discover-dashes', tier: 'strong', text: '6011-1044-6804-0849', expect: [{ kind: 'card-number', value: '6011-1044-6804-0849' }] },
  { id: 'card-discover', tier: 'strong', text: `discover ${CARD_DISCOVER}`, expect: [{ kind: 'card-number', value: CARD_DISCOVER }] },
  { id: 'multi-in-one-line', tier: 'strong', text: `env: GH=${GHP} AWS=${AKIA}`, expect: [{ kind: 'github-token', value: GHP }, { kind: 'aws-access-key', value: AKIA }] },

  // --- user tier (context rules) -------------------------------------------
  { id: 'ctx-passwort-ist', tier: 'user', text: 'Das Passwort ist Hunde-Katze-77, bitte merken.', expect: [{ kind: 'password', value: 'Hunde-Katze-77' }] },
  { id: 'ctx-passwort-colon', tier: 'user', text: 'Passwort: Sommer2026!', expect: [{ kind: 'password', value: 'Sommer2026!' }] },
  { id: 'ctx-password-colon', tier: 'user', text: 'password: Tr0ub4dor-3', expect: [{ kind: 'password', value: 'Tr0ub4dor-3' }] },
  { id: 'ctx-password-is', tier: 'user', text: 'the password is Xy7-kelp-99 for the test box', expect: [{ kind: 'password', value: 'Xy7-kelp-99' }] },
  { id: 'ctx-pw-space', tier: 'user', text: 'pw Nordwind-42', expect: [{ kind: 'password', value: 'Nordwind-42' }] },
  { id: 'ctx-kennwort', tier: 'user', text: 'Kennwort = GeheimMaus42', expect: [{ kind: 'password', value: 'GeheimMaus42' }] },
  { id: 'ctx-passphrase', tier: 'user', text: 'passphrase: correct-horse-9', expect: [{ kind: 'password', value: 'correct-horse-9' }] },
  { id: 'ctx-passwort-quoted', tier: 'user', text: 'Passwort: "blauer himmel"', expect: [{ kind: 'password', value: 'blauer himmel' }] },
  { id: 'ctx-pin', tier: 'user', text: 'PIN 4711 für die Karte', expect: [{ kind: 'pin', value: '4711' }] },
  { id: 'ctx-pin-lautet', tier: 'user', text: 'Meine PIN lautet 123456.', expect: [{ kind: 'pin', value: '123456' }] },
  { id: 'ctx-geheimzahl', tier: 'user', text: 'Geheimzahl: 9024', expect: [{ kind: 'pin', value: '9024' }] },
  { id: 'ctx-token', tier: 'user', text: 'Token: abc123XYZ789def', expect: [{ kind: 'token', value: 'abc123XYZ789def' }] },
  { id: 'ctx-api-key', tier: 'user', text: 'API-Key: k9f3a2b1c8d7e', expect: [{ kind: 'token', value: 'k9f3a2b1c8d7e' }] },
  { id: 'ctx-api-key-space', tier: 'user', text: 'api key: AbCdEf123456', expect: [{ kind: 'token', value: 'AbCdEf123456' }] },
  { id: 'ctx-client-secret', tier: 'user', text: 'client secret: 8f3d9a2b7c1e4d6f', expect: [{ kind: 'token', value: '8f3d9a2b7c1e4d6f' }] },
  { id: 'ctx-access-token', tier: 'user', text: 'access token = Zm9vYmFy-12345678', expect: [{ kind: 'token', value: 'Zm9vYmFy-12345678' }] },
  { id: 'ctx-passwort-mixedcase', tier: 'user', text: 'Passwort ist BlauerHimmel', expect: [{ kind: 'password', value: 'BlauerHimmel' }] },
]

// --- negatives --------------------------------------------------------------

export const CORPUS_NEGATIVES: CorpusNegative[] = [
  { id: 'git-sha', text: `commit ${GIT_SHA} (HEAD -> main)` },
  { id: 'git-sha-short', text: 'fixed in a53e8724, see PR #12' },
  { id: 'git-log-line', text: `${GIT_SHA} 2026-09-26 Alice: feat(core): add detector` },
  { id: 'sha256', text: `sha256 ${SHA256_HEX}  archive.tar.gz` },
  { id: 'docker-digest', text: `image: registry.example.com/app@sha256:${DOCKER_DIGEST}` },
  { id: 'md5', text: `md5sum: ${MD5_HEX}` },
  { id: 'uuid-v4', text: 'session 3f8a1c62-9d4e-4b17-9f0a-2c6d8e5b7a31 closed' },
  { id: 'uuid-upper', text: 'device 7B1D0C4E-2F63-4A85-9C10-5E7F2A3B6D94' },
  { id: 'npm-integrity', text: `"integrity": "${NPM_INTEGRITY}"` },
  { id: 'base64-blob', text: `payload=${B64_BLOB}` },
  { id: 'base64-data-url', text: 'src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="' },
  { id: 'semver', text: 'axiom@0.29.0 requires node >= 22.11.0' },
  { id: 'semver-range', text: '"vitest": "^3.2.4", "typescript": "~5.9.2"' },
  { id: 'iban-de', text: 'IBAN DE89370400440532013000 bei der Beispielbank' },
  { id: 'iban-spaces', text: 'IBAN: DE02 1203 0000 0000 2020 51' },
  { id: 'iban-at', text: 'AT611904300234573201 ist die Kontonummer' },
  { id: 'bic', text: 'BIC COBADEFFXXX' },
  { id: 'phone-de', text: 'Telefon +49 151 23456789 erreichbar' },
  { id: 'phone-de-2', text: 'Rückruf unter 030 1234 5678 bitte' },
  { id: 'phone-intl', text: 'call +1 415 555 0132 after 9am' },
  { id: 'card-like-but-not-luhn', text: '4028 0080 0868 8644 ist keine gültige Nummer' },
  { id: 'card-like-prefix-1', text: 'Referenz 1234 5678 9012 3456' },
  { id: 'luhn-wrong-length', text: 'Vorgang 48022088842430207 abgeschlossen' },
  { id: 'epoch-millis', text: 'timestamp 1727355600000 (2026-09-26T15:00:00Z)' },
  { id: 'big-number', text: 'Der Import hat 1234567890123456 Zeilen gezählt' },
  { id: 'date-iso', text: 'Termin am 2026-09-26 um 15:02 Uhr' },
  { id: 'date-range', text: '2026-01-01 bis 2026-12-31' },
  { id: 'file-path', text: '/usr/local/lib/node_modules/npm/bin/npm-cli.js' },
  { id: 'file-path-win', text: 'C:\\Users\\alice\\AppData\\Roaming\\npm' },
  { id: 'url-plain', text: 'https://docs.example.com/guide/secrets#handles' },
  { id: 'url-user-only', text: 'git clone https://alice@git.example.com/alice/demo.git' },
  { id: 'url-port', text: 'http://localhost:3000/api/secrets' },
  { id: 'url-with-colon-path', text: 'https://example.com/ns:sub/page:1' },
  { id: 'email', text: 'Schreib an alice@example.com oder bob@example.org' },
  { id: 'mac-address', text: 'link/ether 02:1a:2b:3c:4d:5e brd ff:ff:ff:ff:ff:ff' },
  { id: 'ipv6', text: 'listen on 2001:0db8:85a3:0000:0000:8a2e:0370:7334' },
  { id: 'hex-color', text: 'background: #1a2b3c; color: #ffffff;' },
  { id: 'jwt-shaped-no-alg', text: `config blob ${NOT_A_JWT}` },
  { id: 'jwt-header-only', text: 'header eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 alone' },
  { id: 'pem-public', text: PEM_PUBLIC },
  { id: 'pem-certificate', text: CERT_BLOCK },
  { id: 'ssh-public', text: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ1qYb0x9pKQm5YyF3Ld0TzcAqNhVvR2WkDnJ8sEuXpA alice@example.com' },
  { id: 'sk-short', text: 'npm run sk-test && echo sk-ok' },
  { id: 'sk-word', text: 'Die Datei task-list.md ist in Ordnung' },
  { id: 'akia-lowercase', text: 'akiaey2yhmxbzvf6i37x is not an access key id' },
  { id: 'aws-arn', text: 'arn:aws:iam::123456789012:role/example-read-only' },
  { id: 'xoxo', text: 'xoxo-nachricht an das team' },
  { id: 'aiza-short', text: 'AIzaShortValue is not a key' },
  { id: 'glpat-short', text: 'glpat-short' },
  { id: 'ghp-too-short', text: 'ghp_short123' },
  { id: 'prose-passwort-vergessen', text: 'Ich habe mein Passwort vergessen und brauche einen Reset.' },
  { id: 'prose-passwort-geaendert', text: 'Das Passwort wurde geändert, bitte neu anmelden.' },
  { id: 'prose-passwort-abgelaufen', text: 'Das Passwort ist abgelaufen.' },
  { id: 'prose-passwort-eingeben', text: 'Bitte Passwort eingeben, dann auf Weiter klicken.' },
  { id: 'prose-passwort-sicher', text: 'Das Passwort ist sicher im Manager abgelegt.' },
  { id: 'prose-passwort-question', text: 'Wie lautet die Regel für das Passwort im neuen Dienst?' },
  { id: 'prose-password-english', text: 'The password is stored in the vault, not in the repo.' },
  { id: 'prose-password-required', text: 'password: required' },
  { id: 'prose-password-masked', text: 'password: ********' },
  { id: 'prose-password-placeholder', text: 'password: <redacted>' },
  { id: 'prose-password-envref', text: 'PASSWORD=${DB_PASSWORD}' },
  { id: 'prose-password-processenv', text: 'const password = process.env.DB_PASSWORD' },
  { id: 'prose-token-null', text: 'token: null' },
  { id: 'prose-token-undefined', text: 'token: undefined' },
  { id: 'prose-token-todo', text: 'API-Key: TODO' },
  { id: 'prose-token-handle', text: 'Token: {{secret:github-token-1}}' },
  { id: 'prose-pin-length', text: 'Die PIN ist 4-stellig und steht nicht in der Notiz.' },
  { id: 'prose-pin-short', text: 'PIN: 12' },
  { id: 'prose-pw-reset', text: 'Bitte pw zurücksetzen, der Zugang klemmt.' },
  { id: 'prose-secret-generic', text: 'Das Geheimnis liegt in der Vorbereitung.' },
  { id: 'code-token-variable', text: 'const token = await getToken(userId)' },
  { id: 'code-header', text: "headers: { Authorization: `Bearer ${token}` }" },
  { id: 'log-line', text: '[2026-09-26T15:02:11.482Z] INFO request completed in 42ms status=200' },
  { id: 'npm-version-list', text: 'added 755 packages, and audited 756 packages in 21s' },
  { id: 'port-list', text: '0.0.0.0:5432->5432/tcp, 0.0.0.0:6379->6379/tcp' },
  { id: 'german-prose', text: 'Der Bericht ist fertig, die Zahlen stimmen mit dem Vormonat überein.' },
  { id: 'english-prose', text: 'Alice reviewed the pull request and left two comments for Bob.' },
  { id: 'markdown-table', text: '| Feld | Wert |\n| --- | --- |\n| Status | grün |' },
  { id: 'ansi-output', text: 'PASS  src/secret-detect.test.ts (42 tests) 118ms' },
]
