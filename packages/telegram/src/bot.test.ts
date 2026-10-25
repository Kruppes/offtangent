/* eslint-disable @typescript-eslint/no-unsafe-function-type, @typescript-eslint/no-explicit-any */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AgentCore, ResponseChunk, Database, EmailSendLogEntry } from '@axiom/core'

// Mock grammy before importing the module under test
vi.mock('grammy', () => {
  const handlers: Map<string, Function> = new Map()
  const commandHandlers: Map<string, Function> = new Map()

  const mockApi = {
    getMe: vi.fn().mockResolvedValue({
      id: 123456,
      is_bot: true,
      first_name: 'TestBot',
      username: 'test_bot',
    }),
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
    editMessageText: vi.fn().mockResolvedValue(true),
    deleteMessage: vi.fn().mockResolvedValue(true),
    deleteWebhook: vi.fn().mockResolvedValue(true),
    setMyCommands: vi.fn().mockResolvedValue(true),
  }

  const MockBot = vi.fn().mockImplementation(() => ({
    api: mockApi,
    command: vi.fn((cmd: string, handler: Function) => {
      commandHandlers.set(cmd, handler)
    }),
    on: vi.fn((filter: string, handler: Function) => {
      handlers.set(filter, handler)
    }),
    catch: vi.fn(),
    start: vi.fn(({ onStart }: { onStart?: () => void }) => {
      onStart?.()
    }),
    stop: vi.fn(),
    _handlers: handlers,
    _commandHandlers: commandHandlers,
  }))

  // Minimal InlineKeyboard stand-in: enough surface area for our picker
  // builder (text + row) and for the test to inspect the resulting layout
  // via the expected `{ inline_keyboard: ... }` shape. Mirrors grammY's
  // serialization which strips trailing empty rows.
  class MockInlineKeyboard {
    private rows: { text: string; callback_data: string }[][] = [[]]
    text(label: string, callback_data: string): this {
      this.rows[this.rows.length - 1]!.push({ text: label, callback_data })
      return this
    }
    row(): this {
      this.rows.push([])
      return this
    }
    get inline_keyboard(): { text: string; callback_data: string }[][] {
      // Drop trailing empty rows so callers see exactly one row per option.
      const out = this.rows.slice()
      while (out.length > 0 && out[out.length - 1]!.length === 0) out.pop()
      return out
    }
  }

  return {
    Bot: MockBot,
    InlineKeyboard: MockInlineKeyboard,
    GrammyError: class GrammyError extends Error {
      error_code: number
      description: string
      parameters?: { retry_after?: number }
      constructor(message: string, error_code: number = 400, description: string = message) {
        super(message)
        this.error_code = error_code
        this.description = description
      }
    },
    HttpError: class HttpError extends Error {
      constructor(message: string) {
        super(message)
      }
    },
  }
})

// Mock @axiom/core
vi.mock('@axiom/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@axiom/core')>()
  return {
    ...actual,
    loadConfig: vi.fn((filename: string) => {
      if (filename === 'settings.json') {
        return { batchingDelayMs: 2500 }
      }

      return {
        enabled: true,
        botToken: 'test-token-123',
        adminUserIds: [],
        pollingMode: true,
        webhookUrl: '',
        batchingDelayMs: 2500,
      }
    }),
  }
})

import { TelegramBot, createTelegramBot, extractReplyContext, buildAgentMessage } from './bot.js'
import type { TelegramConfig, TelegramChatEvent } from './bot.js'
import { clearTurnRetryNotifiers, initDatabase, loadConfig, notifyTurnRetryResolved, TurnRunner } from '@axiom/core'

async function* errorStream(error: string): AsyncGenerator<ResponseChunk> {
  yield { type: 'error', error }
}

async function* textStream(text: string): AsyncGenerator<ResponseChunk> {
  yield { type: 'text', text }
  yield { type: 'done' }
}

/**
 * The watchdog's own timing is covered in the core turn-runner tests; here the
 * stall chunks are emitted directly so the assertions are about Telegram's
 * opt-in delivery, not about thresholds.
 */
async function* stallThenAnswerStream(): AsyncGenerator<ResponseChunk> {
  yield { type: 'stall_warning', text: '\u23F3 Provider has not responded for 30s\u2026' }
  yield { type: 'text', text: 'Late answer' }
  yield { type: 'done' }
}

async function* stallThenErrorStream(): AsyncGenerator<ResponseChunk> {
  yield { type: 'stall_warning', text: '\u23F3 Provider has not responded for 30s\u2026' }
  yield { type: 'error', error: 'invalid_api_key' }
}

function createMockAgentCore(): AgentCore {
  const mockSessionManager = {
    getOrCreateSession: vi.fn((_userId: string, _source?: string) => ({
      id: `session-mock-${Date.now()}`,
      userId: _userId,
      source: _source ?? 'telegram',
      startedAt: Date.now(),
      lastActivity: Date.now(),
      messageCount: 0,
      summaryWritten: false,
      restored: false,
    })),
  }
  return {
    sendMessage: vi.fn(),
    handleNewCommand: vi.fn(),
    resetSession: vi.fn(),
    resetSessionAsync: vi.fn(),
    abort: vi.fn(),
    getSessionManager: vi.fn(() => mockSessionManager),
    refreshSystemPrompt: vi.fn(),
    getAgent: vi.fn(),
    dispose: vi.fn(),
  } as unknown as AgentCore
}

function createMockContext(overrides: Record<string, unknown> = {}) {
  return {
    from: {
      id: 12345,
      is_bot: false,
      first_name: 'John',
      last_name: 'Doe',
      username: 'johndoe',
    },
    chat: {
      id: 67890,
      type: 'private',
    },
    message: {
      text: 'Hello agent',
      message_id: 1,
    },
    reply: vi.fn().mockResolvedValue({}),
    replyWithChatAction: vi.fn().mockResolvedValue(true),
    ...overrides,
  }
}

async function* doneOnlyStream(): AsyncGenerator<ResponseChunk> {
  yield { type: 'done' }
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve()
  await vi.advanceTimersByTimeAsync(0)
  await Promise.resolve()
}

type MockHandler = (ctx: ReturnType<typeof createMockContext>) => Promise<void>
type MockBotInternals = {
  _handlers: Map<string, MockHandler>
  _commandHandlers: Map<string, MockHandler>
}

const defaultConfig: TelegramConfig = {
  enabled: true,
  botToken: 'test-token-123',
  adminUserIds: [],
  pollingMode: true,
  webhookUrl: '',
  batchingDelayMs: 2500,
}

