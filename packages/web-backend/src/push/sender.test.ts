import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initDatabase } from '@axiom/core'
import type { Database } from '@axiom/core'
import { PushDeviceRegistry } from './device-registry.js'
import type { FcmClient, FcmMessage, FcmSendResult } from './fcm-client.js'
import {
  PushSender,
  buildPayload,
  priorityFor,
  resolvePresencePolicy,
  resolvePreviewChars,
  shortenPreview,
  MAX_PREVIEW_CHARS,
  COALESCE_WINDOW_MS,
} from './sender.js'

let db: Database
let registry: PushDeviceRegistry

/** A client that answers from a scripted queue and records what it was asked to send. */
class FakeClient {
  readonly sent: FcmMessage[] = []
  private readonly queue: FcmSendResult[] = []
  configured = true

  enqueue(...results: FcmSendResult[]): void {
    this.queue.push(...results)
  }

  isConfigured(): boolean {
    return this.configured
  }

  async send(message: FcmMessage): Promise<FcmSendResult> {
    this.sent.push(message)
    return this.queue.shift() ?? { ok: true, status: 200, name: `projects/p/messages/${this.sent.length}` }
  }
}

function makeSender(client: FakeClient, now: () => number = () => 1_000) {
  return new PushSender({
    registry,
    client: client as unknown as FcmClient,
    now,
    retryDelayMs: 0,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  })
}

beforeEach(() => {
  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(1, 'alice', 'x')
  registry = new PushDeviceRegistry(db)
})

afterEach(() => {
  db.close()
  vi.restoreAllMocks()
})

describe('push payload', () => {
  it('is data only, carries no content and repeats the persona for slice 0 apps', () => {
    const data = buildPayload({
      userId: 1,
      kind: 'turn_done',
      strandId: 's-1',
      agentId: 'bob',
      messageId: 42,
    }, '2026-09-13T15:00:00.000Z')
    expect(data).toEqual({
      kind: 'turn_done',
      strandId: 's-1',
      sessionId: 's-1',
      agentId: 'bob',
      persona: 'bob',
      title: 'bob',
      body: 'There is a new answer',
      messageId: '42',
      sentAt: '2026-09-13T15:00:00.000Z',
    })
    // Every value has to be a string, FCM rejects the message otherwise.
    expect(Object.values(data).every(value => typeof value === 'string')).toBe(true)
  })

  it('carries the strand under both names so a client does not have to guess', () => {
    const data = buildPayload({ userId: 1, kind: 'task_done', strandId: 's-7', agentId: 'main' }, 'now')
    expect(data.strandId).toBe('s-7')
    expect(data.sessionId).toBe('s-7')
  })

  it('leaves messageId out when there is none', () => {
    const data = buildPayload({ userId: 1, kind: 'question', strandId: 's-1', agentId: 'main' }, 'now')
    expect(data.messageId).toBeUndefined()
    expect(data.body).toBe('A background task is waiting for you')
  })

  it('sends questions and errors at high priority, the rest at normal', () => {
    expect(priorityFor('question')).toBe('high')
    expect(priorityFor('error')).toBe('high')
    expect(priorityFor('turn_done')).toBe('normal')
    expect(priorityFor('task_done')).toBe('normal')
  })
})

