#!/usr/bin/env bash
# curl smoke for POST /api/device/clock/voice (stage 3, companion K1), local
# only. Starts scripts/clock-voice-smoke.ts (real captures service, mocked STT,
# router model and turn runner), sends 1.5 s of 16 kHz 16 bit mono PCM.
#   1. default (both switches off)            -> 404
#   2. only CLOCK_VOICE_ENABLED on            -> 404
#   3. both on: capture source 'clock', router appends into "Wetter", second
#      question -> new strand, idempotent retry, no strand "Uhr", 401/403 gates
#   4. K2 back-channel: question -> long poll GET /voice/:id with cursor until
#      the spoken part is complete (text only, no markdown), same cursor twice
#      -> same delta, note ("Notiz: ...") -> state noted, "Notiert: <title>",
#      no turn; repeated upload of the note -> idempotent, still no turn
# Never talks to the live backend or the clock.
set -euo pipefail
cd "$(dirname "$0")/.."
WORK=$(mktemp -d)
# npx/tsx fork a child node; stop the whole server tree, not only the wrapper.
stop_server() { pkill -f '[c]lock-voice-smoke.ts' 2>/dev/null || true; wait 2>/dev/null || true; }
trap 'stop_server; rm -rf "$WORK"' EXIT

python3 - "$WORK/q.pcm" <<'EOF'
import math, struct, sys
rate, secs = 16000, 1.5
with open(sys.argv[1], 'wb') as f:
    for i in range(int(rate * secs)):
        f.write(struct.pack('<h', int(8000 * math.sin(2 * math.pi * 440 * i / rate))))
EOF
echo "PCM: $(stat -c %s "$WORK/q.pcm") Bytes (16 kHz, 16 bit, mono, 1,5 s)"

start() {
  : > "$WORK/info"
  npx tsx scripts/clock-voice-smoke.ts "$@" > "$WORK/info" 2> "$WORK/server.log" &
  for _ in $(seq 1 150); do [ -s "$WORK/info" ] && break; sleep 0.1; done
  PORT=$(python3 -c "import json;print(json.load(open('$WORK/info'))['port'])")
  VTOKEN=$(python3 -c "import json;print(json.load(open('$WORK/info'))['voiceToken'])")
  PTOKEN=$(python3 -c "import json;print(json.load(open('$WORK/info'))['plainToken'])")
  URL="http://127.0.0.1:$PORT/api/device/clock/voice"
}
poll() { # poll <exchange_id> <query>
  curl -sS "$URL/$1?$2" -H "Authorization: Bearer $VTOKEN"
}
field() { python3 -c "import json,sys;print(json.loads(sys.argv[1]).get('$1'))" "$2"; }
ask() {
  curl -sS -X POST "$URL" -H "Authorization: Bearer $VTOKEN" -H 'Content-Type: application/octet-stream' "$@" \
    --data-binary @"$WORK/q.pcm" -w '\nHTTP %{http_code}\n'
}

echo "== 1. Schalter aus (Default: Env leer, captureSources.clock.enabled false) =="
start
ask
stop_server

echo "== 2. Nur CLOCK_VOICE_ENABLED=1, Settings aus =="
start --env
ask
stop_server

echo "== 3. Beide Schalter an (nur im Smoke) =="
start --env --settings
echo "-- 3a. Frage, chunked wie die Firmware (Router: append in 'Wetter'):"
ask -H 'Transfer-Encoding: chunked' -H 'X-Clock-Exchange: clk-1-1000'
echo "-- 3b. Gleiche Exchange-ID noch einmal (idempotent, kein zweiter Turn):"
ask -H 'X-Clock-Exchange: clk-1-1000'
echo "-- 3c. Zweite Frage (Router: neuer Strand):"
ask -H 'X-Clock-Exchange: clk-1-2000'
echo "-- Captures:"
curl -sS "http://127.0.0.1:$PORT/smoke/captures"; echo
echo "-- Strands (kein 'Uhr' erwartet):"
curl -sS "http://127.0.0.1:$PORT/smoke/strands"; echo
echo "-- Token ohne clock:voice:"
curl -sS -o /dev/null -X POST "$URL" -H "Authorization: Bearer $PTOKEN" --data-binary @"$WORK/q.pcm" -w 'HTTP %{http_code}\n'
echo "-- Ohne Token:"
curl -sS -o /dev/null -X POST "$URL" --data-binary @"$WORK/q.pcm" -w 'HTTP %{http_code}\n'

FAILED=0
echo "== 4. Rückweg (K2): Long-Poll mit Cursor =="
POST=$(ask -H 'X-Clock-Exchange: clk-1-3000' | head -1)
EX=$(field exchange_id "$POST")
echo "-- 4a. Frage: state=$(field state "$POST") phase=$(field phase "$POST") exchange=$EX"
CURSOR=0; STATE=$(field phase "$POST"); TEXT=""; N=0
while :; do
  N=$((N+1))
  T0=$(date +%s%N)
  R=$(poll "$EX" "cursor=$CURSOR&state=$STATE&wait=25000")
  MS=$(( ($(date +%s%N) - T0) / 1000000 ))
  DELTA=$(field text_delta "$R"); STATE=$(field state "$R"); NEW=$(field cursor "$R"); DONE=$(field spoken_done "$R")
  echo "   poll $N (cursor=$CURSOR, ${MS} ms): state=$STATE cursor=$NEW spoken_done=$DONE delta='$DELTA'"
  TEXT="$TEXT$DELTA"; CURSOR=$NEW
  case "$STATE" in done|noted|error|needs_choice|pending) break;; esac
  [ "$N" -ge 20 ] && { echo "   ABBRUCH: kein Endzustand nach 20 Polls"; break; }
