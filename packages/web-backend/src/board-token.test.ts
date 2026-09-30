/**
 * Board content capability tokens. The token is the only credential in front
 * of skill written HTML, so every way of widening it is a test here.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mintBoardToken, verifyBoardToken, BOARD_TOKEN_TTL_SECONDS } from './board-token.js'
import { mintArtifactToken } from './artifact-token.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('board content tokens', () => {
  it('round trips key, revision and user', () => {
    const { token, expiresAt } = mintBoardToken('wheel-demo', 3, 7)
    expect(verifyBoardToken(token)).toEqual({
      key: 'wheel-demo', revision: 3, userId: 7,
      expiresAt: Math.floor(Date.parse(expiresAt) / 1000),
    })
  })

  it('rejects a tampered key, revision or user', () => {
    const { token } = mintBoardToken('wheel-demo', 0, 7)
    const parts = token.split('.')
    const swap = (index: number, value: string) => {
      const copy = [...parts]
      copy[index] = value
      return copy.join('.')
    }
    expect(verifyBoardToken(swap(1, 'other-board'))).toBeNull()
    expect(verifyBoardToken(swap(2, '4'))).toBeNull()
    expect(verifyBoardToken(swap(3, '1'))).toBeNull()
    expect(verifyBoardToken(swap(4, String(Math.floor(Date.now() / 1000) + 99_999)))).toBeNull()
    expect(verifyBoardToken(`${parts.slice(0, 5).join('.')}.${'A'.repeat(parts[5].length)}`)).toBeNull()
  })

  it('expires', () => {
    const { token } = mintBoardToken('wheel-demo', 0, 7)
    expect(verifyBoardToken(token)).not.toBeNull()
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + (BOARD_TOKEN_TTL_SECONDS + 2) * 1000)
    expect(verifyBoardToken(token)).toBeNull()
  })

  it('refuses junk and the wrong token family', () => {
    expect(verifyBoardToken(undefined)).toBeNull()
    expect(verifyBoardToken('')).toBeNull()
    expect(verifyBoardToken('b1.wheel-demo.0.7')).toBeNull()
    expect(verifyBoardToken(['b1', 'x'])).toBeNull()
    expect(verifyBoardToken('x'.repeat(600))).toBeNull()
    // An artifact token must never open a board, even though both derive from
    // JWT_SECRET on a default install (domain separated HMAC keys).
    expect(verifyBoardToken(mintArtifactToken('art-1', 7).token)).toBeNull()
  })

  it('does not accept a key shape a board could never have', () => {
    // Keys are [a-z0-9-]; a '.' in the key would make the token ambiguous.
    const { token } = mintBoardToken('wheel.demo', 0, 7)
    expect(verifyBoardToken(token)).toBeNull()
  })
})
