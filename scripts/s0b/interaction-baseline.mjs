#!/usr/bin/env node
// S0-B/B1 baseline: interaction card counters reconstructed from the chat DB.
// Read-only. Prints counters per channel only, never message content.
// Usage: node scripts/s0b/interaction-baseline.mjs [/data/db/axiom.db]
import Database from 'better-sqlite3'
import {
  classifyInteractionFences,
  extractAnswerableInteractionBlocks,
  interactionSkipReason,
  resolveInteractionBlockState,
} from '../../packages/core/dist/contracts/interaction-blocks.js'

const dbPath = process.argv[2] ?? '/data/db/axiom.db'
const db = new Database(dbPath, { readonly: true, fileMustExist: true })

const rows = db.prepare(`
  SELECT m.id, m.session_id, m.content, m.metadata, m.timestamp, s.source
  FROM chat_messages m JOIN sessions s ON s.id = m.session_id
  WHERE m.role = 'assistant' AND m.content LIKE '%\`\`\`offtangent%'
  ORDER BY m.id`).all()
const lastUserTurn = db.prepare(`SELECT MAX(id) AS id FROM chat_messages WHERE session_id = ? AND role = 'user'`)

// Channel mapping (review 5). The DB stores no client per row: the web client
// and the Android app write into the same strands (sessions.source = 'web'),
// so their history is one bucket `web_android`. The live split per client
// comes from the telemetry counters (`/api/health/interactions`).
const CHANNEL_OF_SOURCE = { web: 'web_android', android: 'web_android', telegram: 'telegram' }
const out = {}
const bucket = s => (out[CHANNEL_OF_SOURCE[s] ?? 'other'] ??= {
  messages: 0, parse_ok: 0, parse_repaired: 0, parse_broken: 0,
  cards: 0, answered: 0, expired: 0, skipped_later_user_turn: 0, skipped_newer_card: 0, open: 0,
})

// First pass: every card with its row, so the shared skip rule
// (`interactionSkipReason`, the one web, app and strand-attention use) can see
// the newest unanswered card of its strand.
const cards = []
const newestOpenCard = new Map()
for (const row of rows) {
  const b = bucket(row.source)
  b.messages++
  for (const outcome of classifyInteractionFences(row.content)) b[`parse_${outcome}`]++
  let blocks = []
  try { blocks = extractAnswerableInteractionBlocks(row.content) } catch { blocks = [] }
  for (const block of blocks) {
    const state = resolveInteractionBlockState(block, row.metadata)
    cards.push({ b, row, state })
    if (state.closedReason !== 'answered') newestOpenCard.set(row.session_id, row.id)
  }
}
for (const { b, row, state } of cards) {
  b.cards++
  if (state.closedReason === 'answered') { b.answered++; continue }
  if (state.closedReason === 'expired') { b.expired++; continue }
  const reason = interactionSkipReason({
    at: row.id,
    lastUserTurnAt: lastUserTurn.get(row.session_id)?.id ?? null,
    newestCardAt: newestOpenCard.get(row.session_id) ?? null,
  })
  if (reason === 'later_user_turn') b.skipped_later_user_turn++
  else if (reason === 'newer_card') b.skipped_newer_card++
  else b.open++
}
console.log(JSON.stringify({ generated_at: new Date().toISOString(), db: dbPath, channel_note: 'web_android: web client and Android app share strands; the DB has no client per row', per_channel: out }, null, 2))
