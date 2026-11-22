import { describe, expect, test } from "bun:test"
import { findNodeAtLocation } from "jsonc-parser"
import { MAX_CONFIG_BYTES, MAX_CONFIG_DEPTH, modelEntries, parseConfig, replaceModels } from "./config-document.js"

describe("config document", () => {
  test("replaces exact value span with BOM, CRLF and comments preserved", () => {
    const before = '\uFEFF{\r\n// keep\r\n"providers": {"account": {"settings":{"apiKey":"fixture-only"}, "models": /*before*/ {"old":{},}, /*after*/ "name":"keep"}},\r\n"other": [1,2,],\r\n}\r\n'
    const node = findNodeAtLocation(parseConfig(before).tree, ["providers", "account", "models"])!
    const after = replaceModels(before, "account", { next: { limit: { context: 123 } } })
    expect(after.startsWith(before.slice(0, node.offset))).toBe(true)
    expect(after.endsWith(before.slice(node.offset + node.length))).toBe(true)
    expect(after.replace(/\r\n/g, "")).not.toContain("\n")
    expect(modelEntries(after, "account")).toEqual({ next: { limit: { context: 123 } } })
    expect(parseConfig(after).value.other).toEqual([1, 2])
  })

  test.each([
    '{"x":1,"x":2}',
    '{"array":[{"x":1,"\\u0078":2}]}',
    '{"providers":{"a":{"models":{"m":{"limit":1,"limit":2}}}}}',
    '{"x":1} trailing', '{"x":}', '{/* unterminated', '[]', '', '{"x":1e999}',
  ])("rejects malformed/ambiguous JSONC without including contents: %s", (text) => {
    expect(() => parseConfig(text)).toThrow()
  })

  test("rejects excessive size and depth before recursive parsing", () => {
    expect(() => parseConfig(`{"x":"${"a".repeat(MAX_CONFIG_BYTES)}"}`)).toThrow("size")
    expect(() => parseConfig(`{"x":${"[".repeat(MAX_CONFIG_DEPTH)}0${"]".repeat(MAX_CONFIG_DEPTH)}}`)).toThrow("depth")
  })

  test("treats special keys as own JSON data, not prototypes", () => {
    const text = '{"providers":{"__proto__":{"models":{"constructor":{}}}}}'
    expect(Object.keys(modelEntries(text, "__proto__"))).toEqual(["constructor"])
    expect(() => modelEntries('{"providers":{}}', "__proto__")).toThrow()
  })

  test("never inserts missing provider/models or serializes lossy values", () => {
    expect(() => replaceModels('{"providers":{"a":{}}}', "a", {})).toThrow()
    expect(() => modelEntries('{"provider":{"a":{"models":{}}}}', "a")).toThrow()
    const before = '{"providers":{"a":{"models":{}}}}'
    expect(() => replaceModels(before, "a", { bad: undefined })).toThrow()
    expect(() => replaceModels(before, "a", { bad: NaN })).toThrow()
    expect(() => replaceModels(before, "a", { bad: new Date() })).toThrow()
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => replaceModels(before, "a", cyclic)).toThrow()
  })

  test("refuses unsafe integer metadata rather than rounding existing custom values", () => {
    const text = '{"providers":{"a":{"models":{"m":{"custom":9007199254740993}}}}}'
    expect(() => modelEntries(text, "a")).toThrow("exact supported range")
    expect(() => replaceModels(text, "a", { m: {} })).toThrow("exact supported range")
  })
})