done
echo "-- 4b. Gesprochener Teil: '$TEXT'"
if [ "$STATE" = "done" ] && [ "$TEXT" = "Morgen wird es sonnig, bis 21 Grad. Am Abend frischt der Wind auf." ]; then
  echo "   CHECK ok: Frage -> Antworttext über Long-Poll, Kernabsatz ohne Markdown"
else
  echo "   CHECK FEHLER: state=$STATE text='$TEXT'"; FAILED=1
fi
echo "   letzter Poll: $R"
echo "-- 4c. Gleicher Cursor zweimal (idempotent):"
A=$(poll "$EX" "cursor=0&wait=0"); B=$(poll "$EX" "cursor=0&wait=0")
if [ "$A" = "$B" ]; then echo "   CHECK ok: gleich: $(field text_delta "$A")"; else echo "   CHECK FEHLER: VERSCHIEDEN: $A / $B"; FAILED=1; fi
echo "   Tail ab Cursor 10: '$(field text_delta "$(poll "$EX" "cursor=10&wait=0")")'"
echo "-- 4d. Fremde Exchange-ID:"
curl -sS -o /dev/null "$URL/gibt-es-nicht?wait=0" -H "Authorization: Bearer $VTOKEN" -w '   HTTP %{http_code}\n'

echo "== 5. Notiz (E3, §4.4): kein Turn, 'Notiert: <Strand-Titel>' =="
TURNS_BEFORE=$(curl -sS "http://127.0.0.1:$PORT/smoke/turns")
curl -sS -X POST "http://127.0.0.1:$PORT/smoke/transcript" -H 'Content-Type: application/json' -d '{"text":"Notiz: Milch und Brot kaufen"}' >/dev/null
# The router stub files this capture into a new strand "Einkaufsliste".
curl -sS -X POST "http://127.0.0.1:$PORT/smoke/router" -H 'Content-Type: application/json' \
  -d '{"action":"new_strand","newStrand":{"title":"Einkaufsliste","personaId":"main","tags":[]},"intent":"ask","confidence":0.9,"rationale":"shopping"}' >/dev/null
NOTE=$(ask -H 'X-Clock-Exchange: clk-1-4000' | head -1)
NEX=$(field exchange_id "$NOTE")
NTITLE=$(field strand_title "$NOTE")
echo "-- 5a. Upload: intent=$(field intent "$NOTE") state=$(field state "$NOTE") phase=$(field phase "$NOTE") turn_id=$(field turn_id "$NOTE") strand_title=$NTITLE"
NPOLL=$(poll "$NEX" "cursor=0&wait=25000")
echo "-- 5b. Poll: $NPOLL"
NTEXT=$(field text_delta "$NPOLL")
if [ "$NTEXT" = "Notiert: $NTITLE" ] && [ "$NTITLE" = "Einkaufsliste" ]; then
  echo "   CHECK ok: text_delta = 'Notiert: ' + strand_title des Uploads ('$NTEXT')"
else
  echo "   CHECK FEHLER: text_delta='$NTEXT' strand_title='$NTITLE'"; FAILED=1
fi
echo "-- 5c. Wiederholung derselben Exchange-ID:"
AGAIN=$(ask -H 'X-Clock-Exchange: clk-1-4000' | head -1)
echo "   idempotent=$(field idempotent "$AGAIN") same_exchange=$([ "$(field exchange_id "$AGAIN")" = "$NEX" ] && echo ja || echo nein) state=$(field state "$AGAIN") phase=$(field phase "$AGAIN")"
if [ "$(field idempotent "$AGAIN")" = "True" ] && [ "$(field exchange_id "$AGAIN")" = "$NEX" ] && [ "$(field phase "$AGAIN")" = "noted" ]; then
  echo "   CHECK ok: Wiederholung idempotent"
else
  echo "   CHECK FEHLER: Wiederholung nicht idempotent"; FAILED=1
fi
TURNS_AFTER=$(curl -sS "http://127.0.0.1:$PORT/smoke/turns")
echo "-- 5d. Turns vorher/nachher: $TURNS_BEFORE / $TURNS_AFTER"
if [ "$TURNS_BEFORE" = "$TURNS_AFTER" ]; then echo "   CHECK ok: Notiz ohne Turn"; else echo "   CHECK FEHLER: Notiz hat einen Turn gestartet"; FAILED=1; fi
echo "-- 5e. Wiederholung der Frage clk-1-3000: $(ask -H 'X-Clock-Exchange: clk-1-3000' | head -1)"
echo "-- 5f. Clock-State (thinking-Flag, Events):"
curl -sS "http://127.0.0.1:$PORT/api/device/clock/state" -H "Authorization: Bearer $VTOKEN"; echo
echo "-- Server-Log:"; cat "$WORK/server.log"
stop_server
echo "== Ergebnis: $([ "$FAILED" = 0 ] && echo ALLE CHECKS OK || echo CHECKS FEHLGESCHLAGEN) =="
exit "$FAILED"