describe('TelegramBot', () => {
  let agentCore: AgentCore

  beforeEach(() => {
    agentCore = createMockAgentCore()
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.mocked(loadConfig).mockImplementation((filename: string) => {
      if (filename === 'settings.json') {
        return { batchingDelayMs: 2500 }
      }

      return {
        enabled: true,
        botToken: 'test-token-123',
        adminUserIds: [],
        pollingMode: true,
        webhookUrl: '',
        batchingDelayMs: 2500,
      }
    })
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  describe('constructor', () => {
    it('throws when no bot token provided', () => {
      expect(() => new TelegramBot({
        agentCore,
        config: { ...defaultConfig, botToken: '' },
      })).toThrow('Telegram bot token not configured')
    })

    it('creates bot successfully with valid config', () => {
      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      expect(bot).toBeDefined()
      expect(bot.isRunning()).toBe(false)
      expect(bot.getQueueDepth()).toBe(0)
    })
  })

  describe('start', () => {
    it('verifies token and starts polling', async () => {
      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      await bot.start()

      expect(bot.isRunning()).toBe(true)
      const underlying = bot.getBot() as any
      expect(underlying.api.getMe).toHaveBeenCalled()
      expect(underlying.start).toHaveBeenCalled()
    })
  })

  describe('stop', () => {
    it('stops the bot', async () => {
      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      await bot.start()
      await bot.stop()

      expect(bot.isRunning()).toBe(false)
    })
  })

  describe('/start command', () => {
    it('sends welcome message that points at /help', async () => {
      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._commandHandlers.get('start')!

      const ctx = createMockContext()
      await handler(ctx)

      expect(ctx.reply).toHaveBeenCalledTimes(1)
      const msg = ctx.reply.mock.calls[0][0] as string
      expect(msg).toContain('Welcome to Offtangent')
      expect(msg).toContain('/help')
    })
  })

  describe('/help command', () => {
    it('lists all available slash commands', async () => {
      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._commandHandlers.get('help')!

      const ctx = createMockContext()
      ctx.message = { text: '/help', message_id: 1 }
      await handler(ctx)

      expect(ctx.reply).toHaveBeenCalledTimes(1)
      const msg = ctx.reply.mock.calls[0][0] as string
      expect(msg).toContain('/help')
      expect(msg).toContain('/new')
      expect(msg).toContain('/stop')
      expect(msg).toContain('/tasks')
      expect(msg).toContain('/cronjobs')
      expect(msg).toContain('/model')
      expect(msg).toContain('/thinking')
      expect(msg).toContain('/tts')
    })
  })

  describe('/tts command', () => {
    let dataDir: string
    let previousDataDir: string | undefined

    beforeEach(() => {
      previousDataDir = process.env.DATA_DIR
      dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-tg-voice-'))
      process.env.DATA_DIR = dataDir
      fs.mkdirSync(path.join(dataDir, 'config'), { recursive: true })
      fs.writeFileSync(path.join(dataDir, 'config', 'telegram.json'), JSON.stringify({
        enabled: true,
        botToken: 'test-token-123',
        adminUserIds: [],
        pollingMode: true,
        webhookUrl: '',
        batchingDelayMs: 2500,
        sendVoiceReply: false,
      }, null, 2) + '\n', 'utf-8')
      vi.mocked(loadConfig).mockImplementation((filename: string) => {
        if (filename === 'telegram.json') {
          return JSON.parse(fs.readFileSync(path.join(dataDir, 'config', 'telegram.json'), 'utf-8'))
        }
        return { batchingDelayMs: 2500 }
      })
    })

    afterEach(() => {
      if (previousDataDir === undefined) delete process.env.DATA_DIR
      else process.env.DATA_DIR = previousDataDir
      fs.rmSync(dataDir, { recursive: true, force: true })
    })

    it('toggles automatic Telegram voice replies without changing global TTS', async () => {
      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._commandHandlers.get('tts')!

      const ctx = createMockContext()
      ctx.message = { text: '/tts', message_id: 1 }
      await handler(ctx)

      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('enabled'))
      const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'config', 'telegram.json'), 'utf-8'))
      expect(saved.sendVoiceReply).toBe(true)
    })
  })

  describe('/cron alias command', () => {
    it('dispatches through the shared /cronjobs handler', async () => {
      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._commandHandlers.get('cron')!

      const ctx = createMockContext()
      ctx.message = { text: '/cron', message_id: 1 }
      await handler(ctx)

      expect(ctx.reply).toHaveBeenCalledTimes(1)
      const msg = ctx.reply.mock.calls[0][0] as string
      expect(msg).toContain('Cronjob store is not available')
    })
  })

  describe('/model and /provider commands', () => {
    let dataDir: string
    let previousDataDir: string | undefined

    function writeProviders(providers: unknown): void {
      fs.mkdirSync(path.join(dataDir, 'config'), { recursive: true })
      fs.writeFileSync(
        path.join(dataDir, 'config', 'providers.json'),
        `${JSON.stringify(providers, null, 2)}\n`,
        'utf-8',
      )
    }

    beforeEach(() => {
      previousDataDir = process.env.DATA_DIR
      dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-tg-model-'))
      process.env.DATA_DIR = dataDir
      writeProviders({
        activeProvider: 'p1',
        activeModel: 'gpt-4o',
        providers: [
          {
            id: 'p1', name: 'OpenAI', type: 'openai-completions', providerType: 'openai',
            provider: 'openai', baseUrl: '', apiKey: '',
            enabledModels: ['gpt-4o', 'gpt-4o-mini'],
          },
          {
            id: 'p2', name: 'Anthropic', type: 'anthropic-messages', providerType: 'anthropic',
            provider: 'anthropic', baseUrl: '', apiKey: '',
            enabledModels: ['claude-sonnet-4-20250514', 'claude-3-5-sonnet-20241022'],
          },
        ],
      })
    })

    afterEach(() => {
      if (previousDataDir === undefined) delete process.env.DATA_DIR
      else process.env.DATA_DIR = previousDataDir
      fs.rmSync(dataDir, { recursive: true, force: true })
    })

    it('does not register a /settings command anymore', () => {
      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      expect(underlying._commandHandlers.has('settings')).toBe(false)
      expect(underlying._commandHandlers.has('model')).toBe(true)
      expect(underlying._commandHandlers.has('provider')).toBe(true)
    })

    it('/model sends an inline keyboard with one button per provider', async () => {
      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._commandHandlers.get('model')!

      const ctx = createMockContext()
      ctx.message = { text: '/model', message_id: 1 }
      await handler(ctx)

      expect(ctx.reply).toHaveBeenCalledTimes(1)
      const [text, opts] = ctx.reply.mock.calls[0] as [string, { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } }]
      expect(text).toContain('Choose a provider')
      const rows = opts.reply_markup.inline_keyboard
      expect(rows).toHaveLength(2)
      expect(rows[0]![0]!.text).toMatch(/OpenAI/)
      expect(rows[1]![0]!.text).toMatch(/Anthropic/)
      // All callback_data values should fit Telegram's 64-byte limit and use
      // the picker prefix, not the raw slash command (which contains UUIDs).
      for (const row of rows) {
        const cb = row[0]!.callback_data
        expect(cb.startsWith('pick:')).toBe(true)
        expect(Buffer.byteLength(cb, 'utf-8')).toBeLessThanOrEqual(64)
      }
    })

    it('/provider alias produces the same provider picker', async () => {
      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._commandHandlers.get('provider')!

      const ctx = createMockContext()
      ctx.message = { text: '/provider', message_id: 1 }
      await handler(ctx)

      expect(ctx.reply).toHaveBeenCalledTimes(1)
      const [text] = ctx.reply.mock.calls[0] as [string, unknown]
      expect(text).toContain('Choose a provider')
    })

    it('button tap drills down to the model picker (edits the message in place)', async () => {
      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals

      // Step 1: send /model to get the provider picker + collect tokens
      const cmdCtx = createMockContext()
      cmdCtx.message = { text: '/model', message_id: 1 }
      await underlying._commandHandlers.get('model')!(cmdCtx)
      const rows = (cmdCtx.reply.mock.calls[0] as [string, { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } }])[1].reply_markup.inline_keyboard
      const openaiCallback = rows[0]![0]!.callback_data

      // Step 2: simulate the callback for the OpenAI button
      const callbackHandler = underlying._handlers.get('callback_query:data')!
      const cbCtx = createMockContext({
        callbackQuery: { data: openaiCallback, message: { message_id: 1 } },
        answerCallbackQuery: vi.fn().mockResolvedValue(true),
        editMessageText: vi.fn().mockResolvedValue(true),
        editMessageReplyMarkup: vi.fn().mockResolvedValue(true),
      })
      await callbackHandler(cbCtx as any)

      expect((cbCtx as any).answerCallbackQuery).toHaveBeenCalled()
      expect((cbCtx as any).editMessageText).toHaveBeenCalledTimes(1)
      const [editedText, editedOpts] = (cbCtx as any).editMessageText.mock.calls[0] as [string, { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } }]
      expect(editedText).toContain('OpenAI')
      const modelRows = editedOpts.reply_markup.inline_keyboard
      // 2 enabled models + 1 back button
      expect(modelRows).toHaveLength(3)
      expect(modelRows[0]![0]!.text).toMatch(/gpt-4o/)
      expect(modelRows[modelRows.length - 1]![0]!.text).toMatch(/back/i)
    })

    it('selecting a model edits the message with a confirmation and updates providers.json', async () => {
      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const callbackHandler = underlying._handlers.get('callback_query:data')!

      // Step 1: /model → provider picker
      const ctx1 = createMockContext()
      ctx1.message = { text: '/model', message_id: 1 }
      await underlying._commandHandlers.get('model')!(ctx1)
      const providerRows = (ctx1.reply.mock.calls[0] as [string, { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } }])[1].reply_markup.inline_keyboard
      const anthropicCb = providerRows[1]![0]!.callback_data

      // Step 2: tap Anthropic → model picker (in cb editMessageText)
      const ctx2 = createMockContext({
        callbackQuery: { data: anthropicCb, message: { message_id: 1 } },
        answerCallbackQuery: vi.fn().mockResolvedValue(true),
        editMessageText: vi.fn().mockResolvedValue(true),
      })
      await callbackHandler(ctx2 as any)
      const modelKeyboard = ((ctx2 as any).editMessageText.mock.calls[0] as [string, { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } }])[1]
      // Find the non-default model button (claude-3-5-sonnet-20241022)
      const modelRows = modelKeyboard.reply_markup.inline_keyboard
      const targetRow = modelRows.find((r) => /claude-3-5-sonnet-20241022/.test(r[0]!.text))
      expect(targetRow).toBeDefined()
      const modelCb = targetRow![0]!.callback_data

      // Step 3: tap that model → confirmation text, no keyboard
      const ctx3 = createMockContext({
        callbackQuery: { data: modelCb, message: { message_id: 1 } },
        answerCallbackQuery: vi.fn().mockResolvedValue(true),
        editMessageText: vi.fn().mockResolvedValue(true),
      })
      await callbackHandler(ctx3 as any)
      const [confirmText, confirmOpts] = (ctx3 as any).editMessageText.mock.calls[0] as [string, { reply_markup?: unknown }]
      expect(confirmText).toContain('Active provider')
      expect(confirmText).toContain('Anthropic')
      expect(confirmText).toContain('claude-3-5-sonnet-20241022')
      expect(confirmOpts.reply_markup).toBeUndefined()

      // providers.json was actually mutated
      const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'config', 'providers.json'), 'utf-8'))
      expect(stored.activeProvider).toBe('p2')
      expect(stored.activeModel).toBe('claude-3-5-sonnet-20241022')
    })

    it('expired or unknown picker tokens show an alert and strip the keyboard', async () => {
      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const callbackHandler = underlying._handlers.get('callback_query:data')!

      const ctx = createMockContext({
        callbackQuery: { data: 'pick:deadbeef', message: { message_id: 1 } },
        answerCallbackQuery: vi.fn().mockResolvedValue(true),
        editMessageReplyMarkup: vi.fn().mockResolvedValue(true),
      })
      await callbackHandler(ctx as any)
      expect((ctx as any).answerCallbackQuery).toHaveBeenCalledWith(
        expect.objectContaining({ show_alert: true }),
      )
      expect((ctx as any).editMessageReplyMarkup).toHaveBeenCalled()
    })
  })

  describe('/skill command', () => {
    let dataDir: string
    let previousDataDir: string | undefined

    function writeAgentSkill(dir: string, name: string, body: string): void {
      const skillDir = path.join(dataDir, 'skills_agent', dir)
      fs.mkdirSync(skillDir, { recursive: true })
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`, 'utf-8')
    }

    beforeEach(() => {
      previousDataDir = process.env.DATA_DIR
      dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-tg-skill-'))
      process.env.DATA_DIR = dataDir
      writeAgentSkill('deploy', 'deploy', 'Deploy body')
      writeAgentSkill('review', 'code-review', 'Review body')
    })

    afterEach(() => {
      if (previousDataDir === undefined) delete process.env.DATA_DIR
      else process.env.DATA_DIR = previousDataDir
      fs.rmSync(dataDir, { recursive: true, force: true })
    })

    it('registers /skill and lists it in the bot menu', async () => {
      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      expect(underlying._commandHandlers.has('skill')).toBe(true)
      await bot.start()
      const menu = (bot.getBot() as any).api.setMyCommands.mock.calls[0]![0] as { command: string }[]
      expect(menu.map((c) => c.command)).toContain('skill')
    })

    it('bare /skill sends an inline keyboard with one button per skill', async () => {
      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals

      const ctx = createMockContext()
      ctx.message = { text: '/skill', message_id: 1 }
      await underlying._commandHandlers.get('skill')!(ctx)

      const [text, opts] = ctx.reply.mock.calls[0] as [string, { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } }]
      expect(text).toContain('Choose a skill')
      const rows = opts.reply_markup.inline_keyboard
      expect(rows.map((r) => r[0]!.text)).toEqual(['code-review', 'deploy'])
      expect(agentCore.sendMessage).not.toHaveBeenCalled()
    })

    it('tapping a skill loads it as an agent turn and edits the picker message', async () => {
      vi.mocked(agentCore.sendMessage).mockReturnValue(textStream('Skill deploy loaded. What should I do?'))
      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals

      const cmdCtx = createMockContext()
      cmdCtx.message = { text: '/skill', message_id: 1 }
      await underlying._commandHandlers.get('skill')!(cmdCtx)
      const rows = (cmdCtx.reply.mock.calls[0] as [string, { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } }])[1].reply_markup.inline_keyboard
      const deployCb = rows.find((r) => r[0]!.text === 'deploy')![0]!.callback_data

      const cbCtx = createMockContext({
        callbackQuery: { data: deployCb, message: { message_id: 1 } },
        answerCallbackQuery: vi.fn().mockResolvedValue(true),
        editMessageText: vi.fn().mockResolvedValue(true),
      })
      await underlying._handlers.get('callback_query:data')!(cbCtx as any)
      await flushAsyncWork()

      const [editedText, editedOpts] = (cbCtx as any).editMessageText.mock.calls[0] as [string, { reply_markup?: unknown }]
      expect(editedText).toContain('deploy')
      expect(editedOpts.reply_markup).toBeUndefined()

      expect(agentCore.sendMessage).toHaveBeenCalledTimes(1)
      const [userId, agentText, source] = vi.mocked(agentCore.sendMessage).mock.calls[0] as [string, string, string]
      expect(userId).toBe('telegram-12345')
      expect(source).toBe('telegram')
      expect(agentText).toContain('<skill name="deploy">')
      expect(agentText).toContain('Deploy body')
      expect(agentText).toMatch(/ask what they want to do/i)

      const botApi = (bot.getBot() as any).api
      expect(botApi.sendMessage).toHaveBeenCalledWith(67890, 'Skill deploy loaded. What should I do?', { parse_mode: 'HTML' })
    })

    it('/skill:<name> <prompt> typed as text runs the prompt with the skill loaded, without batching', async () => {
      vi.mocked(agentCore.sendMessage).mockReturnValue(textStream('Reviewing.'))
      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals

      const ctx = createMockContext()
      ctx.message = { text: '/skill:review look at PR 42', message_id: 1 }
      await underlying._handlers.get('message:text')!(ctx)
      await flushAsyncWork()

      expect(agentCore.sendMessage).toHaveBeenCalledTimes(1)
      const agentText = (vi.mocked(agentCore.sendMessage).mock.calls[0] as [string, string])[1]
      expect(agentText).toContain('Review body')
      expect(agentText).toContain('look at PR 42')
      expect(agentText).not.toMatch(/Do not act yet/)
    })

    it('unknown skill replies with the available list and does not start a turn', async () => {
      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals

      const ctx = createMockContext()
      ctx.message = { text: '/skill:nope', message_id: 1 }
      await underlying._commandHandlers.get('skill')!(ctx)

      const [text] = ctx.reply.mock.calls[0] as [string]
      expect(text).toContain('Unknown skill: nope')
      expect(text).toContain('/skill:deploy')
      expect(agentCore.sendMessage).not.toHaveBeenCalled()
    })
  })

  describe('/new command', () => {
    it('resets via resetSessionAsync so the in-memory context is actually cleared', async () => {
      // Must use resetSessionAsync (clears runtime messages), NOT handleNewCommand
      // (only rotates the session id) — otherwise a poisoned context survives /new.
      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._commandHandlers.get('new')!

      const ctx = createMockContext()
      await handler(ctx)

      expect(agentCore.resetSessionAsync).toHaveBeenCalledWith('telegram-12345', 'telegram', 'main')
      expect(agentCore.handleNewCommand).not.toHaveBeenCalled()
      expect(ctx.reply).toHaveBeenCalledWith('🔄 Starting fresh conversation!')
    })

    it('handles errors gracefully', async () => {
      vi.mocked(agentCore.resetSessionAsync).mockImplementation(() => { throw new Error('reset failed') })

      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._commandHandlers.get('new')!

      const ctx = createMockContext()
      await handler(ctx)

      expect(ctx.reply).toHaveBeenCalledWith('⚠️ Error resetting session. Please try again.')
    })
  })

  describe('message batching', () => {
    it('concatenates two messages sent within the batching window', async () => {
      vi.mocked(agentCore.sendMessage).mockReturnValue(doneOnlyStream())

      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._handlers.get('message:text')!

      const first = createMockContext({ message: { text: 'Hello', message_id: 1 } })
      const second = createMockContext({ message: { text: 'world', message_id: 2 } })

      await handler(first)
      await vi.advanceTimersByTimeAsync(2000)
      await handler(second)

      expect(agentCore.sendMessage).not.toHaveBeenCalled()
      expect(bot.getQueueDepth()).toBe(1)

      await vi.advanceTimersByTimeAsync(2499)
      expect(agentCore.sendMessage).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      expect(agentCore.sendMessage).toHaveBeenCalledTimes(1)
      expect(agentCore.sendMessage).toHaveBeenCalledWith(
        'telegram-12345',
        'Hello\nworld',
        'telegram',
        undefined,
        'main'
      )
    })

    it('resets the batching timer on each new message from the same chat', async () => {
      vi.mocked(agentCore.sendMessage).mockReturnValue(doneOnlyStream())

      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._handlers.get('message:text')!

      await handler(createMockContext({ message: { text: 'Part 1', message_id: 1 } }))
      await vi.advanceTimersByTimeAsync(2000)
      await handler(createMockContext({ message: { text: 'Part 2', message_id: 2 } }))
      await vi.advanceTimersByTimeAsync(2000)

      expect(agentCore.sendMessage).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(500)
      expect(agentCore.sendMessage).toHaveBeenCalledTimes(1)
    })

    it('uses the batching delay from telegram.json when created via config loading', async () => {
      vi.mocked(loadConfig).mockImplementation(() => ({
        enabled: true,
        botToken: 'test-token-123',
        adminUserIds: [],
        pollingMode: true,
        webhookUrl: '',
        batchingDelayMs: 4000,
      }))
      vi.mocked(agentCore.sendMessage).mockReturnValue(doneOnlyStream())

      const bot = createTelegramBot(agentCore)!
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._handlers.get('message:text')!

      await handler(createMockContext({ message: { text: 'Delayed', message_id: 1 } }))
      await vi.advanceTimersByTimeAsync(3999)
      expect(agentCore.sendMessage).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      expect(agentCore.sendMessage).toHaveBeenCalledTimes(1)
    })

    it('falls back to legacy top-level batchingDelayMs in settings.json when telegram.json is missing the key', async () => {
      // Simulate an upgraded install whose telegram.json predates the move
      // and therefore has no batchingDelayMs field at all, while the user's
      // customised delay still lives at the top of settings.json.
      vi.mocked(loadConfig).mockImplementation((filename: string) => {
        if (filename === 'settings.json') {
          return { batchingDelayMs: 5000 }
        }
        return {
          enabled: true,
          botToken: 'test-token-123',
          adminUserIds: [],
          pollingMode: true,
          webhookUrl: '',
          // batchingDelayMs intentionally omitted
        }
      })
      vi.mocked(agentCore.sendMessage).mockReturnValue(doneOnlyStream())

      const bot = createTelegramBot(agentCore)!
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._handlers.get('message:text')!

      await handler(createMockContext({ message: { text: 'Delayed', message_id: 1 } }))
      await vi.advanceTimersByTimeAsync(4999)
      expect(agentCore.sendMessage).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      expect(agentCore.sendMessage).toHaveBeenCalledTimes(1)
    })

    it('prefers telegram.json batchingDelayMs over the legacy settings.json value when both exist', async () => {
      vi.mocked(loadConfig).mockImplementation((filename: string) => {
        if (filename === 'settings.json') {
          return { batchingDelayMs: 5000 }
        }
        return {
          enabled: true,
          botToken: 'test-token-123',
          adminUserIds: [],
          pollingMode: true,
          webhookUrl: '',
          batchingDelayMs: 1500,
        }
      })
      vi.mocked(agentCore.sendMessage).mockReturnValue(doneOnlyStream())

      const bot = createTelegramBot(agentCore)!
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._handlers.get('message:text')!

      await handler(createMockContext({ message: { text: 'Delayed', message_id: 1 } }))
      await vi.advanceTimersByTimeAsync(1499)
      expect(agentCore.sendMessage).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      expect(agentCore.sendMessage).toHaveBeenCalledTimes(1)
    })

    it('fires the batch only after the silence period expires', async () => {
      vi.mocked(agentCore.sendMessage).mockReturnValue(doneOnlyStream())

      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._handlers.get('message:text')!

      await handler(createMockContext({ message: { text: 'Wait for silence', message_id: 1 } }))
      await vi.advanceTimersByTimeAsync(2499)
      expect(agentCore.sendMessage).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      expect(agentCore.sendMessage).toHaveBeenCalledTimes(1)
    })
  })

  describe('message queue', () => {
    it('processes queued batches FIFO, one at a time', async () => {
      let releaseFirst!: () => void
      const firstDone = new Promise<void>((resolve) => {
        releaseFirst = resolve
      })

      async function* firstStream(): AsyncGenerator<ResponseChunk> {
        yield { type: 'text', text: 'First response' }
        await firstDone
        yield { type: 'done' }
      }

      async function* secondStream(): AsyncGenerator<ResponseChunk> {
        yield { type: 'text', text: 'Second response' }
        yield { type: 'done' }
      }

      vi.mocked(agentCore.sendMessage)
        .mockReturnValueOnce(firstStream())
        .mockReturnValueOnce(secondStream())

      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._handlers.get('message:text')!

      const first = createMockContext({ message: { text: 'First task', message_id: 1 } })
      const second = createMockContext({ message: { text: 'Second task', message_id: 2 } })

      await handler(first)
      await vi.advanceTimersByTimeAsync(2500)
      expect(agentCore.sendMessage).toHaveBeenCalledTimes(1)
      expect(bot.getQueueDepth()).toBe(1)

      await handler(second)
      await vi.advanceTimersByTimeAsync(2500)
      expect(agentCore.sendMessage).toHaveBeenCalledTimes(1)
      expect(bot.getQueueDepth()).toBe(2)

      releaseFirst()
      await flushAsyncWork()
      await flushAsyncWork()

      expect(agentCore.sendMessage).toHaveBeenCalledTimes(2)
      expect(vi.mocked(agentCore.sendMessage).mock.calls.map((call) => call[1])).toEqual([
        'First task',
        'Second task',
      ])
    })
  })

  describe('S1-D interjection (steer) during a running turn', () => {
    function setup(offer: (input: any) => any) {
      let release!: () => void
      const firstDone = new Promise<void>((resolve) => { release = resolve })
      async function* firstStream(): AsyncGenerator<ResponseChunk> {
        yield { type: 'text', text: 'Working' }
        await firstDone
        yield { type: 'done' }
      }
      vi.mocked(agentCore.sendMessage)
        .mockReturnValueOnce(firstStream())
        .mockImplementation(() => doneOnlyStream())
      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const runner = (bot as any).turnRunner
      const offerSpy = vi.fn(offer)
      runner.offerSteerToLiveTurn = offerSpy
      const handler = (bot.getBot() as unknown as MockBotInternals)._handlers.get('message:text')!
      return { bot, handler, offerSpy, release: () => release() }
    }
    const replies = (ctx: any) => ctx.reply.mock.calls.map((c: unknown[]) => String(c[0]))

    it('hands a message to the running turn and confirms "Zwischenruf übergeben"; no second turn', async () => {
      let settle!: (delivered: boolean) => void
      const { bot, handler, offerSpy, release } = setup(() => ({
        accepted: true, turnId: 'turn-1', settled: new Promise<boolean>((r) => { settle = r }),
      }))
      await handler(createMockContext({ message: { text: 'First task', message_id: 1 } }))
      await vi.advanceTimersByTimeAsync(2500)
      const second = createMockContext({ message: { text: 'nimm Variante B', message_id: 2 } })
      await handler(second)
      await vi.advanceTimersByTimeAsync(2500)
      expect(offerSpy).toHaveBeenCalledTimes(1)
      expect(offerSpy.mock.calls[0]![0]).toMatchObject({ text: 'nimm Variante B', source: 'telegram' })
      expect(replies(second).join('\n')).toContain('Zwischenruf übergeben')
      expect(bot.getQueueDepth()).toBe(1)
      settle(true)
      release()
      await flushAsyncWork()
      await flushAsyncWork()
      expect(agentCore.sendMessage).toHaveBeenCalledTimes(1)
    })

    it('queues with "wartet, bis der Lauf fertig ist" when the run refuses (no tool batch / slot taken)', async () => {
      const { bot, handler, offerSpy, release } = setup(() => ({ accepted: false, reason: 'slot_taken' }))
      await handler(createMockContext({ message: { text: 'First task', message_id: 1 } }))
      await vi.advanceTimersByTimeAsync(2500)
      const second = createMockContext({ message: { text: 'Second', message_id: 2 } })
      await handler(second)
      await vi.advanceTimersByTimeAsync(2500)
      expect(offerSpy).toHaveBeenCalledTimes(1)
      expect(replies(second).join('\n')).toMatch(/[Ww]artet, bis der Lauf fertig ist/)
      expect(bot.getQueueDepth()).toBe(2)
      release()
      await flushAsyncWork()
      await flushAsyncWork()
      expect(vi.mocked(agentCore.sendMessage).mock.calls.map((c) => c[1])).toEqual(['First task', 'Second'])
    })

    it('a steer the run did not take falls back to the queue and runs once', async () => {
      let settle!: (delivered: boolean) => void
      const { handler, release } = setup(() => ({
        accepted: true, turnId: 'turn-1', settled: new Promise<boolean>((r) => { settle = r }),
      }))
      await handler(createMockContext({ message: { text: 'First task', message_id: 1 } }))
      await vi.advanceTimersByTimeAsync(2500)
      const second = createMockContext({ message: { text: 'late', message_id: 2 } })
      await handler(second)
      await vi.advanceTimersByTimeAsync(2500)
      settle(false)
      await flushAsyncWork()
      expect(replies(second).join('\n')).toMatch(/[Ww]artet/)
      release()
      await flushAsyncWork()
      await flushAsyncWork()
      expect(vi.mocked(agentCore.sendMessage).mock.calls.map((c) => c[1])).toEqual(['First task', 'late'])
    })

    it('REVIEW-S1-D finding 1: a refused steer keeps its reserved place ahead of a message queued meanwhile', async () => {
      let settle!: (delivered: boolean) => void
      let offered = 0
      const { handler, release } = setup(() => {
        offered++
        if (offered > 1) return { accepted: false, reason: 'slot_taken' }
        return { accepted: true, turnId: 'turn-1', settled: new Promise<boolean>((r) => { settle = r }) }
      })
      await handler(createMockContext({ message: { text: 'First task', message_id: 1 } }))
      await vi.advanceTimersByTimeAsync(2500)
      await handler(createMockContext({ message: { text: 'first', message_id: 2 } }))
      await vi.advanceTimersByTimeAsync(2500)
      await handler(createMockContext({ message: { text: 'second', message_id: 3 } }))
      await vi.advanceTimersByTimeAsync(2500)
      settle(false)
      await flushAsyncWork()
      release()
      await flushAsyncWork()
      await flushAsyncWork()
      await flushAsyncWork()
      expect(vi.mocked(agentCore.sendMessage).mock.calls.map((c) => c[1])).toEqual(['First task', 'first', 'second'])
    })

    it('a message behind an already waiting one is queued without a steer offer', async () => {
      const { handler, offerSpy } = setup(() => ({ accepted: false, reason: 'slot_taken' }))
      await handler(createMockContext({ message: { text: 'First task', message_id: 1 } }))
      await vi.advanceTimersByTimeAsync(2500)
      await handler(createMockContext({ message: { text: 'Second', message_id: 2 } }))
      await vi.advanceTimersByTimeAsync(2500)
      const third = createMockContext({ message: { text: 'Third', message_id: 3 } })
      await handler(third)
      await vi.advanceTimersByTimeAsync(2500)
      expect(offerSpy).toHaveBeenCalledTimes(1)
      expect(replies(third).join('\n')).toMatch(/[Ww]artet/)
    })
  })

  describe('kill switch', () => {
    it('/stop aborts the current task, flushes queued work, and reports the removed count', async () => {
      let releaseFirst!: () => void
      const firstDone = new Promise<void>((resolve) => {
        releaseFirst = resolve
      })

      async function* firstStream(): AsyncGenerator<ResponseChunk> {
        yield { type: 'text', text: 'Working...' }
        await firstDone
        yield { type: 'done' }
      }

      vi.mocked(agentCore.sendMessage).mockReturnValue(firstStream())

      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const messageHandler = underlying._handlers.get('message:text')!
      const stopHandler = underlying._commandHandlers.get('stop')!

      await messageHandler(createMockContext({ message: { text: 'Run task', message_id: 1 } }))
      await vi.advanceTimersByTimeAsync(2500)
      expect(agentCore.sendMessage).toHaveBeenCalledTimes(1)

      await messageHandler(createMockContext({ message: { text: 'Queued task', message_id: 2 } }))
      await vi.advanceTimersByTimeAsync(2500)
      expect(bot.getQueueDepth()).toBe(2)
      expect(agentCore.sendMessage).toHaveBeenCalledTimes(1)

      const stopCtx = createMockContext({ message: { text: '/stop', message_id: 3 } })
      await stopHandler(stopCtx)

      expect(agentCore.abort).toHaveBeenCalledTimes(1)
      expect(stopCtx.reply).toHaveBeenCalledWith('⛔ Aborted. 1 messages removed from queue.', { parse_mode: 'HTML' })
      expect(bot.getQueueDepth()).toBe(1)

      releaseFirst()
      await flushAsyncWork()
      await flushAsyncWork()
      expect(agentCore.sendMessage).toHaveBeenCalledTimes(1)
      expect(bot.getQueueDepth()).toBe(0)
    })

    it('/kill behaves as an alias for /stop', async () => {
      let releaseTask!: () => void
      const blocked = new Promise<void>((resolve) => {
        releaseTask = resolve
      })

      async function* blockedStream(): AsyncGenerator<ResponseChunk> {
        yield { type: 'text', text: 'Still working' }
        await blocked
        yield { type: 'done' }
      }

      vi.mocked(agentCore.sendMessage).mockReturnValue(blockedStream())

      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const messageHandler = underlying._handlers.get('message:text')!
      const killHandler = underlying._commandHandlers.get('kill')!

      await messageHandler(createMockContext({ message: { text: 'Task', message_id: 1 } }))
      await vi.advanceTimersByTimeAsync(2500)

      const killCtx = createMockContext({ message: { text: '/kill', message_id: 2 } })
      await killHandler(killCtx)

      expect(agentCore.abort).toHaveBeenCalledTimes(1)
      expect(killCtx.reply).toHaveBeenCalledWith('Task aborted. No queued messages.', { parse_mode: 'HTML' })

      releaseTask()
      await flushAsyncWork()
      await flushAsyncWork()
      expect(bot.getQueueDepth()).toBe(0)
    })

    it('returns "Nothing to stop." when no task is running and nothing is queued', async () => {
      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const stopHandler = underlying._commandHandlers.get('stop')!

      const ctx = createMockContext({ message: { text: '/stop', message_id: 1 } })
      await stopHandler(ctx)

      expect(agentCore.abort).not.toHaveBeenCalled()
      expect(ctx.reply).toHaveBeenCalledWith('Nothing to stop.', { parse_mode: 'HTML' })
      expect(bot.getQueueDepth()).toBe(0)
    })

    it('returns "Task aborted. No queued messages." when only the current task is running', async () => {
      let releaseTask!: () => void
      const blocked = new Promise<void>((resolve) => {
        releaseTask = resolve
      })

      async function* blockedStream(): AsyncGenerator<ResponseChunk> {
        yield { type: 'text', text: 'Working' }
        await blocked
        yield { type: 'done' }
      }

      vi.mocked(agentCore.sendMessage).mockReturnValue(blockedStream())

      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const messageHandler = underlying._handlers.get('message:text')!
      const stopHandler = underlying._commandHandlers.get('stop')!

      await messageHandler(createMockContext({ message: { text: 'Only task', message_id: 1 } }))
      await vi.advanceTimersByTimeAsync(2500)

      const stopCtx = createMockContext({ message: { text: '/stop', message_id: 2 } })
      await stopHandler(stopCtx)

      expect(agentCore.abort).toHaveBeenCalledTimes(1)
      expect(stopCtx.reply).toHaveBeenCalledWith('Task aborted. No queued messages.', { parse_mode: 'HTML' })

      releaseTask()
      await flushAsyncWork()
      await flushAsyncWork()
    })
  })

  describe('message handling', () => {
    it('routes messages to agent core with user context after batching', async () => {
      async function* mockStream(): AsyncGenerator<ResponseChunk> {
        yield { type: 'text', text: 'Hello ' }
        yield { type: 'text', text: 'human!' }
        yield { type: 'done' }
      }
      vi.mocked(agentCore.sendMessage).mockReturnValue(mockStream())

      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._handlers.get('message:text')!

      const ctx = createMockContext()
      await handler(ctx)
      await vi.advanceTimersByTimeAsync(2500)

      expect(agentCore.sendMessage).toHaveBeenCalledWith(
        'telegram-12345',
        'Hello agent',
        'telegram',
        undefined,
        'main'
      )
      const botApi = (bot.getBot() as any).api
      expect(botApi.sendMessage).toHaveBeenCalledWith(67890, 'Hello human!', { parse_mode: 'HTML' })
    })

    it('degrades an interactive block to a numbered list instead of raw JSON (SPEC 7.4c/7.11)', async () => {
      const fence = [
        '```offtangent',
        JSON.stringify({
          block: 'choice',
          id: 'b1',
          question: 'Hand this to Bob?',
          options: [
            { id: 'yes', label: 'Hand over to Bob' },
            { id: 'stay', label: 'Keep it here' },
          ],
        }),
        '```',
      ].join('\n')
      async function* blockStream(): AsyncGenerator<ResponseChunk> {
        yield { type: 'text', text: `Two ways to go here.\n\n${fence}` }
        yield { type: 'done' }
      }
      vi.mocked(agentCore.sendMessage).mockReturnValue(blockStream())

      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._handlers.get('message:text')!

      await handler(createMockContext())
      await vi.advanceTimersByTimeAsync(2500)

      const botApi = (bot.getBot() as any).api
      const sent = vi.mocked(botApi.sendMessage).mock.calls.map((call: any[]) => String(call[1])).join('\n')
      expect(sent).toContain('Hand this to Bob?')
      expect(sent).toContain('1. Hand over to Bob')
      expect(sent).toContain('2. Keep it here')
      expect(sent).toContain('Reply with the number or the label.')
      expect(sent).not.toContain('offtangent')
      expect(sent).not.toContain('"block"')
      expect(sent).not.toContain('{')
    })

    it('sends a fallback notice on empty responses instead of staying silent', async () => {
      // Empty turns (e.g. pi-agent swallowing a run failure into an empty
      // assistant message) must be surfaced to the user, not dropped —
      // incident 2026-07-20.
      vi.mocked(agentCore.sendMessage).mockReturnValue(doneOnlyStream())

      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._handlers.get('message:text')!

      const ctx = createMockContext()
      await handler(ctx)
      await vi.advanceTimersByTimeAsync(2500)

      expect(ctx.reply).toHaveBeenCalledTimes(1)
      expect(vi.mocked(ctx.reply).mock.calls[0][0]).toContain('keine Antwort erzeugt')
    })

    it('reports a failed turn as an error message instead of ending silently', async () => {
      vi.mocked(agentCore.sendMessage).mockImplementation(() => {
        throw new Error('agent failed')
      })

      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._handlers.get('message:text')!

      const ctx = createMockContext()
      await handler(ctx)
      await vi.advanceTimersByTimeAsync(2500)

      const botApi = (bot.getBot() as any).api
      expect(botApi.sendMessage).toHaveBeenCalledWith(
        67890,
        expect.stringContaining('agent failed'),
        expect.objectContaining({ parse_mode: 'HTML' }),
      )
    })
  })

  describe('DM vs group chat', () => {
    it('sends telegram source for DM (private) chats', async () => {
      vi.mocked(agentCore.sendMessage).mockReturnValue(doneOnlyStream())

      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._handlers.get('message:text')!

      const ctx = createMockContext({
        chat: { id: 67890, type: 'private' },
        message: { text: 'Hello DM', message_id: 1 },
      })
      await handler(ctx)
      await vi.advanceTimersByTimeAsync(2500)

      expect(agentCore.sendMessage).toHaveBeenCalledWith(
        'telegram-12345',
        'Hello DM',
        'telegram',
        undefined,
        'main'
      )
    })

    it('sends telegram-group source for group chats', async () => {
      vi.mocked(agentCore.sendMessage).mockReturnValue(doneOnlyStream())

      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._handlers.get('message:text')!

      const ctx = createMockContext({
        chat: { id: 67890, type: 'group' },
        message: { text: 'Hello group', message_id: 1 },
      })
      await handler(ctx)
      await vi.advanceTimersByTimeAsync(2500)

      expect(agentCore.sendMessage).toHaveBeenCalledWith(
        'telegram-12345',
        'Hello group',
        'telegram-group',
        undefined,
        'main'
      )
    })

    it('sends telegram-group source for supergroup chats', async () => {
      vi.mocked(agentCore.sendMessage).mockReturnValue(doneOnlyStream())

      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._handlers.get('message:text')!

      const ctx = createMockContext({
        chat: { id: 67890, type: 'supergroup' },
        message: { text: 'Hello supergroup', message_id: 1 },
      })
      await handler(ctx)
      await vi.advanceTimersByTimeAsync(2500)

      expect(agentCore.sendMessage).toHaveBeenCalledWith(
        'telegram-12345',
        'Hello supergroup',
        'telegram-group',
        undefined,
        'main'
      )
    })
  })

  describe('reply-to message context', () => {
    it('extractReplyContext returns the replied-to text', () => {
      expect(extractReplyContext({ text: 'hello there' })).toBe('hello there')
    })

    it('extractReplyContext falls back to caption for photo/document replies', () => {
      expect(extractReplyContext({ caption: 'a caption' })).toBe('a caption')
    })

    it('extractReplyContext prefers text over caption when both exist', () => {
      expect(extractReplyContext({ text: 'the text', caption: 'ignored' })).toBe('the text')
    })

    it('extractReplyContext returns undefined for non-text replies (sticker/voice)', () => {
      expect(extractReplyContext({ sticker: { file_id: 'x' } })).toBeUndefined()
      expect(extractReplyContext(undefined)).toBeUndefined()
      expect(extractReplyContext(null)).toBeUndefined()
    })

    it('extractReplyContext truncates long texts at 500 chars with a single ellipsis', () => {
      const long = 'x'.repeat(600)
      const result = extractReplyContext({ text: long })!
      // 500 chars + U+2026
      expect(result).toHaveLength(501)
      expect(result.endsWith('\u2026')).toBe(true)
      expect(result.slice(0, 500)).toBe('x'.repeat(500))
    })

    it('buildAgentMessage wraps the reply context and leaves the body below', () => {
      expect(buildAgentMessage('do it again', 'Previous answer'))
        .toBe('<reply-context>Previous answer</reply-context>\ndo it again')
    })

    it('buildAgentMessage returns the body unchanged when no reply context is present', () => {
      expect(buildAgentMessage('just a message', undefined)).toBe('just a message')
    })

    it('prepends <reply-context> wrapper to the agent-facing message when the user replied to a bot message', async () => {
      vi.mocked(agentCore.sendMessage).mockReturnValue(doneOnlyStream())

      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._handlers.get('message:text')!

      const ctx = createMockContext({
        message: {
          text: 'can you explain?',
          message_id: 10,
          reply_to_message: { message_id: 9, text: 'The capital of France is Paris.', from: { id: 123456, is_bot: true } },
        },
      })
      await handler(ctx)
      await vi.advanceTimersByTimeAsync(2500)

      expect(agentCore.sendMessage).toHaveBeenCalledWith(
        'telegram-12345',
        '<reply-context>The capital of France is Paris.</reply-context>\ncan you explain?',
        'telegram',
        undefined,
        'main',
      )
    })

    it('prepends wrapper when replying to another user message (non-bot)', async () => {
      vi.mocked(agentCore.sendMessage).mockReturnValue(doneOnlyStream())

      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._handlers.get('message:text')!

      const ctx = createMockContext({
        message: {
          text: 'agree',
          message_id: 11,
          reply_to_message: { message_id: 2, text: "let's ship it", from: { id: 77, is_bot: false } },
        },
      })
      await handler(ctx)
      await vi.advanceTimersByTimeAsync(2500)

      expect(agentCore.sendMessage).toHaveBeenCalledWith(
        'telegram-12345',
        "<reply-context>let's ship it</reply-context>\nagree",
        'telegram',
        undefined,
        'main',
      )
    })

    it('does not inject any wrapper when there is no reply_to_message', async () => {
      vi.mocked(agentCore.sendMessage).mockReturnValue(doneOnlyStream())

      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._handlers.get('message:text')!

      await handler(createMockContext({ message: { text: 'hi', message_id: 1 } }))
      await vi.advanceTimersByTimeAsync(2500)

      expect(agentCore.sendMessage).toHaveBeenCalledWith(
        'telegram-12345',
        'hi',
        'telegram',
        undefined,
        'main',
      )
    })

    it('truncates long reply-to texts at 500 chars with a single ellipsis', async () => {
      vi.mocked(agentCore.sendMessage).mockReturnValue(doneOnlyStream())

      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._handlers.get('message:text')!

      const long = 'x'.repeat(600)
      const ctx = createMockContext({
        message: {
          text: 'hm',
          message_id: 12,
          reply_to_message: { message_id: 11, text: long },
        },
      })
      await handler(ctx)
      await vi.advanceTimersByTimeAsync(2500)

      const [, forwarded] = vi.mocked(agentCore.sendMessage).mock.calls[0]
      const expected = `<reply-context>${'x'.repeat(500)}\u2026</reply-context>\nhm`
      expect(forwarded).toBe(expected)
    })

    it('uses caption when replying to a photo with a caption', async () => {
      vi.mocked(agentCore.sendMessage).mockReturnValue(doneOnlyStream())

      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._handlers.get('message:text')!

      const ctx = createMockContext({
        message: {
          text: 'nice pic',
          message_id: 13,
          reply_to_message: { message_id: 12, caption: 'sunset over the mountains', photo: [{ file_id: 'p1' }] },
        },
      })
      await handler(ctx)
      await vi.advanceTimersByTimeAsync(2500)

      expect(agentCore.sendMessage).toHaveBeenCalledWith(
        'telegram-12345',
        '<reply-context>sunset over the mountains</reply-context>\nnice pic',
        'telegram',
        undefined,
        'main',
      )
    })

    it('silently omits the wrapper when replying to a non-text message (sticker)', async () => {
      vi.mocked(agentCore.sendMessage).mockReturnValue(doneOnlyStream())

      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._handlers.get('message:text')!

      const ctx = createMockContext({
        message: {
          text: 'lol',
          message_id: 14,
          reply_to_message: { message_id: 13, sticker: { file_id: 's1' } },
        },
      })
      await handler(ctx)
      await vi.advanceTimersByTimeAsync(2500)

      expect(agentCore.sendMessage).toHaveBeenCalledWith(
        'telegram-12345',
        'lol',
        'telegram',
        undefined,
        'main',
      )
    })

    it('stores the original user text in chat_messages (wrapper only in agent-facing string)', async () => {
      vi.mocked(agentCore.sendMessage).mockReturnValue(doneOnlyStream())

      // Capture DB writes
      const inserts: Array<{ sql: string; args: unknown[] }> = []
      const mockDb = {
        prepare: (sql: string) => ({
          run: (...args: unknown[]) => { inserts.push({ sql, args }); return { changes: 1, lastInsertRowid: 1 } },
          // Any SELECT returns an approved linked user row (covers
          // ensureTelegramUser + resolveNumericUserId + resolveUsername).
          get: () => ({ id: 1, telegram_id: '12345', telegram_username: 'johndoe', telegram_display_name: 'John Doe', status: 'approved', user_id: 42, username: 'john', created_at: 'now', updated_at: 'now' }),
          all: () => [],
        }),
        // supersedeOpenOnUserMessage runs in a transaction (pre-existing gap of this mock).
        transaction: (fn: (...args: unknown[]) => unknown) => (...args: unknown[]) => fn(...args),
        inTransaction: false,
      } as unknown as Database

      const bot = new TelegramBot({ agentCore, db: mockDb, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._handlers.get('message:text')!

      const ctx = createMockContext({
        message: {
          text: 'follow-up question',
          message_id: 15,
          reply_to_message: { message_id: 14, text: 'the earlier answer' },
        },
      })
      await handler(ctx)
      await vi.advanceTimersByTimeAsync(2500)

      const chatInsert = inserts.find(i => i.sql.startsWith('INSERT INTO chat_messages'))
      expect(chatInsert).toBeDefined()
      // content column must be the user's original text, NOT the wrapped string
      const content = chatInsert!.args[3]
      expect(content).toBe('follow-up question')
      expect(String(content)).not.toContain('<reply-context>')
      // metadata JSON carries the replyContext excerpt for the web UI
      const metadata = chatInsert!.args[4] as string | null
      expect(metadata).not.toBeNull()
      expect(JSON.parse(metadata!)).toEqual({ replyContext: 'the earlier answer' })
    })

    it('forwards replyContext on the onChatEvent user_message for cross-channel sync', async () => {
      vi.mocked(agentCore.sendMessage).mockReturnValue(doneOnlyStream())

      const events: TelegramChatEvent[] = []
      const bot = new TelegramBot({
        agentCore,
        config: defaultConfig,
        onChatEvent: (e) => { events.push(e) },
      })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._handlers.get('message:text')!

      const ctx = createMockContext({
        message: {
          text: 'do X',
          message_id: 16,
          reply_to_message: { message_id: 15, text: 'previous bot reply' },
        },
      })
      await handler(ctx)
      await vi.advanceTimersByTimeAsync(2500)

      const userMessageEvent = events.find(e => e.type === 'user_message')
      expect(userMessageEvent).toBeDefined()
      expect(userMessageEvent!.text).toBe('do X')
      expect(userMessageEvent!.replyContext).toBe('previous bot reply')
    })
  })

  describe('message splitting', () => {
    it('splits messages longer than 4096 chars', async () => {
      const longText = 'A'.repeat(5000)
      async function* mockStream(): AsyncGenerator<ResponseChunk> {
        yield { type: 'text', text: longText }
        yield { type: 'done' }
      }
      vi.mocked(agentCore.sendMessage).mockReturnValue(mockStream())

      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._handlers.get('message:text')!

      const ctx = createMockContext()
      await handler(ctx)
      await vi.advanceTimersByTimeAsync(2500)

      const botApi = (bot.getBot() as any).api
      expect(botApi.sendMessage.mock.calls.length).toBeGreaterThanOrEqual(2)

      // S1-D, D2: the status line of the turn is a message of its own.
      const replyCalls = botApi.sendMessage.mock.calls.filter((c: unknown[]) => !String(c[1]).startsWith('⏳ Arbeitet'))
      expect(replyCalls.length).toBeGreaterThanOrEqual(2)
      const allText = replyCalls.map((c: unknown[]) => c[1] as string).join('')
      expect(allText.length).toBe(5000)
    })

    it('S1-D D2: a turn draws a status line with tool names only (no args) and deletes it at the end', async () => {
      const SECRET_ARG = 'ARG-CANARY-should-never-reach-telegram'
      async function* mockStream(): AsyncGenerator<ResponseChunk> {
        await new Promise(r => setTimeout(r, 4000))
        yield { type: 'tool_call_start', toolName: 'read_file', toolArgs: { path: SECRET_ARG } } as ResponseChunk
        await new Promise(r => setTimeout(r, 4000))
        yield { type: 'tool_call_start', toolName: 'unregistered_tool', toolArgs: { q: SECRET_ARG } } as ResponseChunk
        await new Promise(r => setTimeout(r, 4000))
        yield { type: 'text', text: 'fertig' }
        yield { type: 'done' }
      }
      vi.mocked(agentCore.sendMessage).mockReturnValue(mockStream())
      ;(agentCore as unknown as { getRuntimeStateSnapshot: () => unknown }).getRuntimeStateSnapshot = () => ({ toolNames: ['read_file'] })

      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._handlers.get('message:text')!
      await handler(createMockContext())
      await vi.advanceTimersByTimeAsync(20000)

      const botApi = (bot.getBot() as any).api
      const sent = botApi.sendMessage.mock.calls.map((c: unknown[]) => String(c[1]))
      expect(sent).toContain('⏳ Arbeitet… 0 s')
      const edits = botApi.editMessageText.mock.calls.map((c: unknown[]) => String(c[2]))
      expect(edits.some((t: string) => t.includes('read_file'))).toBe(true)
      expect(edits.some((t: string) => t.includes('other_tool'))).toBe(true)
      expect(edits.some((t: string) => t.includes('unregistered_tool'))).toBe(false)
      const everything = JSON.stringify([botApi.sendMessage.mock.calls, botApi.editMessageText.mock.calls])
      expect(everything).not.toContain(SECRET_ARG)
      expect(botApi.deleteMessage).toHaveBeenCalledTimes(1)
      // The reply still arrives, after the line is gone.
      expect(sent.some((t: string) => t.includes('fertig'))).toBe(true)
    })
  })
})

