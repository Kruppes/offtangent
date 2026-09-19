import crypto from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16
const KEY_LENGTH = 32

/**
 * Get or derive the encryption key from environment or a default.
 * In production, ENCRYPTION_KEY should be set.
 *
 * NOTE: The scrypt salt and default key string are kept as `openagent-salt`
 * and `openagent-dev-key` on purpose — they are **cryptographic seeds**, not
 * brand identifiers. Renaming them would change the derived AES key and make
 * every existing `secrets.json` / `providers.json` entry undecryptable.
 * This is a permanent historical identifier from before the Axiom rebrand.
 */
function getEncryptionKey(): Buffer {
  const envKey = process.env.ENCRYPTION_KEY
  if (envKey) {
    // If provided key is hex-encoded 32 bytes
    if (envKey.length === 64) {
      return Buffer.from(envKey, 'hex')
    }
    // Otherwise derive a key from it
    return crypto.scryptSync(envKey, 'openagent-salt', KEY_LENGTH)
  }
  // Default key for development (not secure for production)
  return crypto.scryptSync('openagent-dev-key', 'openagent-salt', KEY_LENGTH)
}

/**
 * Encrypt a plaintext string. Returns a base64-encoded string containing IV + authTag + ciphertext.
 */
export function encrypt(plaintext: string): string {
  const key = getEncryptionKey()
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ])
  const authTag = cipher.getAuthTag()

  // Pack: IV (12) + authTag (16) + ciphertext
  const packed = Buffer.concat([iv, authTag, encrypted])
  return packed.toString('base64')
}

/**
 * Decrypt a base64-encoded encrypted string.
 */
export function decrypt(encryptedBase64: string): string {
  const key = getEncryptionKey()
  const packed = Buffer.from(encryptedBase64, 'base64')

  const iv = packed.subarray(0, IV_LENGTH)
  const authTag = packed.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH)
  const ciphertext = packed.subarray(IV_LENGTH + AUTH_TAG_LENGTH)

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ])

  return decrypted.toString('utf8')
}

/**
 * Check if a string looks like it's already encrypted (strict base64 with expected minimum length).
 *
 * NOTE: We must validate strict base64 here. Node's `Buffer.from(value, 'base64')`
 * silently ignores invalid characters (e.g. `-` in `tvly-dev-...`), which previously
 * caused plaintext API keys with dashes to be misclassified as encrypted, breaking
 * both storage (no encryption applied) and decryption (auth tag check fails on startup).
 */
export function isEncrypted(value: string): boolean {
  // Minimum: IV (12) + authTag (16) + at least 1 byte ciphertext = 29 bytes
  // Strict base64 length must be a multiple of 4, so minimum is 40 chars (covers 30 bytes).
  if (value.length < 40) return false
  if (value.length % 4 !== 0) return false
  // Strict base64 alphabet: A-Z a-z 0-9 + / and up to 2 '=' padding chars at the end
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false
  try {
    const buf = Buffer.from(value, 'base64')
    return buf.length >= IV_LENGTH + AUTH_TAG_LENGTH + 1
  } catch {
    return false
  }
}

/**
 * Mask an API key for display: show first 4 and last 4 chars
 */
export function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 8) return '••••••••'
  return apiKey.slice(0, 4) + '••••••••' + apiKey.slice(-4)
}
