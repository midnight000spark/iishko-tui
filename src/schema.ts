import { Buffer } from "node:buffer"
import Ajv from "ajv"
import Ajv2019 from "ajv/dist/2019.js"
import Ajv2020 from "ajv/dist/2020.js"
import addFormats from "ajv-formats"
import type { AnySchema, Options } from "ajv"

const MAX_BYTES = 4 * 1024 * 1024
const MAX_DEPTH = 64
const MAX_NODES = 200_000
export const MODEL_SCHEMA_ID = "https://models.dev/model-schema.json"
const OPTIONS: Options = {
  strict: false,
  allErrors: false,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
  validateFormats: true,
  messages: false,
  verbose: false,
  logger: false,
}

/** Bound unknown inputs before Ajv recursion; never invoke accessors or toJSON. */
function inspect(value: unknown, schema: boolean, allowModelRef = false): void {
  const active = new Set<object>()
  let nodes = 0
  let bytes = 0
  function visit(item: unknown, depth: number): void {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw new Error("limit")
    if (typeof item === "string") bytes += Buffer.byteLength(item, "utf8")
    else if (item === null || typeof item === "boolean") bytes += 5
    else if (typeof item === "number" && Number.isFinite(item)) bytes += 24
    else if (typeof item === "object" && item !== null) {
      const prototype: unknown = Object.getPrototypeOf(item)
      if (active.has(item) || (!Array.isArray(item) && prototype !== null && prototype !== Object.prototype)) {
        throw new Error("json")
      }
      active.add(item)
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
        if (!descriptor.enumerable) continue
        if (!("value" in descriptor)) throw new Error("accessor")
        bytes += Buffer.byteLength(key, "utf8") + 4
        if (schema && key === "$async") throw new Error("async")
        if (schema && ["$ref", "$dynamicRef", "$recursiveRef"].includes(key)) {
          const reference: unknown = descriptor.value
          if (typeof reference !== "string" || (!reference.startsWith("#")
            && !(allowModelRef && reference.startsWith(`${MODEL_SCHEMA_ID}#`)))) throw new Error("reference")
        }
        visit(descriptor.value, depth + 1)
      }
      active.delete(item)
    } else throw new Error("json")
    if (bytes > MAX_BYTES) throw new Error("limit")
  }
  visit(value, 0)
}

function dialect(schema: AnySchema): typeof Ajv | typeof Ajv2019 | typeof Ajv2020 {
  const uri: unknown = typeof schema === "object" ? schema.$schema : undefined
  // Modern official schemas may omit the annotation; the default is draft 2020-12.
  if (uri === undefined || uri === "https://json-schema.org/draft/2020-12/schema" || uri === "https://json-schema.org/draft/2020-12/schema#") return Ajv2020
  if (uri === "https://json-schema.org/draft/2019-09/schema" || uri === "https://json-schema.org/draft/2019-09/schema#") return Ajv2019
  if (uri === "http://json-schema.org/draft-07/schema#" || uri === "http://json-schema.org/draft-07/schema") return Ajv
  throw new Error("dialect")
}

/** Compile an injected trusted schema without remote resolution or config mutation.
 * Deliberately omit Ajv diagnostics: even property paths and enum parameters can be secrets.
 */
export function createSchemaValidator(schema: unknown, modelSchema?: unknown): (value: unknown) => void {
  try {
    inspect(schema, true, modelSchema !== undefined)
    if (typeof schema !== "boolean" && (typeof schema !== "object" || schema === null || Array.isArray(schema))) {
      throw new Error("schema")
    }
    // Keep Ajv's internal schema cache independent of later caller mutations.
    const copy = JSON.parse(JSON.stringify(schema)) as AnySchema
    const Constructor = dialect(copy)
    const ajv = new Constructor({ ...OPTIONS })
    addFormats(ajv)
    if (modelSchema !== undefined) {
      inspect(modelSchema, true)
      if (typeof modelSchema !== "object" || modelSchema === null || Array.isArray(modelSchema)
        || !("$id" in modelSchema) || modelSchema.$id !== MODEL_SCHEMA_ID) throw new Error("dependency")
      ajv.addSchema(JSON.parse(JSON.stringify(modelSchema)) as AnySchema, MODEL_SCHEMA_ID)
    }
    const validate = ajv.compile(copy)
    return (value: unknown): void => {
      try {
        inspect(value, false)
        if (validate(value) !== true) throw new Error("invalid")
      } catch {
        throw new Error("Конфигурация не прошла проверку схемы. Запись отменена.")
      }
    }
  } catch {
    throw new Error("Не удалось подготовить проверку схемы. Запись запрещена.")
  }
}