describe('createTelegramBot', () => {
  let agentCore: AgentCore

  beforeEach(() => {
    agentCore = createMockAgentCore()
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('returns null when disabled', () => {
    vi.mocked(loadConfig).mockImplementation((filename: string) => {
      if (filename === 'settings.json') {
        return { batchingDelayMs: 2500 }
      }

      return {
        enabled: false,
        botToken: 'some-token',
        adminUserIds: [],
        pollingMode: true,
        webhookUrl: '',
        batchingDelayMs: 2500,
      }
    })

    const result = createTelegramBot(agentCore)
    expect(result).toBeNull()
  })

  it('returns null when no token', () => {
    vi.mocked(loadConfig).mockImplementation((filename: string) => {
      if (filename === 'settings.json') {
        return { batchingDelayMs: 2500 }
      }

      return {
        enabled: true,
        botToken: '',
        adminUserIds: [],
        pollingMode: true,
        webhookUrl: '',
        batchingDelayMs: 2500,
      }
    })

    const result = createTelegramBot(agentCore)
    expect(result).toBeNull()
  })

  it('returns TelegramBot instance when configured', () => {
    vi.mocked(loadConfig).mockImplementation((filename: string) => {
      if (filename === 'settings.json') {
        return { batchingDelayMs: 2500 }
      }

      return {
        enabled: true,
        botToken: 'valid-token',
        adminUserIds: [],
        pollingMode: true,
        webhookUrl: '',
        batchingDelayMs: 2500,
      }
    })

    const result = createTelegramBot(agentCore)
    expect(result).toBeInstanceOf(TelegramBot)
  })

  it('returns null when config load fails', () => {
    vi.mocked(loadConfig).mockImplementation(() => {
      throw new Error('file not found')
    })

    const result = createTelegramBot(agentCore)
    expect(result).toBeNull()
  })
})

describe('email approval channel', () => {
  let agentCore: AgentCore

  const config: TelegramConfig = {
    enabled: true,
    botToken: 'test-token-123',
    adminUserIds: [],
    pollingMode: true,
    webhookUrl: '',
    batchingDelayMs: 2500,
  }

  function makeEntry(overrides: Partial<EmailSendLogEntry> = {}): EmailSendLogEntry {
    return {
      id: 'entry-1',
      accountId: 'acc-1',
      accountName: 'Work',
      status: 'pending',
      to: ['stranger@partner.org'],
      cc: [],
      bcc: [],
      subject: 'Quarterly numbers',
      bodyText: 'All good.',
      bodyHtml: null,
      attachments: [{ filename: 'report.pdf', size: 2048 }],
      inReplyTo: null,
      references: [],
      reason: 'Recipient outside the allowlist',
      errorMessage: null,
      messageId: null,
      sessionId: null,
      decidedBy: null,
      decidedAt: null,
      sentAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    }
  }

  function makeDb(approvedChatIds: string[] = ['12345']): Database {
    return {
      prepare: (sql: string) => ({
        run: () => ({ changes: 1, lastInsertRowid: 1 }),
        get: () => (sql.includes('telegram_users')
          ? {
              id: 1,
              telegram_id: '12345',
              telegram_username: 'johndoe',
              telegram_display_name: 'John Doe',
              status: 'approved',
              user_id: 42,
              created_at: 'now',
              updated_at: 'now',
            }
          : undefined),
        all: () => approvedChatIds.map(telegram_id => ({ telegram_id })),
      }),
    } as unknown as Database
  }

  beforeEach(() => {
    agentCore = createMockAgentCore()
    vi.clearAllMocks()
  })

  it('sends an approval prompt with Accept/Cancel buttons to approved chats', async () => {
    const bot = new TelegramBot({ agentCore, db: makeDb(), config })
    const api = (bot.getBot() as any).api

    await bot.createEmailApprovalNotifier().approvalRequested!(makeEntry())

    expect(api.sendMessage).toHaveBeenCalledTimes(1)
    const [chatId, text, opts] = api.sendMessage.mock.calls[0]
    expect(chatId).toBe('12345')
    expect(text).toContain('stranger@partner.org')
    expect(text).toContain('Quarterly numbers')
    expect(text).toContain('report.pdf')
    expect(text).toContain('2.0 KB')
    const buttons = opts.reply_markup.inline_keyboard[0]
    expect(buttons.map((b: any) => b.callback_data)).toEqual(['mail:a:entry-1', 'mail:r:entry-1'])
  })

  it('does not send anything when no approved Telegram chat exists', async () => {
    const bot = new TelegramBot({ agentCore, db: makeDb([]), config })
    const api = (bot.getBot() as any).api

    await bot.createEmailApprovalNotifier().approvalRequested!(makeEntry())

    expect(api.sendMessage).not.toHaveBeenCalled()
  })

  it('accept callback approves via the core boundary and edits the prompt', async () => {
    const sentEntry = makeEntry({ status: 'sent', decidedBy: 'John Doe' })
    const approval = {
      approve: vi.fn().mockResolvedValue({ ok: true, entry: sentEntry }),
      reject: vi.fn(),
      retry: vi.fn(),
    }
    const bot = new TelegramBot({ agentCore, db: makeDb(), config, emailApproval: approval as any })
    const underlying = bot.getBot() as unknown as MockBotInternals & { api: any }

    await bot.createEmailApprovalNotifier().approvalRequested!(makeEntry())

    const ctx = createMockContext({
      callbackQuery: { data: 'mail:a:entry-1', message: { message_id: 1 } },
      answerCallbackQuery: vi.fn().mockResolvedValue(true),
    })
    await underlying._handlers.get('callback_query:data')!(ctx as any)

    expect(approval.approve).toHaveBeenCalledWith('entry-1', { name: 'John Doe' })
    expect((ctx as any).answerCallbackQuery).toHaveBeenCalledWith({ text: 'Email approved.' })

    const [chatId, messageId, editedText] = underlying.api.editMessageText.mock.calls[0]
    expect(chatId).toBe('12345')
    expect(messageId).toBe(1)
    expect(editedText).toContain('John Doe')
    expect(editedText).toContain('sent')
  })

  it('cancel callback rejects via the core boundary', async () => {
    const rejected = makeEntry({ status: 'rejected', decidedBy: 'John Doe' })
    const approval = {
      approve: vi.fn(),
      reject: vi.fn().mockResolvedValue({ ok: true, entry: rejected }),
      retry: vi.fn(),
    }
    const bot = new TelegramBot({ agentCore, db: makeDb(), config, emailApproval: approval as any })
    const underlying = bot.getBot() as unknown as MockBotInternals & { api: any }

    await bot.createEmailApprovalNotifier().approvalRequested!(makeEntry())

    const ctx = createMockContext({
      callbackQuery: { data: 'mail:r:entry-1', message: { message_id: 1 } },
      answerCallbackQuery: vi.fn().mockResolvedValue(true),
    })
    await underlying._handlers.get('callback_query:data')!(ctx as any)

    expect(approval.reject).toHaveBeenCalledWith('entry-1', { name: 'John Doe' })
    expect(underlying.api.editMessageText.mock.calls[0][2]).toContain('rejected')
  })

  it('a second decision gets the "already decided" alert', async () => {
    const decided = makeEntry({ status: 'approved', decidedBy: 'alice' })
    const approval = {
      approve: vi.fn().mockResolvedValue({
        ok: false,
        code: 'already_decided',
        message: 'This email was already decided by alice (status: approved).',
        entry: decided,
      }),
      reject: vi.fn(),
      retry: vi.fn(),
    }
    const bot = new TelegramBot({ agentCore, db: makeDb(), config, emailApproval: approval as any })
    const underlying = bot.getBot() as unknown as MockBotInternals & { api: any }

    await bot.createEmailApprovalNotifier().approvalRequested!(makeEntry())

    const ctx = createMockContext({
      callbackQuery: { data: 'mail:a:entry-1', message: { message_id: 1 } },
      answerCallbackQuery: vi.fn().mockResolvedValue(true),
    })
    await underlying._handlers.get('callback_query:data')!(ctx as any)

    expect((ctx as any).answerCallbackQuery).toHaveBeenCalledWith({
      text: expect.stringContaining('already decided'),
      show_alert: true,
    })
    expect(underlying.api.editMessageText).toHaveBeenCalledTimes(1)
  })

  it('invalidates the prompt when another channel decides', async () => {
    const bot = new TelegramBot({ agentCore, db: makeDb(), config })
    const underlying = bot.getBot() as unknown as MockBotInternals & { api: any }
    const notifier = bot.createEmailApprovalNotifier()

    await notifier.approvalRequested!(makeEntry())
    await notifier.approvalResolved!(makeEntry({ status: 'approved', decidedBy: 'web-admin' }))

    const [chatId, messageId, text, opts] = underlying.api.editMessageText.mock.calls[0]
    expect(chatId).toBe('12345')
    expect(messageId).toBe(1)
    expect(text).toContain('web-admin')
    expect(opts.reply_markup).toBeUndefined()

    // Prompt is consumed — a later resolve does not edit again.
    await notifier.approvalResolved!(makeEntry({ status: 'sent', decidedBy: 'web-admin' }))
    expect(underlying.api.editMessageText).toHaveBeenCalledTimes(1)

    // And a late button tap can no longer act on it.
    const ctx = createMockContext({
      callbackQuery: { data: 'mail:a:entry-1', message: { message_id: 1 } },
      answerCallbackQuery: vi.fn().mockResolvedValue(true),
    })
    await underlying._handlers.get('callback_query:data')!(ctx as any)
    expect((ctx as any).answerCallbackQuery).toHaveBeenCalled()
  })
})

describe('turn retry channel', () => {
  const SESSION_ID = 'session-telegram-retry'
  const USER_ID = 42
  const CHAT_ID = 67890

  const config: TelegramConfig = {
    enabled: true,
    botToken: 'test-token-123',
    adminUserIds: [],
    pollingMode: true,
    webhookUrl: '',
    batchingDelayMs: 2500,
  }

  let db: Database
  let agentCore: AgentCore

  /** Agent core whose session id is stable so DB fixtures can reference it. */
  function retryAgentCore(): AgentCore {
    const core = createMockAgentCore()
    vi.mocked(core.getSessionManager).mockReturnValue({
      getOrCreateSession: () => ({ id: SESSION_ID }),
    } as any)
    return core
  }

  function seedDb(): Database {
    const seeded = initDatabase(':memory:')
    seeded.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
      .run(USER_ID, 'tester', 'x')
    seeded.prepare(
      "INSERT INTO telegram_users (telegram_id, telegram_username, telegram_display_name, status, user_id) VALUES (?, ?, ?, 'approved', ?)",
    ).run('12345', 'johndoe', 'John Doe', USER_ID)
    seeded.prepare("INSERT INTO sessions (id, user_id, source, type) VALUES (?, ?, 'telegram', 'interactive')")
      .run(SESSION_ID, USER_ID)
    return seeded
  }

  function errorRowId(): number {
    const row = db.prepare(
      "SELECT id FROM chat_messages WHERE session_id = ? AND role = 'system' ORDER BY id DESC LIMIT 1",
    ).get(SESSION_ID) as { id: number } | undefined
    return row!.id
  }

  function makeBot(): { bot: TelegramBot; api: any; handlers: MockBotInternals } {
    const bot = new TelegramBot({ agentCore, db, config })
    const underlying = bot.getBot() as unknown as MockBotInternals & { api: any }
    return { bot, api: underlying.api, handlers: underlying }
  }

  async function sendUserMessage(handlers: MockBotInternals, text = 'Hello agent'): Promise<void> {
    await handlers._handlers.get('message:text')!(createMockContext({ message: { text, message_id: 1 } }) as any)
    await vi.advanceTimersByTimeAsync(2500)
  }

  function retryButton(api: any): { text: string; callback_data: string } | undefined {
    const call = api.sendMessage.mock.calls.find(
      (c: any[]) => c[2]?.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith('retry:'),
    )
    return call?.[2].reply_markup.inline_keyboard[0][0]
  }

  beforeEach(() => {
    db = seedDb()
    agentCore = retryAgentCore()
    // Bots from earlier tests are never stopped, so their (process-global)
    // retry notifiers would still answer for row ids the fresh in-memory
    // database reuses.
    clearTurnRetryNotifiers()
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.mocked(loadConfig).mockImplementation((filename: string) => {
      if (filename === 'settings.json') return { batchingDelayMs: 2500 }
      return { ...config }
    })
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('delivers a terminal error with a Retry button bound to the persisted error row', async () => {
    vi.mocked(agentCore.sendMessage).mockReturnValue(errorStream('invalid_api_key'))
    const { api, handlers } = makeBot()

    await sendUserMessage(handlers)

    const button = retryButton(api)
    expect(button).toBeDefined()
    expect(button!.callback_data).toBe(`retry:${errorRowId()}`)
    const errorText = api.sendMessage.mock.calls.find((c: any[]) => c[2]?.reply_markup)![1] as string
    expect(errorText).toContain('invalid_api_key')
  })

  it('re-runs the failed turn on tap and delivers the answer to the Telegram chat', async () => {
    vi.mocked(agentCore.sendMessage)
      .mockReturnValueOnce(errorStream('invalid_api_key'))
      .mockReturnValueOnce(textStream('Recovered answer'))
    const { api, handlers } = makeBot()

    await sendUserMessage(handlers)
    const callbackData = retryButton(api)!.callback_data

    const ctx = createMockContext({
      callbackQuery: { data: callbackData, message: { message_id: 5 } },
      answerCallbackQuery: vi.fn().mockResolvedValue(true),
    })
    await handlers._handlers.get('callback_query:data')!(ctx as any)
    await vi.advanceTimersByTimeAsync(0)

    expect((ctx as any).answerCallbackQuery).toHaveBeenCalledWith({ text: expect.stringContaining('Retrying') })
    expect(agentCore.sendMessage).toHaveBeenCalledTimes(2)
    expect(api.sendMessage).toHaveBeenCalledWith(CHAT_ID, 'Recovered answer', { parse_mode: 'HTML' })
    // The retry continues the transcript — the user message is not re-sent.
    const userRows = db.prepare("SELECT COUNT(*) AS count FROM chat_messages WHERE session_id = ? AND role = 'user'")
      .get(SESSION_ID) as { count: number }
    expect(userRows.count).toBe(1)
  })

  it('refuses a stale retry once the conversation moved on', async () => {
    vi.mocked(agentCore.sendMessage).mockReturnValue(errorStream('invalid_api_key'))
    const { api, handlers } = makeBot()

    await sendUserMessage(handlers)
    const callbackData = retryButton(api)!.callback_data

    db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content) VALUES (?, ?, 'user', ?)")
      .run(SESSION_ID, USER_ID, 'never mind')

    const ctx = createMockContext({
      callbackQuery: { data: callbackData, message: { message_id: 5 } },
      answerCallbackQuery: vi.fn().mockResolvedValue(true),
    })
    await handlers._handlers.get('callback_query:data')!(ctx as any)

    expect((ctx as any).answerCallbackQuery).toHaveBeenCalledWith({
      text: expect.stringContaining('no longer available'),
      show_alert: true,
    })
    expect(agentCore.sendMessage).toHaveBeenCalledTimes(1)
  })

  it('refuses a retry when the session has ended', async () => {
    vi.mocked(agentCore.sendMessage).mockReturnValue(errorStream('invalid_api_key'))
    const { api, handlers } = makeBot()

    await sendUserMessage(handlers)
    const callbackData = retryButton(api)!.callback_data
    db.prepare("UPDATE sessions SET ended_at = datetime('now') WHERE id = ?").run(SESSION_ID)

    const ctx = createMockContext({
      callbackQuery: { data: callbackData, message: { message_id: 5 } },
      answerCallbackQuery: vi.fn().mockResolvedValue(true),
    })
    await handlers._handlers.get('callback_query:data')!(ctx as any)

    expect((ctx as any).answerCallbackQuery).toHaveBeenCalledWith({
      text: expect.stringContaining('the session has ended'),
      show_alert: true,
    })
    expect(agentCore.sendMessage).toHaveBeenCalledTimes(1)
  })

  it('drops the keyboard when the retry was answered in another channel', async () => {
    vi.mocked(agentCore.sendMessage).mockReturnValue(errorStream('invalid_api_key'))
    const { api, handlers } = makeBot()

    await sendUserMessage(handlers)
    const messageId = errorRowId()

    await notifyTurnRetryResolved({ errorMessageId: messageId, ok: true, resolution: '🔄 Retrying…' })

    const [chatId, editedMessageId, text, opts] = api.editMessageText.mock.calls[0]
    expect(chatId).toBe(String(CHAT_ID))
    expect(editedMessageId).toBe(1)
    expect(text).toContain('Retrying')
    expect(opts.reply_markup).toBeUndefined()

    // The prompt is consumed — a later tap can no longer edit it again.
    await notifyTurnRetryResolved({ errorMessageId: messageId, ok: false, resolution: 'nope' })
    expect(api.editMessageText).toHaveBeenCalledTimes(1)
  })

  // A turn that dies before it reaches the agent emits no `turn_start`. The
  // chat subscription must still close on `turn_end`, or it would stay attached
  // and deliver the user's next answer a second time.
  it('does not leak its subscription when the retried turn never reaches the agent', async () => {
    let agent: AgentCore | null = agentCore
    const runner = new TurnRunner({ db, getAgent: () => agent })
    const bot = new TelegramBot({ agentCore, db, config, turnRunner: runner })
    const handlers = bot.getBot() as unknown as MockBotInternals & { api: any }
    const api = handlers.api

    vi.mocked(agentCore.sendMessage).mockReturnValue(errorStream('invalid_api_key'))
    await sendUserMessage(handlers)
    const callbackData = retryButton(api)!.callback_data

    agent = null
    const ctx = createMockContext({
      callbackQuery: { data: callbackData, message: { message_id: 5 } },
      answerCallbackQuery: vi.fn().mockResolvedValue(true),
    })
    await handlers._handlers.get('callback_query:data')!(ctx as any)
    await vi.advanceTimersByTimeAsync(0)

    agent = agentCore
    vi.mocked(agentCore.sendMessage).mockReturnValue(textStream('Fresh answer'))
    api.sendMessage.mockClear()
    await sendUserMessage(handlers, 'and now?')

    const answers = api.sendMessage.mock.calls.filter((c: any[]) => c[1] === 'Fresh answer')
    expect(answers).toHaveLength(1)
  })

  it('ignores an unknown retry callback payload', async () => {
    const { handlers } = makeBot()

    const ctx = createMockContext({
      callbackQuery: { data: 'retry:not-a-number', message: { message_id: 5 } },
      answerCallbackQuery: vi.fn().mockResolvedValue(true),
    })
    await handlers._handlers.get('callback_query:data')!(ctx as any)

    expect((ctx as any).answerCallbackQuery).toHaveBeenCalledWith({ text: 'Unknown action.', show_alert: true })
  })

  describe('stall warnings', () => {
    function useStallWarnings(enabled: boolean): void {
      vi.mocked(loadConfig).mockImplementation((filename: string) => {
        if (filename === 'settings.json') return { batchingDelayMs: 2500 }
        return { ...config, sendStallWarnings: enabled }
      })
    }

    it('sends nothing at the warn threshold while the setting is off (default)', async () => {
      useStallWarnings(false)
      vi.mocked(agentCore.sendMessage).mockReturnValue(stallThenAnswerStream())
      const { api, handlers } = makeBot()

      await sendUserMessage(handlers)

      const texts = api.sendMessage.mock.calls.map((c: any[]) => c[1] as string)
      expect(texts.some((t: string) => t.includes('has not responded'))).toBe(false)
      expect(texts).toContain('Late answer')
    })

    it('delivers the stall notice once the setting is enabled', async () => {
      useStallWarnings(true)
      vi.mocked(agentCore.sendMessage).mockReturnValue(stallThenAnswerStream())
      const { api, handlers } = makeBot()

      await sendUserMessage(handlers)

      const texts = api.sendMessage.mock.calls.map((c: any[]) => c[1] as string)
      expect(texts.some((t: string) => t.includes('has not responded'))).toBe(true)
      expect(texts).toContain('Late answer')
    })

    it('delivers the terminal error and its Retry button even with stall warnings off', async () => {
      useStallWarnings(false)
      vi.mocked(agentCore.sendMessage).mockReturnValue(stallThenErrorStream())
      const { api, handlers } = makeBot()

      await sendUserMessage(handlers)

      const texts = api.sendMessage.mock.calls.map((c: any[]) => c[1] as string)
      expect(texts.some((t: string) => t.includes('has not responded'))).toBe(false)
      expect(retryButton(api)).toBeDefined()
    })
  })
})

describe('S1-C interaction cards (bot wiring)', () => {
  const SESSION_ID = 'session-telegram-cards'
  const USER_ID = 42
  const CHAT_ID = 67890
  const config: TelegramConfig = {
    enabled: true, botToken: 'test-token-123', adminUserIds: [], pollingMode: true, webhookUrl: '', batchingDelayMs: 2500,
  }
  let db: Database
  let agentCore: AgentCore
  let portCalls: Array<{ kind: string; actor: unknown; id: string; input?: any }>
  let unregisterPort: () => void

  function seedDb(): Database {
    const seeded = initDatabase(':memory:')
    seeded.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(USER_ID, 'tester', 'x')
    seeded.prepare(
      "INSERT INTO telegram_users (telegram_id, telegram_username, telegram_display_name, status, user_id) VALUES (?, ?, ?, 'approved', ?)",
    ).run('12345', 'johndoe', 'John Doe', USER_ID)
    seeded.prepare("INSERT INTO sessions (id, user_id, source, type) VALUES (?, ?, 'telegram', 'interactive')").run(SESSION_ID, USER_ID)
    return seeded
  }

  /** Stand-in for the interactions service: transitions the row, runs the surface's turn starter. */
  function fakePort(core: typeof import('@axiom/core')) {
    return {
      answerById: (actor: unknown, id: string, input: any) => {
        portCalls.push({ kind: 'answer', actor, id, input })
        const interaction = core.transitionInteraction(db, id, 'answered', {
          closeSource: 'answer', closedSurface: input.surface,
          answer: { value: input.value ?? 'x', label: 'Variante A', answeredAt: new Date().toISOString(), clientRequestId: input.clientRequestId, resumed: true },
        })
        input.startTurn?.({
          userId: USER_ID, sessionId: SESSION_ID, text: 'Antwort: Variante A', source: 'telegram', agentId: 'main',
          explicitSessionId: SESSION_ID, inputMode: 'answer', replyToInteractionId: id,
        })
        return { resumed: true, label: 'Variante A', interaction }
      },
      dismiss: (actor: unknown, id: string, surface: string) => {
        portCalls.push({ kind: 'dismiss', actor, id })
        return { interaction: core.transitionInteraction(db, id, 'dismissed', { closeSource: 'dismiss', closedSurface: surface as any }), idempotent: false }
      },
      saveDraft: (actor: unknown, id: string) => {
        portCalls.push({ kind: 'draft', actor, id })
        return core.getInteraction(db, id)!
      },
    }
  }

  async function openAskUser(core: typeof import('@axiom/core'), questions: unknown[]) {
    const parsed = core.parseAskUserArgs({ blocking: true, questions }, { id: `call_${Math.random()}` })
    if (!parsed.ok) throw new Error(parsed.error)
    const messageId = Number(db.prepare(
      "INSERT INTO chat_messages (session_id, user_id, role, content) VALUES (?, ?, 'user', 'frag')",
    ).run(SESSION_ID, USER_ID).lastInsertRowid)
    const { record } = core.createInteraction(db, {
      strandId: SESSION_ID, userId: USER_ID, messageId, agent: 'main', payload: parsed.value,
      toolCallId: `call_${messageId}`, blockId: null, blocking: true,
    })
    await vi.advanceTimersByTimeAsync(0)
    return record
  }

  function cardMarkup(api: any): { text: string; callback_data: string }[] {
    const call = api.sendMessage.mock.calls.find((c: any[]) => c[2]?.reply_markup?.inline_keyboard?.flat?.().some((b: any) => b.callback_data?.startsWith('ia:')))
    return call ? call[2].reply_markup.inline_keyboard.flat() : []
  }

  async function makeBotWithTurn(): Promise<{ bot: TelegramBot; api: any; handlers: MockBotInternals }> {
    const bot = new TelegramBot({ agentCore, db, config })
    const underlying = bot.getBot() as unknown as MockBotInternals & { api: any }
    await bot.start()
    // A first turn tells the bot which chat serves the strand.
    await underlying._handlers.get('message:text')!(createMockContext({ message: { text: 'Hallo', message_id: 1 } }) as any)
    await vi.advanceTimersByTimeAsync(2500)
    return { bot, api: underlying.api, handlers: underlying }
  }

  beforeEach(async () => {
    db = seedDb()
    agentCore = createMockAgentCore()
    vi.mocked(agentCore.getSessionManager).mockReturnValue({ getOrCreateSession: () => ({ id: SESSION_ID }) } as any)
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.mocked(loadConfig).mockImplementation((filename: string) => {
      if (filename === 'settings.json') return { batchingDelayMs: 2500 }
      return { ...config }
    })
    portCalls = []
    const core = await vi.importActual<typeof import('@axiom/core')>('@axiom/core')
    unregisterPort = core.registerInteractionAnswerPort(fakePort(core) as any)
  })

  afterEach(() => {
    unregisterPort()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('tap on a card answers via the port, the answer turn replies in the chat, the keyboard is removed', async () => {
    const core = await vi.importActual<typeof import('@axiom/core')>('@axiom/core')
    vi.mocked(agentCore.sendMessage).mockImplementation(() => textStream('Gemacht.'))
    const { bot, api, handlers } = await makeBotWithTurn()
    const record = await openAskUser(core, [
      { id: 'q1', type: 'choice', question: 'Welche Variante?', options: [{ id: 'a', label: 'Variante A' }, { id: 'b', label: 'Variante B' }] },
    ])
    const buttons = cardMarkup(api)
    expect(buttons.map(b => b.text)).toEqual(['Variante A', 'Variante B', '✖️ Verwerfen'])
    vi.mocked(agentCore.sendMessage).mockClear()
    api.sendMessage.mockClear()

    const ctx = createMockContext({
      callbackQuery: { id: 'cbq-77', data: buttons[0]!.callback_data, message: { message_id: 1, chat: { id: CHAT_ID } } },
      answerCallbackQuery: vi.fn().mockResolvedValue(true),
    })
    await handlers._handlers.get('callback_query:data')!(ctx as any)
    await vi.advanceTimersByTimeAsync(0)

    expect(portCalls).toHaveLength(1)
    expect(portCalls[0]).toMatchObject({ kind: 'answer', actor: USER_ID, id: record.id })
    expect(portCalls[0]!.input).toMatchObject({ surface: 'telegram', clientRequestId: 'tg:cbq-77', answers: { q1: { selected: ['a'] } } })
    expect(agentCore.sendMessage).toHaveBeenCalledTimes(1)
    expect(api.sendMessage.mock.calls.some((c: any[]) => c[0] === CHAT_ID && String(c[1]).includes('Gemacht.'))).toBe(true)
    const lastEdit = api.editMessageText.mock.calls.at(-1)
    expect(lastEdit[2]).toContain('✅ Beantwortet')
    expect(lastEdit[3].reply_markup.inline_keyboard).toEqual([])
    await bot.stop()
  })

  it('text after "Kommentar hinzufügen" is the comment, not a turn; after the window it is a normal message', async () => {
    const core = await vi.importActual<typeof import('@axiom/core')>('@axiom/core')
    vi.mocked(agentCore.sendMessage).mockImplementation(() => textStream('ok'))
    const { bot, api, handlers } = await makeBotWithTurn()
    await openAskUser(core, [
      { id: 'q1', type: 'choice', question: 'Token?', allowComment: true, options: [{ id: 'a', label: 'alt' }, { id: 'b', label: 'neu' }] },
    ])
    const comment = cardMarkup(api).find(b => b.text.includes('Kommentar'))!
    await handlers._handlers.get('callback_query:data')!(createMockContext({
      callbackQuery: { id: 'cbq-1', data: comment.callback_data, message: { message_id: 1, chat: { id: CHAT_ID } } },
      answerCallbackQuery: vi.fn().mockResolvedValue(true),
    }) as any)
    vi.mocked(agentCore.sendMessage).mockClear()

    await handlers._handlers.get('message:text')!(createMockContext({ message: { text: 'bitte rotieren', message_id: 3 } }) as any)
    await vi.advanceTimersByTimeAsync(2500)
    expect(agentCore.sendMessage).not.toHaveBeenCalled()
    expect(api.editMessageText.mock.calls.at(-1)[2]).toContain('💬 bitte rotieren')

    await handlers._handlers.get('callback_query:data')!(createMockContext({
      callbackQuery: { id: 'cbq-2', data: comment.callback_data, message: { message_id: 1, chat: { id: CHAT_ID } } },
      answerCallbackQuery: vi.fn().mockResolvedValue(true),
    }) as any)
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1000)
    await handlers._handlers.get('message:text')!(createMockContext({ message: { text: 'eine normale Nachricht', message_id: 4 } }) as any)
    await vi.advanceTimersByTimeAsync(2500)
    expect(agentCore.sendMessage).toHaveBeenCalledTimes(1)
    await bot.stop()
  })

  it('a tap from a Telegram account that is not the linked owner has no effect', async () => {
    const core = await vi.importActual<typeof import('@axiom/core')>('@axiom/core')
    vi.mocked(agentCore.sendMessage).mockImplementation(() => textStream('ok'))
    const { bot, api, handlers } = await makeBotWithTurn()
    const record = await openAskUser(core, [
      { id: 'q1', type: 'choice', question: 'Welche?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
    ])
    const answerCallbackQuery = vi.fn().mockResolvedValue(true)
    await handlers._handlers.get('callback_query:data')!(createMockContext({
      from: { id: 55555, is_bot: false, first_name: 'Eve' },
      callbackQuery: { id: 'cbq-x', data: cardMarkup(api)[0]!.callback_data, message: { message_id: 1, chat: { id: CHAT_ID } } },
      answerCallbackQuery,
    }) as any)
    expect(portCalls).toHaveLength(0)
    expect(core.getInteraction(db, record.id)!.status).toBe('open')
    expect(answerCallbackQuery).toHaveBeenCalledWith({ text: 'Diese Frage gehört jemand anderem.' })
    await bot.stop()
  })

  // ---- Review 1 Nachzug ---------------------------------------------------

  const CANARY = ['ghp', '_', 'C4n4ry', 'Fake', 'Token', '0000', 'abcdefghij', 'klmnopqr'].join('')

  async function tap(handlers: MockBotInternals, data: string, opts: { chatId?: number; messageId?: number; fromId?: number; id?: string } = {}) {
    const answerCallbackQuery = vi.fn().mockResolvedValue(true)
    await handlers._handlers.get('callback_query:data')!(createMockContext({
      ...(opts.fromId !== undefined ? { from: { id: opts.fromId, is_bot: false, first_name: 'Eve' } } : {}),
      callbackQuery: { id: opts.id ?? `cbq-${Math.random()}`, data, message: { message_id: opts.messageId ?? 1, chat: { id: opts.chatId ?? CHAT_ID } } },
      answerCallbackQuery,
    }) as any)
    await vi.advanceTimersByTimeAsync(0)
    return answerCallbackQuery
  }

  function telegramOutput(api: any): string {
    return JSON.stringify([...api.sendMessage.mock.calls, ...api.editMessageText.mock.calls])
  }

  it('review1 sealing: a canary in question, option label, comment and answer label never reaches sendMessage/editMessageText', async () => {
    const core = await vi.importActual<typeof import('@axiom/core')>('@axiom/core')
    unregisterPort()
    const base = fakePort(core)
    unregisterPort = core.registerInteractionAnswerPort({
      ...base,
      answerById: (actor: unknown, id: string, input: any) => {
        portCalls.push({ kind: 'answer', actor, id, input })
        const interaction = core.transitionInteraction(db, id, 'answered', {
          closeSource: 'answer', closedSurface: 'telegram',
          answer: { value: 'a', label: `nimm ${CANARY}`, answeredAt: new Date().toISOString(), clientRequestId: input.clientRequestId, resumed: true },
        })
        return { resumed: true, label: 'x', interaction }
      },
    } as any)
    vi.mocked(agentCore.sendMessage).mockImplementation(() => textStream('ok'))
    const { bot, api, handlers } = await makeBotWithTurn()
    await openAskUser(core, [
      { id: 'q1', type: 'choice', question: `Ist ${CANARY} noch gültig?`, allowComment: true, options: [{ id: 'a', label: `rotiere ${CANARY}` }, { id: 'b', label: 'nein' }] },
    ])
    const buttons = cardMarkup(api)
    expect(buttons.length).toBeGreaterThan(0)
    await tap(handlers, buttons.find(b => b.text.includes('Kommentar'))!.callback_data)
    await handlers._handlers.get('message:text')!(createMockContext({ message: { text: `siehe ${CANARY}`, message_id: 3 } }) as any)
    await vi.advanceTimersByTimeAsync(0)
    await tap(handlers, buttons[0]!.callback_data)
    expect(portCalls.filter(c => c.kind === 'answer')).toHaveLength(1)
    expect(api.editMessageText.mock.calls.some((c: any[]) => String(c[2]).includes('✅ Beantwortet'))).toBe(true)
    expect(telegramOutput(api)).not.toContain(CANARY)
    await bot.stop()
  })

  it('review1 origin: the owner tapping a real card id from a foreign chat (or foreign message) has no effect', async () => {
    const core = await vi.importActual<typeof import('@axiom/core')>('@axiom/core')
    vi.mocked(agentCore.sendMessage).mockImplementation(() => textStream('ok'))
    const { bot, api, handlers } = await makeBotWithTurn()
    const record = await openAskUser(core, [
      { id: 'q1', type: 'choice', question: 'Welche?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
    ])
    const data = cardMarkup(api)[0]!.callback_data
    api.editMessageText.mockClear()
    const foreignChat = await tap(handlers, data, { chatId: 99999 })
    const foreignMessage = await tap(handlers, data, { messageId: 777 })
    const unknownCard = await tap(handlers, `ia:o:${core.newInteractionId()}:0:0`)
    expect(foreignChat).toHaveBeenCalledWith({ text: 'Diese Karte ist hier nicht gültig.' })
    expect(foreignMessage).toHaveBeenCalledWith({ text: 'Diese Karte ist hier nicht gültig.' })
    expect(unknownCard).toHaveBeenCalledWith({ text: 'Diese Karte ist hier nicht gültig.' })
    expect(portCalls).toHaveLength(0)
    expect(api.editMessageText).not.toHaveBeenCalled()
    expect(core.getInteraction(db, record.id)!.status).toBe('open')
    // The origin chat still works afterwards (no foreign chat was cached).
    await tap(handlers, data)
    expect(portCalls).toHaveLength(1)
    await bot.stop()
  })

  it('review1 owner before edit: an unlinked user tapping a closed card causes no editMessageText', async () => {
    const core = await vi.importActual<typeof import('@axiom/core')>('@axiom/core')
    vi.mocked(agentCore.sendMessage).mockImplementation(() => textStream('ok'))
    const { bot, api, handlers } = await makeBotWithTurn()
    const record = await openAskUser(core, [
      { id: 'q1', type: 'choice', question: 'Welche?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
    ])
    const data = cardMarkup(api)[0]!.callback_data
    await bot.stop()
    core.transitionInteraction(db, record.id, 'dismissed', { closeSource: 'dismiss', closedSurface: 'web' })
    // Restarted bot: the card is only known from telegram_interaction_cards.
    const second = await makeBotWithTurn()
    second.api.editMessageText.mockClear()
    const answered = await tap(second.handlers, data, { fromId: 55555 })
    expect(answered).toHaveBeenCalledWith({ text: 'Diese Frage gehört jemand anderem.' })
    expect(second.api.editMessageText).not.toHaveBeenCalled()
    expect(portCalls).toHaveLength(0)
    await second.bot.stop()
  })

  it('review1 restart: after a restart the persisted card still accepts the owner tap in its own chat', async () => {
    const core = await vi.importActual<typeof import('@axiom/core')>('@axiom/core')
    vi.mocked(agentCore.sendMessage).mockImplementation(() => textStream('ok'))
    const first = await makeBotWithTurn()
    const record = await openAskUser(core, [
      { id: 'q1', type: 'choice', question: 'Welche?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
    ])
    const data = cardMarkup(first.api)[1]!.callback_data
    await first.bot.stop()
    // No new user message here: it would supersede the open card.
    const secondBot = new TelegramBot({ agentCore, db, config })
    const second = { bot: secondBot, handlers: secondBot.getBot() as unknown as MockBotInternals }
    await secondBot.start()
    const answered = await tap(second.handlers, data)
    expect(answered).toHaveBeenCalledWith({ text: 'Gespeichert.' })
    expect(portCalls).toHaveLength(1)
    expect(portCalls[0]!.input.answers).toEqual({ q1: { selected: ['b'] } })
    expect(core.getInteraction(db, record.id)!.status).toBe('answered')
    await second.bot.stop()
  })

  it('review1 turn confirmation: a turn that does not start leaves resumed=false and offers a retry with the same clientRequestId', async () => {
    const core = await vi.importActual<typeof import('@axiom/core')>('@axiom/core')
    unregisterPort()
    // Mirrors the service contract: answer filed, starter throws => 502 turn_failed, resumed stays false.
    unregisterPort = core.registerInteractionAnswerPort({
      ...fakePort(core),
      answerById: (actor: unknown, id: string, input: any) => {
        portCalls.push({ kind: 'answer', actor, id, input })
        let rec = core.getInteraction(db, id)!
        if (rec.status === 'open') {
          rec = core.transitionInteraction(db, id, 'answered', {
            closeSource: 'answer', closedSurface: 'telegram',
            answer: { value: 'a', label: 'A', answeredAt: new Date().toISOString(), clientRequestId: input.clientRequestId, resumed: false },
          })
        }
        try {
          input.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'Antwort: A', source: 'telegram', agentId: 'main', explicitSessionId: SESSION_ID, inputMode: 'answer', replyToInteractionId: id })
        } catch {
          throw Object.assign(new Error('turn'), { status: 502, code: 'turn_failed' })
        }
        rec = core.markInteractionResumed(db, id, true)
        return { resumed: true, label: 'A', interaction: rec }
      },
    } as any)
    vi.mocked(agentCore.sendMessage).mockImplementation(() => textStream('Weiter.'))
    const { bot, api, handlers } = await makeBotWithTurn()
    const record = await openAskUser(core, [
      { id: 'q1', type: 'choice', question: 'Welche?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
    ])
    const runner = (bot as any).turnRunner
    const startSpy = vi.spyOn(runner, 'startTurn').mockImplementationOnce(() => { throw new Error('runner busy') })
    const first = await tap(handlers, cardMarkup(api)[0]!.callback_data, { id: 'cbq-turn' })
    expect(first).toHaveBeenCalledWith({ text: 'Antwort gespeichert, Agent nicht gestartet – erneut tippen.' })
    expect(core.getInteraction(db, record.id)!.answer!.resumed).toBe(false)
    const retryEdit = api.editMessageText.mock.calls.at(-1)
    expect(retryEdit[2]).toContain('Antwort gespeichert, Agent nicht gestartet')
    const retryButtons = retryEdit[3].reply_markup.inline_keyboard.flat()
    expect(retryButtons).toHaveLength(1)
    expect(retryButtons[0].callback_data).toMatch(/^ia:r:/)

    vi.mocked(agentCore.sendMessage).mockClear()
    await tap(handlers, retryButtons[0].callback_data)
    await vi.advanceTimersByTimeAsync(0)
    const answers = portCalls.filter(c => c.kind === 'answer')
    expect(answers).toHaveLength(2)
    expect(answers[1]!.input.clientRequestId).toBe('tg:cbq-turn')
    // Review 2: the retry is a resume retry — key from the row, no value.
    expect(answers[1]!.input.answers).toBeUndefined()
    expect(answers[1]!.input.value).toBeUndefined()
    expect(startSpy).toHaveBeenCalledTimes(2)
    expect(agentCore.sendMessage).toHaveBeenCalledTimes(1)
    expect(core.getInteraction(db, record.id)!.answer!.resumed).toBe(true)
    expect(api.editMessageText.mock.calls.at(-1)[2]).toContain('✅ Beantwortet')
    await bot.stop()
  })

  it('review1 negative: optIdx out of range, qIdx jump and malformed callback_data have no effect', async () => {
    const core = await vi.importActual<typeof import('@axiom/core')>('@axiom/core')
    vi.mocked(agentCore.sendMessage).mockImplementation(() => textStream('ok'))
    const { bot, api, handlers } = await makeBotWithTurn()
    const record = await openAskUser(core, [
      { id: 'q1', type: 'choice', question: 'Erste?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
      { id: 'q2', type: 'choice', question: 'Zweite?', options: [{ id: 'c', label: 'C' }, { id: 'd', label: 'D' }] },
    ])
    const data = cardMarkup(api)[0]!.callback_data
    const [, op, id] = data.split(':')
    expect(op).toBe('o')
    api.editMessageText.mockClear()
    const outOfRange = await tap(handlers, `ia:o:${id}:0:9`)
    const qJump = await tap(handlers, `ia:o:${id}:1:0`)
    const malformed = await tap(handlers, `ia:o:${id}:0`)
    const junk = await tap(handlers, `ia:o:${id}:0:0:1`)
    expect(outOfRange).toHaveBeenCalledWith({ text: 'Diese Karte ist nicht mehr gültig.' })
    expect(qJump).toHaveBeenCalledWith({ text: 'Diese Frage ist schon beantwortet.' })
    expect(malformed).toHaveBeenCalledWith({ text: 'Diese Karte ist nicht mehr gültig.' })
    expect(junk).toHaveBeenCalledWith({ text: 'Diese Karte ist nicht mehr gültig.' })
    expect(portCalls).toHaveLength(0)
    expect(api.editMessageText).not.toHaveBeenCalled()
    expect(core.getInteraction(db, record.id)!.status).toBe('open')
    await bot.stop()
  })

  it('review1 draft conflict: a draft written on another surface stops the wizard here and edits the card', async () => {
    const core = await vi.importActual<typeof import('@axiom/core')>('@axiom/core')
    vi.mocked(agentCore.sendMessage).mockImplementation(() => textStream('ok'))
    const { bot, api, handlers } = await makeBotWithTurn()
    const record = await openAskUser(core, [
      { id: 'q1', type: 'choice', question: 'Erste?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
      { id: 'q2', type: 'choice', question: 'Zweite?', options: [{ id: 'c', label: 'C' }, { id: 'd', label: 'D' }] },
    ])
    const data = cardMarkup(api)[0]!.callback_data
    core.saveInteractionDraft(db, record.id, { answers: { q1: { selected: ['b'] } }, step: 1 })
    await vi.advanceTimersByTimeAsync(0)
    const moved = api.editMessageText.mock.calls.at(-1)
    expect(moved[2]).toContain('Wird auf einer anderen Oberfläche beantwortet.')
    expect(moved[3].reply_markup.inline_keyboard).toEqual([])
    const late = await tap(handlers, data)
    expect(late).toHaveBeenCalledWith({ text: 'Diese Frage wird gerade woanders beantwortet.' })
    expect(portCalls).toHaveLength(0)
    // The web answer closes the card here.
    core.transitionInteraction(db, record.id, 'answered', {
      closeSource: 'answer', closedSurface: 'web',
      answer: { value: 'b', label: 'B', answeredAt: new Date().toISOString(), clientRequestId: 'web-1', resumed: true },
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(api.editMessageText.mock.calls.at(-1)[2]).toContain('✅ Beantwortet')
    await bot.stop()
  })

  it('review1 comments: with two cards in one chat the comment goes to the latest prompt and the older prompt is visibly withdrawn', async () => {
    const core = await vi.importActual<typeof import('@axiom/core')>('@axiom/core')
    vi.mocked(agentCore.sendMessage).mockImplementation(() => textStream('ok'))
    const { bot, api, handlers } = await makeBotWithTurn()
    let next = 100
    api.sendMessage.mockImplementation(async () => ({ message_id: next++ }))
    const first = await openAskUser(core, [
      { id: 'q1', type: 'choice', question: 'Karte A?', allowComment: true, options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
    ])
    const second = await openAskUser(core, [
      { id: 'q1', type: 'choice', question: 'Karte B?', allowComment: true, options: [{ id: 'c', label: 'C' }, { id: 'd', label: 'D' }] },
    ])
    const rows = db.prepare('SELECT interaction_id, message_id FROM telegram_interaction_cards').all() as Array<{ interaction_id: string; message_id: number }>
    const msgOf = (id: string) => rows.find(r => r.interaction_id === id)!.message_id
    const keyboards = api.sendMessage.mock.calls.filter((c: any[]) => c[2]?.reply_markup).map((c: any[]) => c[2].reply_markup.inline_keyboard.flat())
    const commentA = keyboards[0].find((b: any) => b.text.includes('Kommentar')).callback_data
    const commentB = keyboards[1].find((b: any) => b.text.includes('Kommentar')).callback_data
    await tap(handlers, commentA, { messageId: msgOf(first.id) })
    await tap(handlers, commentB, { messageId: msgOf(second.id) })
    const withdrawn = api.editMessageText.mock.calls.filter((c: any[]) => c[1] === msgOf(first.id)).at(-1)
    expect(withdrawn[2]).toContain('Karte A?')
    expect(withdrawn[2]).not.toContain('Schreib deinen Kommentar')
    await handlers._handlers.get('message:text')!(createMockContext({ message: { text: 'nur für B', message_id: 3 } }) as any)
    await vi.advanceTimersByTimeAsync(0)
    const lastB = api.editMessageText.mock.calls.filter((c: any[]) => c[1] === msgOf(second.id)).at(-1)
    expect(lastB[2]).toContain('💬 nur für B')
    expect(api.editMessageText.mock.calls.filter((c: any[]) => c[1] === msgOf(first.id)).some((c: any[]) => String(c[2]).includes('nur für B'))).toBe(false)
    api.sendMessage.mockImplementation(async () => ({ message_id: 1 }))
    await bot.stop()
  })

  it('review1 delivery: a card whose sendMessage failed accepts no tap and is sent again at the next end of a turn', async () => {
    const core = await vi.importActual<typeof import('@axiom/core')>('@axiom/core')
    vi.mocked(agentCore.sendMessage).mockImplementation(() => textStream('ok'))
    const { bot, api, handlers } = await makeBotWithTurn()
    api.sendMessage.mockRejectedValueOnce(new Error('429 Too Many Requests'))
    const record = await openAskUser(core, [
      { id: 'q1', type: 'choice', question: 'Welche?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
    ])
    const failed = api.sendMessage.mock.calls.at(-1)
    const data = failed[2].reply_markup.inline_keyboard.flat()[0].callback_data
    expect(db.prepare('SELECT message_id FROM telegram_interaction_cards WHERE interaction_id = ?').get(record.id)).toEqual({ message_id: null })
    const early = await tap(handlers, data)
    expect(early).toHaveBeenCalledWith({ text: 'Diese Karte ist hier nicht gültig.' })
    expect(portCalls).toHaveLength(0)
    api.sendMessage.mockClear()
    const cards = (bot as any).interactionCards
    cards.beginTurn(SESSION_ID)
    await cards.endTurn(SESSION_ID)
    expect(cardMarkup(api).length).toBeGreaterThan(0)
    const resent = db.prepare('SELECT message_id FROM telegram_interaction_cards WHERE interaction_id = ?').get(record.id) as { message_id: number }
    expect(resent.message_id).not.toBeNull()
    const late = await tap(handlers, cardMarkup(api)[0]!.callback_data, { messageId: resent.message_id })
    expect(late.mock.calls).toEqual([[{ text: 'Gespeichert.' }]])
    expect(portCalls).toHaveLength(1)
    await bot.stop()
  })

  it('review1 double tap: tapping "Fertig" of a multi-select twice files one answer and starts one turn', async () => {
    const core = await vi.importActual<typeof import('@axiom/core')>('@axiom/core')
    vi.mocked(agentCore.sendMessage).mockImplementation(() => textStream('ok'))
    const { bot, api, handlers } = await makeBotWithTurn()
    const record = await openAskUser(core, [
      { id: 'q1', type: 'multi', question: 'Welche?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
    ])
    const buttons = cardMarkup(api)
    const option = buttons.find((b: any) => b.callback_data.startsWith('ia:o:'))!.callback_data
    const done = buttons.find((b: any) => b.callback_data.startsWith('ia:f:'))!.callback_data
    await tap(handlers, option)
    const [first, second] = await Promise.all([tap(handlers, done, { id: 'cbq-f1' }), tap(handlers, done, { id: 'cbq-f2' })])
    const third = await tap(handlers, done, { id: 'cbq-f3' })
    expect(portCalls).toHaveLength(1)
    expect(core.getInteraction(db, record.id)!.status).toBe('answered')
    expect([...first.mock.calls, ...second.mock.calls].flat()).toContainEqual({ text: 'Gespeichert.' })
    expect(third.mock.calls.flat()).not.toContainEqual({ text: 'Gespeichert.' })
    await bot.stop()
  })

  /** Mirrors the service (with the resume retry of feat/s1-c-web b94742f3): starter throws => 502, same bound key on resumed=false => only the turn, other key on a closed card => 409. */
  function resumePort(core: typeof import('@axiom/core')) {
    return {
      ...fakePort(core),
      answerById: (actor: unknown, id: string, input: any) => {
        portCalls.push({ kind: 'answer', actor, id, input })
        let rec = core.getInteraction(db, id)!
        if (rec.status === 'open') {
          rec = core.transitionInteraction(db, id, 'answered', {
            closeSource: 'answer', closedSurface: 'telegram',
            answer: { value: 'a', label: 'A', answeredAt: new Date().toISOString(), clientRequestId: input.clientRequestId, resumed: false },
          })
        } else if (rec.answer?.clientRequestId !== input.clientRequestId || rec.answer?.resumed) {
          throw Object.assign(new Error('closed'), { status: 409, code: 'closed' })
        }
        try {
          input.startTurn({ userId: USER_ID, sessionId: SESSION_ID, text: 'Antwort: A', source: 'telegram', agentId: 'main', explicitSessionId: SESSION_ID, inputMode: 'answer', replyToInteractionId: id })
        } catch {
          throw Object.assign(new Error('turn'), { status: 502, code: 'turn_failed' })
        }
        rec = core.markInteractionResumed(db, id, true)
        return { resumed: true, label: 'A', interaction: rec }
      },
    }
  }

  it('review2 restart retry: after a bot restart the row (answered, resumed=false) still offers the retry; the tap starts the turn with the stored key, resumed=true, button gone', async () => {
    const core = await vi.importActual<typeof import('@axiom/core')>('@axiom/core')
    unregisterPort()
    unregisterPort = core.registerInteractionAnswerPort(resumePort(core) as any)
    vi.mocked(agentCore.sendMessage).mockImplementation(() => textStream('Weiter.'))
    const first = await makeBotWithTurn()
    const record = await openAskUser(core, [
      { id: 'q1', type: 'choice', question: 'Welche?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
    ])
    const optionData = cardMarkup(first.api)[0]!.callback_data
    vi.spyOn((first.bot as any).turnRunner, 'startTurn').mockImplementationOnce(() => { throw new Error('runner busy') })
    await tap(first.handlers, optionData, { id: 'cbq-rs' })
    expect(core.getInteraction(db, record.id)!.answer).toMatchObject({ resumed: false, clientRequestId: 'tg:cbq-rs' })
    const retryData = first.api.editMessageText.mock.calls.at(-1)[3].reply_markup.inline_keyboard.flat()[0].callback_data
    expect(retryData).toMatch(/^ia:r:/)
    await first.bot.stop()

    // Fresh bot instance, same database: nothing of the first process survives but the rows.
    vi.mocked(agentCore.sendMessage).mockClear()
    const secondBot = new TelegramBot({ agentCore, db, config })
    const second = secondBot.getBot() as unknown as MockBotInternals & { api: any }
    await secondBot.start()
    // An old option button of the card: the rebuilt card is a retry card (state from the row).
    const stale = await tap(second, optionData, { id: 'cbq-old' })
    expect(stale).toHaveBeenCalledWith({ text: 'Antwort gespeichert, Agent nicht gestartet – erneut tippen.' })
    expect(portCalls.filter(c => c.kind === 'answer')).toHaveLength(1)

    const retried = await tap(second, retryData, { id: 'cbq-retry' })
    await vi.advanceTimersByTimeAsync(0)
    expect(retried).toHaveBeenCalledWith({ text: 'Gespeichert.' })
    const answers = portCalls.filter(c => c.kind === 'answer')
    expect(answers).toHaveLength(2)
    expect(answers[1]!.input.clientRequestId).toBe('tg:cbq-rs')
    expect(answers[1]!.input.answers).toBeUndefined()
    expect(agentCore.sendMessage).toHaveBeenCalledTimes(1)
    expect(core.getInteraction(db, record.id)!.answer!.resumed).toBe(true)
    const last = second.api.editMessageText.mock.calls.at(-1)
    expect(last[2]).toContain('✅ Beantwortet')
    expect(last[3].reply_markup.inline_keyboard).toEqual([])
    // Idempotent: the retry once more starts nothing.
    const again = await tap(second, retryData, { id: 'cbq-retry2' })
    expect(again).toHaveBeenCalledWith({ text: 'Schon erledigt.' })
    expect(portCalls.filter(c => c.kind === 'answer')).toHaveLength(2)
    await secondBot.stop()
  })

  it('review2 busy guard: a second callback arriving while the first answer is inside the port does not reach the port', async () => {
    const core = await vi.importActual<typeof import('@axiom/core')>('@axiom/core')
    vi.mocked(agentCore.sendMessage).mockImplementation(() => textStream('ok'))
    const { bot, api } = await makeBotWithTurn()
    const record = await openAskUser(core, [
      { id: 'q1', type: 'choice', question: 'Welche?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
    ])
    const data = cardMarkup(api)[0]!.callback_data
    const messageId = (db.prepare('SELECT message_id FROM telegram_interaction_cards WHERE interaction_id = ?').get(record.id) as { message_id: number }).message_id
    const cards = (bot as any).interactionCards
    const cb = (id: string, answer: ReturnType<typeof vi.fn>) => ({ data, callbackQueryId: id, chatId: CHAT_ID, messageId, fromUserId: USER_ID, answer })
    const secondAnswer = vi.fn().mockResolvedValue(true)
    let inner: Promise<unknown> | null = null
    const base = fakePort(core)
    unregisterPort()
    unregisterPort = core.registerInteractionAnswerPort({
      ...base,
      answerById: (actor: unknown, id: string, input: any) => {
        // The second tap is processed while the first one is still in flight (row still open).
        if (!inner) inner = cards.handleCallback(cb('cbq-b2', secondAnswer))
        return base.answerById(actor, id, input)
      },
    } as any)
    await cards.handleCallback(cb('cbq-b1', vi.fn().mockResolvedValue(true)))
    await inner
    await vi.advanceTimersByTimeAsync(0)
    expect(portCalls.filter(c => c.kind === 'answer')).toHaveLength(1)
    expect(secondAnswer).toHaveBeenCalledWith('Wird gerade gespeichert …')
    await bot.stop()
  })

  it('review2 double tap single choice: two simultaneous taps on the same option file one answer and start one turn', async () => {
    const core = await vi.importActual<typeof import('@axiom/core')>('@axiom/core')
    vi.mocked(agentCore.sendMessage).mockImplementation(() => textStream('ok'))
    const { bot, api, handlers } = await makeBotWithTurn()
    const record = await openAskUser(core, [
      { id: 'q1', type: 'choice', question: 'Welche?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
    ])
    const data = cardMarkup(api)[1]!.callback_data
    vi.mocked(agentCore.sendMessage).mockClear()
    const [one, two] = await Promise.all([tap(handlers, data, { id: 'cbq-s1' }), tap(handlers, data, { id: 'cbq-s2' })])
    await vi.advanceTimersByTimeAsync(0)
    expect(portCalls.filter(c => c.kind === 'answer')).toHaveLength(1)
    expect(core.getInteraction(db, record.id)!.status).toBe('answered')
    const texts = [...one.mock.calls, ...two.mock.calls].flat()
    expect(texts.filter((t: any) => t?.text === 'Gespeichert.')).toHaveLength(1)
    // The second tap is stopped by the busy guard (the first request still holds the card), not by a later layer.
    expect(texts).toContainEqual({ text: 'Wird gerade gespeichert …' })
    expect(agentCore.sendMessage).toHaveBeenCalledTimes(1)
    await bot.stop()
  })

  it('review2 late tap: a 409 from the service (answered meanwhile) is shown as "bereits beantwortet", the card closes without an edit error', async () => {
    const core = await vi.importActual<typeof import('@axiom/core')>('@axiom/core')
    vi.mocked(agentCore.sendMessage).mockImplementation(() => textStream('ok'))
    const { bot, api, handlers } = await makeBotWithTurn()
    const record = await openAskUser(core, [
      { id: 'q1', type: 'choice', question: 'Welche?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
    ])
    const data = cardMarkup(api)[0]!.callback_data
    unregisterPort()
    unregisterPort = core.registerInteractionAnswerPort({
      ...fakePort(core),
      answerById: (actor: unknown, id: string, input: any) => {
        portCalls.push({ kind: 'answer', actor, id, input })
        // Another surface/instance committed its answer first: the service answers 409.
        core.transitionInteraction(db, id, 'answered', {
          closeSource: 'answer', closedSurface: 'web',
          answer: { value: 'b', label: 'B', answeredAt: new Date().toISOString(), clientRequestId: 'web-first', resumed: true },
        })
        throw Object.assign(new Error('closed'), { status: 409, code: 'closed' })
      },
    } as any)
    const warn = vi.spyOn(console, 'warn')
    const late = await tap(handlers, data, { id: 'cbq-late' })
    expect(late).toHaveBeenCalledWith({ text: 'Diese Frage ist bereits beantwortet.' })
    expect(portCalls.filter(c => c.kind === 'answer')).toHaveLength(1)
    expect(core.getInteraction(db, record.id)!.answer!.clientRequestId).toBe('web-first')
    const last = api.editMessageText.mock.calls.at(-1)
    expect(last[2]).toContain('✅ Beantwortet')
    expect(last[3].reply_markup.inline_keyboard).toEqual([])
    expect(warn.mock.calls.flat().join(' ')).not.toContain('edit failed')
    const again = await tap(handlers, data, { id: 'cbq-late2' })
    expect(again).toHaveBeenCalledWith({ text: 'Schon erledigt.' })
    expect(portCalls.filter(c => c.kind === 'answer')).toHaveLength(1)
    warn.mockRestore()
    await bot.stop()
  })

  it('review1 group: the answer turn of a card in a group chat runs with source telegram-group', async () => {
    const core = await vi.importActual<typeof import('@axiom/core')>('@axiom/core')
    vi.mocked(agentCore.sendMessage).mockImplementation(() => textStream('ok'))
    const bot = new TelegramBot({ agentCore, db, config })
    const underlying = bot.getBot() as unknown as MockBotInternals & { api: any }
    await bot.start()
    await underlying._handlers.get('message:text')!(createMockContext({ chat: { id: CHAT_ID, type: 'group' }, message: { text: 'Hallo Gruppe', message_id: 1 } }) as any)
    await vi.advanceTimersByTimeAsync(2500)
    await openAskUser(core, [
      { id: 'q1', type: 'choice', question: 'Welche?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
    ])
    const data = cardMarkup(underlying.api)[0]!.callback_data
    const row = db.prepare('SELECT is_group, message_id FROM telegram_interaction_cards').get() as { is_group: number; message_id: number }
    expect(row.is_group).toBe(1)
    vi.mocked(agentCore.sendMessage).mockClear()
    await tap(underlying, data, { messageId: row.message_id })
    expect(portCalls).toHaveLength(1)
    expect(vi.mocked(agentCore.sendMessage).mock.calls[0]![2]).toBe('telegram-group')
    await bot.stop()
  })
})
