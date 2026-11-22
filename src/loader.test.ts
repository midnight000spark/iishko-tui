import { describe, expect, test } from "bun:test"
import { createLoader, type FetchLike, type HttpResponseLike, type Sources } from "./loader.js"
import { SiteError } from "./parse.js"

const SOURCES: Sources = { status: "https://test/status", pricingJson: "https://test/json", pricingHtml: "https://test/html" }
const STATUS = JSON.stringify({ updated: 1_700_000_000, models: [{ id: "m", state: "up" }], unmeasured: ["media"] })
const JSON_RANKS = JSON.stringify({ data: [{ model_name: "m", enable_groups: ["t1"] }, { model_name: "media", enable_groups: ["t2"] }] })
const HTML_RANKS = "<table><tr><td>m</td><td>chat</td><td>$1</td><td>$2</td><td>—</td><td>Профи</td></tr></table>"

function response(text: string): HttpResponseLike {
  return { ok: true, status: 200, text: async () => text }
}

function stub(overrides: Partial<Record<keyof Sources, string>> = {}) {
  const calls: string[] = []
  const http: FetchLike = async (url) => {
    calls.push(url)
    if (url === SOURCES.status) return response(overrides.status ?? STATUS)
    if (url === SOURCES.pricingJson) return response(overrides.pricingJson ?? JSON_RANKS)
    return response(overrides.pricingHtml ?? HTML_RANKS)
  }
  return { http, calls }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe("optional catalog sources", () => {
  test("malformed optional JSON does not discard valid status or HTML ranks", async () => {
    const load = await createLoader(stub({ pricingJson: "{" }).http, SOURCES).load()
    expect(load.catalog.models.find((model) => model.id === "m")?.ranks).toEqual(["t3"])
    expect(load.warnings.join(" ")).toContain("/api/pricing")
    expect(load.stale).toBe(false)
  })

  test("HTML parse errors do not discard valid API ranks", async () => {
    const load = await createLoader(stub({ pricingHtml: HTML_RANKS + HTML_RANKS }).http, SOURCES).load()
    expect(load.catalog.models.find((model) => model.id === "m")?.ranks).toEqual(["t1"])
    expect(load.catalog.models.find((model) => model.id === "media")?.ranks).toEqual(["t2"])
    expect(load.warnings.join(" ")).toContain("/pricing")
  })

  test("optional fetch failure and optional shape failure are both warnings", async () => {
    const original = stub({ pricingJson: "{}" })
    const http: FetchLike = async (url, init) => {
      if (url === SOURCES.pricingHtml) throw new Error("offline")
      return original.http(url, init)
    }
    const load = await createLoader(http, SOURCES).load()
    expect(load.catalog.counts.up).toBe(1)
    expect(load.warnings).toHaveLength(3)
    expect(load.catalog.models[0]?.rankSource).toBe("unknown")
  })

  test("partial status is rejected, never accepted as authoritative fresh evidence", async () => {
    const original = stub()
    let partial = false
    const http: FetchLike = async (url, init) => url === SOURCES.status && partial
      ? response(JSON.stringify({ updated: 1, models: [{ id: "m" }, "junk"], unmeasured: [] }))
      : original.http(url, init)
    const loader = createLoader(http, SOURCES)
    await loader.load()
    partial = true
    const stale = await loader.load({ force: true })
    expect(stale.stale).toBe(true)
    expect(stale.warnings.join(" ")).toContain("сайт недоступен")
    expect(stale.catalog.counts.up).toBe(1)
    await expect(createLoader(stub({ status: "{}" }).http, SOURCES).load()).rejects.toBeInstanceOf(SiteError)
  })

  test("cached raw evidence is remerged for current account and rank priority", async () => {
    const original = stub()
    const loader = createLoader(original.http, SOURCES)
    await loader.load({ configured: ["first"], priority: "site" })
    const load = await loader.load({ configured: ["second"], priority: "conservative" })
    expect(original.calls).toHaveLength(3)
    expect(load.fromCache).toBe(true)
    expect(load.catalog.models.some((model) => model.id === "first")).toBe(false)
    expect(load.catalog.models.find((model) => model.id === "second")?.configured).toBe(true)
    expect(load.catalog.models.find((model) => model.id === "m")).toMatchObject({ ranks: [], rankSource: "both" })
  })
})

describe("catalog cancellation", () => {
  test("pre-abort performs no requests and abort beats a fresh cache hit", async () => {
    const original = stub()
    const loader = createLoader(original.http, SOURCES)
    const controller = new AbortController()
    controller.abort()
    await expect(loader.load({ signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" })
    expect(original.calls).toHaveLength(0)
    await loader.load()
    await expect(loader.load({ signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" })
    expect(original.calls).toHaveLength(3)
  })

  test("abort after fetch await never reads body or returns a stale snapshot", async () => {
    const original = stub()
    const pending = deferred<HttpResponseLike>()
    let delayed = false
    let reads = 0
    const http: FetchLike = async (url, init) => url === SOURCES.status && delayed ? pending.promise : original.http(url, init)
    const loader = createLoader(http, SOURCES)
    await loader.load()
    delayed = true
    const controller = new AbortController()
    const loading = loader.load({ force: true, signal: controller.signal })
    controller.abort()
    pending.resolve({ ok: true, status: 200, text: async () => { reads += 1; return STATUS } })
    await expect(loading).rejects.toMatchObject({ name: "AbortError" })
    expect(reads).toBe(0)
  })

  test("abort during fallback text await never caches the returned body", async () => {
    const original = stub()
    const started = deferred<void>()
    const body = deferred<string>()
    let delayed = true
    const http: FetchLike = async (url, init) => url === SOURCES.status && delayed
      ? { ok: true, status: 200, text: async () => { started.resolve(); return body.promise } }
      : original.http(url, init)
    const loader = createLoader(http, SOURCES)
    const controller = new AbortController()
    const loading = loader.load({ signal: controller.signal })
    await started.promise
    controller.abort()
    body.resolve(STATUS)
    await expect(loading).rejects.toMatchObject({ name: "AbortError" })
    delayed = false
    expect((await loader.load()).fromCache).toBe(false)
  })

  test("abort during streaming read cancels the stream even if fetch ignores its signal", async () => {
    const original = stub()
    const started = deferred<void>()
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      pull() { started.resolve() },
      cancel() { cancelled = true },
    })
    const http: FetchLike = async (url, init) => url === SOURCES.status
      ? { ...response(""), body: stream }
      : original.http(url, init)
    const controller = new AbortController()
    const loading = createLoader(http, SOURCES).load({ signal: controller.signal })
    await started.promise
    controller.abort()
    await expect(loading).rejects.toMatchObject({ name: "AbortError" })
    expect(cancelled).toBe(true)
  })
})

describe("bounded catalog responses", () => {
  test("content length rejects before reading and cancels the response stream", async () => {
    const original = stub()
    let cancelled = false
    let textRead = false
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true } })
    const http: FetchLike = async (url, init) => url === SOURCES.status
      ? { ok: true, status: 200, body: stream, headers: { get: () => "4194305" }, text: async () => { textRead = true; return STATUS } }
      : original.http(url, init)
    await expect(createLoader(http, SOURCES).load()).rejects.toThrow("4 MiB")
    expect(cancelled).toBe(true)
    expect(textRead).toBe(false)
  })

  test("streamed bytes are capped without trusting content length", async () => {
    const original = stub()
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)) },
      cancel() { cancelled = true },
    })
    const http: FetchLike = async (url, init) => url === SOURCES.status ? { ...response(""), body: stream } : original.http(url, init)
    await expect(createLoader(http, SOURCES).load()).rejects.toThrow("4 MiB")
    expect(cancelled).toBe(true)
  })

  test("text-only adapters still enforce byte limits, including multibyte text", async () => {
    await expect(createLoader(stub({ status: "я".repeat(2 * 1024 * 1024 + 1) }).http, SOURCES).load()).rejects.toThrow("4 MiB")
  })
})