describe('push sender', () => {
  it('sends to every enabled device of the user and records the success', async () => {
    registry.register(1, { token: 'tok-a' })
    registry.register(1, { token: 'tok-b' })
    const client = new FakeClient()
    const outcome = await makeSender(client).send({ userId: 1, kind: 'turn_done', strandId: 's-1', agentId: 'main' })

    expect(outcome.delivered).toBe(2)
    expect(outcome.messageNames).toHaveLength(2)
    expect(client.sent.map(m => m.token).sort()).toEqual(['tok-a', 'tok-b'])
    expect(client.sent[0].collapseKey).toBe('s-1')
    expect(client.sent[0].ttlSeconds).toBe(600)
    expect(registry.listForUser(1).every(d => d.lastSuccessAt !== null)).toBe(true)
  })

  it('does nothing when the user has no device', async () => {
    const client = new FakeClient()
    const outcome = await makeSender(client).send({ userId: 1, kind: 'turn_done', strandId: 's-1', agentId: 'main' })
    expect(outcome.delivered).toBe(0)
    expect(client.sent).toHaveLength(0)
  })

  it('does nothing when no service account is configured', async () => {
    registry.register(1, { token: 'tok-a' })
    const client = new FakeClient()
    client.configured = false
    const outcome = await makeSender(client).send({ userId: 1, kind: 'turn_done', strandId: 's-1', agentId: 'main' })
    expect(outcome.delivered).toBe(0)
    expect(outcome.failed).toBe(0)
    expect(client.sent).toHaveLength(0)
  })

  it('warns once, not once per turn, while no service account is configured', async () => {
    registry.register(1, { token: 'tok-a' })
    const client = new FakeClient()
    client.configured = false
    const warn = vi.fn()
    const sender = new PushSender({
      registry,
      client: client as unknown as FcmClient,
      now: () => 1_000,
      retryDelayMs: 0,
      logger: { info: () => {}, warn, error: () => {} },
    })
    await sender.send({ userId: 1, kind: 'turn_done', strandId: 's-1', agentId: 'main' })
    await sender.send({ userId: 1, kind: 'turn_done', strandId: 's-2', agentId: 'main' })
    await sender.send({ userId: 1, kind: 'task_done', strandId: 's-3', agentId: 'main' })
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('disables a device FCM calls UNREGISTERED and does not retry it', async () => {
    registry.register(1, { token: 'tok-a' })
    const client = new FakeClient()
    client.enqueue({ ok: false, status: 404, errorCode: 'UNREGISTERED' })
    const outcome = await makeSender(client).send({ userId: 1, kind: 'turn_done', strandId: 's-1', agentId: 'main' })

    expect(outcome.disabled).toBe(1)
    expect(client.sent).toHaveLength(1)
    expect(registry.activeForUser(1)).toHaveLength(0)
  })

  it('disables a device on INVALID_ARGUMENT too', async () => {
    registry.register(1, { token: 'tok-a' })
    const client = new FakeClient()
    client.enqueue({ ok: false, status: 400, errorCode: 'INVALID_ARGUMENT' })
    const outcome = await makeSender(client).send({ userId: 1, kind: 'error', strandId: 's-1', agentId: 'main' })
    expect(outcome.disabled).toBe(1)
    expect(registry.activeForUser(1)).toHaveLength(0)
  })

  it('retries a transient failure exactly once and keeps the device', async () => {
    registry.register(1, { token: 'tok-a' })
    const client = new FakeClient()
    client.enqueue({ ok: false, status: 503, errorCode: 'UNAVAILABLE' }, { ok: true, status: 200, name: 'projects/p/messages/9' })
    const outcome = await makeSender(client).send({ userId: 1, kind: 'turn_done', strandId: 's-1', agentId: 'main' })

    expect(client.sent).toHaveLength(2)
    expect(outcome.delivered).toBe(1)
    expect(registry.activeForUser(1)).toHaveLength(1)
  })

  it('gives up after the single retry and counts the failure', async () => {
    registry.register(1, { token: 'tok-a' })
    const client = new FakeClient()
    client.enqueue(
      { ok: false, status: 503, errorCode: 'UNAVAILABLE' },
      { ok: false, status: 503, errorCode: 'UNAVAILABLE' },
      { ok: true, status: 200, name: 'never-reached' },
    )
    const outcome = await makeSender(client).send({ userId: 1, kind: 'turn_done', strandId: 's-1', agentId: 'main' })

    expect(client.sent).toHaveLength(2)
    expect(outcome.failed).toBe(1)
    expect(registry.listForUser(1)[0].failureCount).toBe(1)
    expect(registry.activeForUser(1)).toHaveLength(1)
  })

  it('coalesces a second doorbell for the same strand inside the window', async () => {
    registry.register(1, { token: 'tok-a' })
    const client = new FakeClient()
    let clock = 1_000
    const sender = makeSender(client, () => clock)

    await sender.send({ userId: 1, kind: 'turn_done', strandId: 's-1', agentId: 'main' })
    clock += COALESCE_WINDOW_MS - 1
    const second = await sender.send({ userId: 1, kind: 'turn_done', strandId: 's-1', agentId: 'main' })

    expect(second.coalesced).toBe(true)
    expect(client.sent).toHaveLength(1)

    clock += 2
    const third = await sender.send({ userId: 1, kind: 'turn_done', strandId: 's-1', agentId: 'main' })
    expect(third.coalesced).toBe(false)
    expect(client.sent).toHaveLength(2)
  })

  it('does not let one strand coalesce another', async () => {
    registry.register(1, { token: 'tok-a' })
    const client = new FakeClient()
    const sender = makeSender(client)
    await sender.send({ userId: 1, kind: 'turn_done', strandId: 's-1', agentId: 'main' })
    const other = await sender.send({ userId: 1, kind: 'turn_done', strandId: 's-2', agentId: 'main' })
    expect(other.coalesced).toBe(false)
    expect(client.sent).toHaveLength(2)
  })

  it('never throws out of the detached path when the client explodes', async () => {
    registry.register(1, { token: 'tok-a' })
    const client = {
      isConfigured: () => { throw new Error('service account vanished') },
      send: vi.fn(),
    } as unknown as FcmClient
    const error = vi.fn()
    const sender = new PushSender({
      registry, client, now: () => 1_000, retryDelayMs: 0,
      logger: { info: () => {}, warn: () => {}, error },
    })
    expect(() => sender.sendDetached({ userId: 1, kind: 'turn_done', strandId: 's-1', agentId: 'main' })).not.toThrow()
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(error).toHaveBeenCalledTimes(1)
  })

  it('survives a client that throws', async () => {
    registry.register(1, { token: 'tok-a' })
    const client = {
      isConfigured: () => true,
      send: vi.fn().mockRejectedValue(new Error('socket hang up')),
    } as unknown as FcmClient
    const sender = new PushSender({
      registry,
      client,
      now: () => 1_000,
      retryDelayMs: 0,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    const outcome = await sender.send({ userId: 1, kind: 'turn_done', strandId: 's-1', agentId: 'main' })
    expect(outcome.failed).toBe(1)
    expect(outcome.delivered).toBe(0)
  })
})

describe('push presence policy', () => {
  function makeGatedSender(
    client: FakeClient,
    presencePolicy: 'off' | 'turn' | 'all',
    isClientOnline: (userId: number) => boolean,
  ) {
    return new PushSender({
      registry,
      client: client as unknown as FcmClient,
      now: () => 1_000,
      retryDelayMs: 0,
      presencePolicy,
      isClientOnline,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
  }

  it('defaults to off: an open client is no reason to stay silent', async () => {
    registry.register(1, { token: 'tok-a' })
    const client = new FakeClient()
    const sender = makeGatedSender(client, 'off', () => true)
    const outcome = await sender.send({ userId: 1, kind: 'turn_done', strandId: 's-1', agentId: 'main' })
    expect(outcome.suppressed).toBe(false)
    expect(outcome.delivered).toBe(1)
    expect(client.sent).toHaveLength(1)
  })

  it('drops a turn_done while a client of that user is online (policy turn)', async () => {
    registry.register(1, { token: 'tok-a' })
    const client = new FakeClient()
    const sender = makeGatedSender(client, 'turn', () => true)
    const outcome = await sender.send({ userId: 1, kind: 'turn_done', strandId: 's-1', agentId: 'main' })
    expect(outcome.suppressed).toBe(true)
    expect(outcome.delivered).toBe(0)
    expect(client.sent).toHaveLength(0)
  })

  it('still rings for questions, task results and errors under policy turn', async () => {
    registry.register(1, { token: 'tok-a' })
    const client = new FakeClient()
    const sender = makeGatedSender(client, 'turn', () => true)
    for (const kind of ['task_done', 'question', 'error'] as const) {
      const outcome = await sender.send({ userId: 1, kind, strandId: `s-${kind}`, agentId: 'main' })
      expect(outcome.suppressed).toBe(false)
      expect(outcome.delivered).toBe(1)
    }
    expect(client.sent).toHaveLength(3)
  })

  it('drops every kind under policy all, and sends again once the client is gone', async () => {
    registry.register(1, { token: 'tok-a' })
    const client = new FakeClient()
    let online = true
    const sender = makeGatedSender(client, 'all', () => online)

    expect((await sender.send({ userId: 1, kind: 'question', strandId: 's-1', agentId: 'main' })).suppressed).toBe(true)
    online = false
    const outcome = await sender.send({ userId: 1, kind: 'question', strandId: 's-1', agentId: 'main' })
    expect(outcome.suppressed).toBe(false)
    expect(outcome.delivered).toBe(1)
  })

  it('only looks at the presence of the user the doorbell belongs to', async () => {
    db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(2, 'bob', 'x')
    registry.register(2, { token: 'tok-b' })
    const client = new FakeClient()
    const sender = makeGatedSender(client, 'all', (userId: number) => userId === 1)
    const outcome = await sender.send({ userId: 2, kind: 'turn_done', strandId: 's-1', agentId: 'main' })
    expect(outcome.suppressed).toBe(false)
    expect(outcome.delivered).toBe(1)
  })

  it('does not let a suppressed doorbell consume the coalescing window', async () => {
    registry.register(1, { token: 'tok-a' })
    const client = new FakeClient()
    let online = true
    const sender = makeGatedSender(client, 'all', () => online)

    await sender.send({ userId: 1, kind: 'turn_done', strandId: 's-1', agentId: 'main' })
    online = false
    const outcome = await sender.send({ userId: 1, kind: 'turn_done', strandId: 's-1', agentId: 'main' })
    expect(outcome.coalesced).toBe(false)
    expect(outcome.delivered).toBe(1)
  })

  it('sends when the presence checker throws', async () => {
    registry.register(1, { token: 'tok-a' })
    const client = new FakeClient()
    const sender = makeGatedSender(client, 'all', () => { throw new Error('no ws registry yet') })
    const outcome = await sender.send({ userId: 1, kind: 'turn_done', strandId: 's-1', agentId: 'main' })
    expect(outcome.suppressed).toBe(false)
    expect(outcome.delivered).toBe(1)
  })

  it('reads the policy from PUSH_SUPPRESS_WHEN_CLIENT_ONLINE and falls back to off', () => {
    expect(resolvePresencePolicy({})).toBe('off')
    expect(resolvePresencePolicy({ PUSH_SUPPRESS_WHEN_CLIENT_ONLINE: '' })).toBe('off')
    expect(resolvePresencePolicy({ PUSH_SUPPRESS_WHEN_CLIENT_ONLINE: 'off' })).toBe('off')
    expect(resolvePresencePolicy({ PUSH_SUPPRESS_WHEN_CLIENT_ONLINE: 'false' })).toBe('off')
    expect(resolvePresencePolicy({ PUSH_SUPPRESS_WHEN_CLIENT_ONLINE: ' Turn ' })).toBe('turn')
    expect(resolvePresencePolicy({ PUSH_SUPPRESS_WHEN_CLIENT_ONLINE: 'turn_done' })).toBe('turn')
    expect(resolvePresencePolicy({ PUSH_SUPPRESS_WHEN_CLIENT_ONLINE: 'ALL' })).toBe('all')
    expect(resolvePresencePolicy({ PUSH_SUPPRESS_WHEN_CLIENT_ONLINE: 'true' })).toBe('all')
    expect(resolvePresencePolicy({ PUSH_SUPPRESS_WHEN_CLIENT_ONLINE: '1' })).toBe('all')
    // A typo must not silence the phone.
    expect(resolvePresencePolicy({ PUSH_SUPPRESS_WHEN_CLIENT_ONLINE: 'yeah-sure' })).toBe('off')
  })
})

describe('push preview', () => {
  it('drops the excerpt unless PUSH_PREVIEW_CHARS asks for it', () => {
    const doorbell = {
      userId: 1, kind: 'turn_done' as const, strandId: 's-1', agentId: 'bob',
      preview: 'The roof quote is 25 520 EUR, which is 12 percent over the second one.',
    }
    expect(buildPayload(doorbell, 'now').preview).toBeUndefined()
    expect(buildPayload(doorbell, 'now', 0).preview).toBeUndefined()
    expect(buildPayload(doorbell, 'now', 40).preview).toBe('The roof quote is 25 520 EUR, which is\u2026')
  })

  it('collapses whitespace and keeps a short answer whole', () => {
    expect(shortenPreview('  two   lines\nof   text ', 120)).toBe('two lines of text')
  })

  it('cuts on a word boundary when one is near the end, hard otherwise', () => {
    expect(shortenPreview('alpha beta gamma delta', 12)).toBe('alpha beta\u2026')
    expect(shortenPreview('donaudampfschifffahrtsgesellschaft', 10)).toBe('donaudampf\u2026')
  })

  it('returns null for nothing usable', () => {
    expect(shortenPreview(null, 120)).toBeNull()
    expect(shortenPreview('   ', 120)).toBeNull()
    expect(shortenPreview('text', 0)).toBeNull()
  })

  it('caps the excerpt so the payload cannot grow into a reader', () => {
    const long = 'x'.repeat(1000)
    const data = buildPayload(
      { userId: 1, kind: 'turn_done', strandId: 's-1', agentId: 'bob', preview: long },
      'now',
      5000,
    )
    expect(data.preview?.length).toBe(MAX_PREVIEW_CHARS + 1) // characters plus the ellipsis
  })

  it('reads PUSH_PREVIEW_CHARS and defaults to no content on the wire', () => {
    expect(resolvePreviewChars({})).toBe(0)
    expect(resolvePreviewChars({ PUSH_PREVIEW_CHARS: '' })).toBe(0)
    expect(resolvePreviewChars({ PUSH_PREVIEW_CHARS: '0' })).toBe(0)
    expect(resolvePreviewChars({ PUSH_PREVIEW_CHARS: '-20' })).toBe(0)
    expect(resolvePreviewChars({ PUSH_PREVIEW_CHARS: 'yes please' })).toBe(0)
    expect(resolvePreviewChars({ PUSH_PREVIEW_CHARS: ' 120 ' })).toBe(120)
    expect(resolvePreviewChars({ PUSH_PREVIEW_CHARS: '9999' })).toBe(MAX_PREVIEW_CHARS)
  })

  it('puts the excerpt on the wire when the sender is configured for it', async () => {
    registry.register(1, { token: 'tok-a' })
    const client = new FakeClient()
    const sender = new PushSender({
      registry,
      client: client as unknown as FcmClient,
      now: () => 1_000,
      retryDelayMs: 0,
      previewChars: 60,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    await sender.send({
      userId: 1, kind: 'turn_done', strandId: 's-1', agentId: 'bob',
      title: 'Roof quotes', preview: 'Emig is 25 520 EUR and the cheapest of the three offers.',
    })
    expect(client.sent[0].data.preview).toBe('Emig is 25 520 EUR and the cheapest of the three offers.')
    expect(client.sent[0].data.title).toBe('Roof quotes')
    expect(sender.previewChars).toBe(60)
  })
})
