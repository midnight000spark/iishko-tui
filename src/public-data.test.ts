import { describe, expect, test } from "bun:test"
import { createPublicData } from "./public-data.js"

describe("public supporting documents", () => {
  test("uses fixed credentials-free endpoints and caches metadata", async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const http = async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response('{"fixture":true}')
    }
    const data = createPublicData(http)
    expect(await data.load("metadata")).toEqual({ fixture: true })
    await data.load("metadata")
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe("https://models.dev/api.json")
    expect(calls[0]?.init?.credentials).toBe("omit")
    expect(calls[0]?.init?.redirect).toBe("error")
  })

  test("schema failure never uses an indefinitely stale cache", async () => {
    let now = 10
    let fail = false
    const http = async () => fail ? new Response("", { status: 503 }) : new Response('{}')
    const data = createPublicData(http, () => now)
    await data.load("schema")
    now += 61 * 60_000
    fail = true
    await expect(data.load("schema")).rejects.toThrow("503")
  })

  test("malformed JSON, oversized response and cancellation reject", async () => {
    const malformed = createPublicData(async () => new Response("invalid"))
    await expect(malformed.load("schema")).rejects.toThrow("JSON")
    const oversized = createPublicData(async () => new Response("", { headers: { "content-length": String(5 * 1024 * 1024) } }))
    await expect(oversized.load("schema")).rejects.toThrow("большой")
    await expect(malformed.load("metadata", AbortSignal.abort())).rejects.toThrow()
  })
})
