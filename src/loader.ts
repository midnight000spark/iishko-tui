/**
 * Сетевая часть каталога: три публичных документа reformboss.com, таймауты,
 * кэш 30 с и деградация до последнего снимка. Без UI и без ключей.
 */

import { SiteError, parseRanksHtml, parseRanksJson, parseStatus } from "./parse.js"
import {
  mergeCatalog,
  resolveRanks,
  type Catalog,
  type ParsedStatus,
  type RankMap,
  type RankPriority,
} from "./site.js"

export interface Sources {
  readonly status: string
  readonly pricingJson: string
  readonly pricingHtml: string
}

export const DEFAULT_SOURCES: Sources = {
  status: "https://reformboss.com/api/status.json",
  pricingJson: "https://reformboss.com/api/pricing",
  pricingHtml: "https://reformboss.com/pricing",
}

/** Минимальная форма ответа: `fetch` ей соответствует структурно. */
export interface HttpResponseLike {
  readonly ok: boolean
  readonly status: number
  readonly headers?: { get(name: string): string | null }
  readonly body?: ReadableStream<Uint8Array> | null
  text(): Promise<string>
}

export interface FetchInit {
  readonly method: string
  readonly headers: Readonly<Record<string, string>>
  readonly credentials: "omit"
  readonly cache: "no-store"
  readonly signal?: AbortSignal
}

export type FetchLike = (url: string, init: FetchInit) => Promise<HttpResponseLike>

export interface CatalogLoad {
  readonly catalog: Catalog
  readonly warnings: readonly string[]
  readonly fromCache: boolean
  readonly fetchedAt: number
  readonly stale?: boolean
}

export interface LoadOptions {
  readonly force?: boolean
  readonly signal?: AbortSignal
  readonly configured?: readonly string[]
  readonly priority?: RankPriority
}

export interface Loader {
  load(options?: LoadOptions): Promise<CatalogLoad>
}

export interface LoaderConfig {
  /** Свежесть снимка; совпадает с `cache-control: max-age=30` сайта. */
  readonly ttlMs?: number
  /** Сколько можно показывать последний снимок при недоступном сайте. */
  readonly staleMs?: number
  readonly timeoutMs?: number
  readonly now?: () => number
}

interface Snapshot {
  readonly at: number
  readonly status: ParsedStatus
  readonly catalogRanks: RankMap
  readonly apiRanks: RankMap
  readonly warnings: readonly string[]
}

const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024

/** Создаёт загрузчик каталога с изолированным кэшем. */
export function createLoader(
  http: FetchLike,
  sources: Sources = DEFAULT_SOURCES,
  config: LoaderConfig = {},
): Loader {
  const ttlMs = config.ttlMs ?? 30_000
  const staleMs = config.staleMs ?? 10 * 60_000
  const timeoutMs = config.timeoutMs ?? 10_000
  const now = config.now ?? Date.now
  let cache: Snapshot | undefined

  return {
    async load(options: LoadOptions = {}): Promise<CatalogLoad> {
      checkAbort(options.signal)
      const at = now()
      const cached = cache
      if (options.force !== true && cached !== undefined && isFresh(cached, at, ttlMs)) {
        return build(cached, options, true)
      }
      try {
        const snapshot = await fetchSnapshot(http, sources, timeoutMs, now, options.signal)
        checkAbort(options.signal)
        cache = snapshot
        return build(snapshot, options, false)
      } catch (error) {
        checkAbort(options.signal)
        if (isAbort(error)) throw error
        if (cached !== undefined && isReusable(cached, now(), staleMs)) {
          return {
            ...build(cached, options, true),
            stale: true,
            warnings: [
              ...cached.warnings,
              `сайт недоступен (${describe(error)}), данные от ${clock(cached.at)}`,
            ],
          }
        }
        throw error
      }
    },
  }
}

function build(snapshot: Snapshot, options: LoadOptions, fromCache: boolean): CatalogLoad {
  checkAbort(options.signal)
  const priority = options.priority ?? "site"
  const index = resolveRanks(snapshot.catalogRanks, snapshot.apiRanks, priority)
  return {
    catalog: mergeCatalog(snapshot.status, index, options.configured ?? []),
    warnings: snapshot.warnings,
    fromCache,
    fetchedAt: snapshot.at,
    stale: false,
  }
}

