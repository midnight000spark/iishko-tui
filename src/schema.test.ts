import { describe, expect, test } from "bun:test"
import { createSchemaValidator } from "./schema.js"

describe("schema validation", () => {
  test.each([
    "http://json-schema.org/draft-07/schema#",
    "https://json-schema.org/draft/2019-09/schema",
    "https://json-schema.org/draft/2020-12/schema",
  ])("validates explicit dialect %s using local definitions", ($schema) => {
    const validate = createSchemaValidator({
      $schema,
      type: "object",
      definitions: { models: { type: "object", additionalProperties: { type: "object" } } },
      properties: { providers: { type: "object", additionalProperties: {
        type: "object", properties: { models: { $ref: "#/definitions/models" } }, required: ["models"],
      } } },
      required: ["providers"],
    })
    expect(() => validate({ providers: { account: { models: { example: {} } } } })).not.toThrow()
    expect(() => validate({ providers: { account: { models: [] } } })).toThrow("проверку схемы")
  })

  test("defaults to 2020-12 rather than silently ignoring modern constraints", () => {
    const validate = createSchemaValidator({ type: "object", properties: { kept: { type: "string" } }, unevaluatedProperties: false })
    expect(() => validate({ kept: "yes" })).not.toThrow()
    expect(() => validate({ unexpected: true })).toThrow()
  })

  test("installs formats", () => {
    const validate = createSchemaValidator({ type: "string", format: "email" })
    expect(() => validate("example@example.org")).not.toThrow()
    expect(() => validate("not-an-email")).toThrow()
  })

  test("does not coerce, default, remove properties or mutate frozen input", () => {
    const validate = createSchemaValidator({
      type: "object", properties: { count: { type: "integer", default: 5 } }, additionalProperties: false,
    })
    const absent = Object.freeze({})
    expect(() => validate(absent)).not.toThrow()
    expect(absent).toEqual({})
    const string = Object.freeze({ count: "5" })
    expect(() => validate(string)).toThrow()
    expect(string.count).toBe("5")
    const extra = Object.freeze({ extra: true })
    expect(() => validate(extra)).toThrow()
    expect(extra).toEqual({ extra: true })
  })

  test("keeps compiled schema independent of caller mutations", () => {
    const schema = { type: "string" }
    const validate = createSchemaValidator(schema)
    schema.type = "number"
    expect(() => validate("still a string")).not.toThrow()
    expect(() => validate(1)).toThrow()
  })

  test.each([
    { $ref: "https://example.invalid/schema" },
    { $ref: "file:///private/config.json" },
    { $ref: "relative-schema.json" },
    { $dynamicRef: "https://example.invalid/schema#anchor" },
    { $recursiveRef: "other.json#" },
    { $ref: "#/missing" },
    { $async: true, type: "string" },
    { $schema: "https://example.invalid/custom-dialect" },
    { type: 123 },
    null, [], "not a schema",
  ].map((schema) => ({ schema })))("refuses unsupported schemas or references without I/O: %j", ({ schema }) => {
    expect(() => createSchemaValidator(schema)).toThrow("Запись запрещена")
  })

  test("supports boolean schemas", () => {
    expect(() => createSchemaValidator(true)({})).not.toThrow()
    expect(() => createSchemaValidator(false)({})).toThrow()
  })

  test("resolves only the separately supplied fixed official model schema", () => {
    const root = { $ref: "https://models.dev/model-schema.json#/$defs/Model" }
    const model = { $id: "https://models.dev/model-schema.json", $defs: { Model: { type: "string" } } }
    expect(() => createSchemaValidator(root)).toThrow()
    const validate = createSchemaValidator(root, model)
    expect(() => validate("model")).not.toThrow()
    expect(() => validate(42)).toThrow()
    expect(() => createSchemaValidator(root, { ...model, $id: "https://evil.example/schema" })).toThrow()
    expect(() => createSchemaValidator(root, { ...model, $ref: "https://evil.example/schema" })).toThrow()
  })

  test("bounds schema and value complexity and rejects executable accessors", () => {
    expect(() => createSchemaValidator({ description: "x".repeat(4 * 1024 * 1024 + 1) })).toThrow()
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expect(() => createSchemaValidator(cycle)).toThrow()
    const validate = createSchemaValidator(true)
    expect(() => validate(cycle)).toThrow()
    let deep: unknown = null
    for (let index = 0; index < 66; index++) deep = { nested: deep }
    expect(() => validate(deep)).toThrow()
    let invoked = false
    const accessor = Object.defineProperty({}, "secret", { enumerable: true, get() { invoked = true; return "hidden" } })
    expect(() => createSchemaValidator(accessor)).toThrow()
    expect(() => validate(accessor)).toThrow()
    expect(invoked).toBe(false)
  })

  test("diagnostics contain neither values nor secret-like property paths/schema details", () => {
    const secret = "fixture-sensitive-value"
    const validate = createSchemaValidator({
      type: "object", properties: { [secret]: { type: "string", const: "another-sensitive-value" } },
    })
    let message = ""
    try { validate({ [secret]: secret }) } catch (error) { message = String(error) }
    expect(message).toContain("Запись отменена")
    expect(message).not.toContain(secret)
    expect(message).not.toContain("another-sensitive-value")
    expect(() => createSchemaValidator({ $ref: `https://example.invalid/${secret}` })).toThrow("Запись запрещена")
  })
})
