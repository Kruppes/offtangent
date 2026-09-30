/**
 * Hard timeout for promises that may never settle (e.g. an LLM HTTP call on
 * a connection whose peer died mid-request — no error event, no response).
 * The underlying operation is NOT cancelled (it may leak until GC), but the
 * caller is guaranteed to proceed.
 */
export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
    if (typeof timer === 'object' && 'unref' in timer) timer.unref()
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}
