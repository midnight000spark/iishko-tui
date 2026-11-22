const SOURCES = {
  metadata: { url: "https://models.dev/api.json", bytes: 32 * 1024 * 1024, ttl: 24 * 60 * 60_000 },
  schema: { url: "https://opencode.ai/config.json", bytes: 4 * 1024 * 1024, ttl: 60 * 60_000 },
  modelSchema: { url: "https://models.dev/model-schema.json", bytes: 4 * 1024 * 1024, ttl: 60 * 60_000 },
} as const

export type PublicDocument = keyof typeof SOURCES
export type PublicFetch = (url: string, init?: RequestInit) => Promise<Response>
export interface PublicData {
  load(kind: PublicDocument, signal?: AbortSignal): Promise<unknown>
}

/** Fixed public endpoints only. No credentials, config substitutions or remote schema refs. */
export function createPublicData(http: PublicFetch = fetch, now: () => number = Date.now): PublicData {
  const cache = new Map<PublicDocument, { at: number; value: unknown }>()
  return {
    async load(kind, signal) {
      signal?.throwIfAborted()
      const source = SOURCES[kind]
      const cached = cache.get(kind)
      if (cached && now() >= cached.at && now() - cached.at < source.ttl) return cached.value
      const controller = new AbortController()
      const abort = () => controller.abort()
      signal?.addEventListener("abort", abort, { once: true })
      const timer = setTimeout(abort, 20_000)
      try {
        signal?.throwIfAborted()
        const response = await http(source.url, {
          method: "GET", credentials: "omit", redirect: "error",
          headers: { accept: "application/json" }, signal: controller.signal,
        })
        controller.signal.throwIfAborted()
        if (!response.ok) throw new Error(`Публичный документ недоступен (HTTP ${response.status}).`)
        const text = await boundedText(response, source.bytes, controller.signal)
        controller.signal.throwIfAborted()
        let value: unknown
        try { value = JSON.parse(text) } catch { throw new Error("Публичный документ содержит некорректный JSON.") }
        cache.set(kind, { at: now(), value })
        return value
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener("abort", abort)
      }
    },
  }
}

async function boundedText(response: Response, maximum: number, signal: AbortSignal): Promise<string> {
  const reader = response.body?.getReader()
  const cancel = () => { void reader?.cancel().catch(() => {}) }
  signal.addEventListener("abort", cancel, { once: true })
  try {
    if (Number(response.headers.get("content-length")) > maximum) throw new Error("Публичный документ слишком большой.")
    if (!reader) throw new Error("Пустой ответ публичного источника.")
    const decoder = new TextDecoder()
    const chunks: string[] = []
    let size = 0
    for (;;) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      signal.throwIfAborted()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > maximum) throw new Error("Публичный документ слишком большой.")
      chunks.push(decoder.decode(chunk.value, { stream: true }))
    }
    chunks.push(decoder.decode())
    return chunks.join("")
  } catch (error) {
    await reader?.cancel().catch(() => {})
    throw error
  } finally {
    signal.removeEventListener("abort", cancel)
    reader?.releaseLock()
  }
}