async function fetchSnapshot(
  http: FetchLike,
  sources: Sources,
  timeoutMs: number,
  now: () => number,
  signal?: AbortSignal,
): Promise<Snapshot> {
  checkAbort(signal)
  // Fetch AND parse are one isolated operation per optional source.
  const results = await Promise.allSettled([
    request(http, sources.status, "application/json", timeoutMs, signal).then((text) => parseStatus(parseJson(text))),
    request(http, sources.pricingJson, "application/json", timeoutMs, signal).then((text) => parseRanksJson(parseJson(text))),
    request(http, sources.pricingHtml, "text/html", timeoutMs, signal).then(parseRanksHtml),
  ])
  checkAbort(signal)
  const statusResult = results[0]
  if (statusResult === undefined || statusResult.status === "rejected") {
    throw toSiteError(statusResult?.reason)
  }
  const warnings: string[] = []
  const jsonResult = results[1]
  const htmlResult = results[2]
  const catalogRanks =
    htmlResult?.status === "fulfilled" ? htmlResult.value : new Map()
  if (htmlResult?.status !== "fulfilled") warnings.push("каталог рангов /pricing недоступен")
  const apiRanks =
    jsonResult?.status === "fulfilled" ? jsonResult.value : new Map()
  if (jsonResult?.status !== "fulfilled") warnings.push("ранги /api/pricing недоступны")
  if (catalogRanks.size === 0 && apiRanks.size === 0) warnings.push("ранги недоступны: «ранг ?»")

  return {
    at: now(),
    status: statusResult.value,
    catalogRanks,
    apiRanks,
    warnings,
  }
}

async function request(
  http: FetchLike,
  url: string,
  accept: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  checkAbort(signal)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const forward = () => controller.abort()
  if (signal?.aborted === true) controller.abort()
  else signal?.addEventListener("abort", forward, { once: true })
  try {
    checkAbort(controller.signal)
    const response = await http(url, {
      method: "GET",
      headers: { accept },
      credentials: "omit",
      cache: "no-store",
      signal: controller.signal,
    })
    checkAbort(controller.signal)
    if (!response.ok) throw new SiteError("http", `HTTP ${response.status}`)
    const text = await readDocument(response, controller.signal)
    checkAbort(controller.signal)
    return text
  } catch (error) {
    checkAbort(signal)
    if (isAbort(error)) throw error
    if (error instanceof SiteError) throw error
    throw new SiteError("network", networkMessage(error))
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", forward)
  }
}

async function readDocument(response: HttpResponseLike, signal: AbortSignal): Promise<string> {
  const length = Number(response.headers?.get("content-length"))
  const reader = response.body?.getReader()
  const cancel = () => { void reader?.cancel().catch(() => {}) }
  signal.addEventListener("abort", cancel, { once: true })
  try {
    checkAbort(signal)
    if (length > MAX_DOCUMENT_BYTES) throw new SiteError("shape", "документ сайта больше 4 MiB")
    if (reader === undefined) {
      const text = await response.text()
      checkAbort(signal)
      if (text.length > MAX_DOCUMENT_BYTES || new TextEncoder().encode(text).byteLength > MAX_DOCUMENT_BYTES) {
        throw new SiteError("shape", "документ сайта больше 4 MiB")
      }
      return text
    }
    const decoder = new TextDecoder()
    const chunks: string[] = []
    let size = 0
    for (;;) {
      checkAbort(signal)
      const chunk = await reader.read()
      checkAbort(signal)
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > MAX_DOCUMENT_BYTES) throw new SiteError("shape", "документ сайта больше 4 MiB")
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

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new DOMException("операция отменена", "AbortError")
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError"
}

function isFresh(cache: Snapshot | undefined, at: number, ttlMs: number): boolean {
  if (cache === undefined) return false
  const age = at - cache.at
  return age >= 0 && age < ttlMs
}

function isReusable(cache: Snapshot | undefined, at: number, staleMs: number): boolean {
  if (cache === undefined) return false
  const age = at - cache.at
  return age >= 0 && age <= staleMs
}

function clock(atMs: number): string {
  return new Date(atMs).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    throw new SiteError("shape", "ответ сайта — не JSON")
  }
}

function toSiteError(reason: unknown): Error {
  return reason instanceof Error ? reason : new SiteError("shape", "сайт не ответил")
}

function networkMessage(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") return "таймаут запроса"
  return error instanceof Error ? error.message : String(error)
}

function describe(error: unknown): string {
  return error instanceof SiteError ? error.message : error instanceof Error ? error.message : String(error)
}
