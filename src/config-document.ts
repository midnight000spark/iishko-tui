import { Buffer } from "node:buffer"
import { isDeepStrictEqual } from "node:util"
import { createScanner, findNodeAtLocation, getNodeValue, parseTree } from "jsonc-parser"
import type { Node, ParseError } from "jsonc-parser"

export const MAX_CONFIG_BYTES = 4 * 1024 * 1024
export const MAX_CONFIG_DEPTH = 64
const MAX_NODES = 200_000
const MAX_STRING_LENGTH = 256 * 1024
const MAX_MODELS = 10_000
// jsonc-parser 3.3.1 declares an ambient const enum, incompatible with verbatimModuleSyntax.
const TOKEN = { openBrace: 1, closeBrace: 2, openBracket: 3, closeBracket: 4, eof: 17 } as const

export interface ConfigDocument {
  value: Record<string, unknown>
  /** Offsets refer to the original text, including its optional BOM. */
  tree: Node
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function bounds(text: string): void {
  if (Buffer.byteLength(text, "utf8") > MAX_CONFIG_BYTES) throw new Error("Config exceeds size limit")
  const scanner = createScanner(text, true)
  let depth = 0
  let tokens = 0
  for (let token = scanner.scan(); token !== TOKEN.eof; token = scanner.scan()) {
    if (++tokens > MAX_NODES * 4) throw new Error("Config exceeds complexity limit")
    if (scanner.getTokenLength() > MAX_STRING_LENGTH) throw new Error("Config token exceeds size limit")
    if (token === TOKEN.openBrace || token === TOKEN.openBracket) depth++
    if (depth > MAX_CONFIG_DEPTH) throw new Error("Config exceeds depth limit")
    if (token === TOKEN.closeBrace || token === TOKEN.closeBracket) depth--
  }
}

function inspect(tree: Node): void {
  const stack = [tree]
  let count = 0
  while (stack.length) {
    const node = stack.pop()!
    if (++count > MAX_NODES) throw new Error("Config exceeds complexity limit")
    if (node.type === "number" && !Number.isFinite(node.value)) throw new Error("Config has invalid number")
    if (node.type === "object") {
      const keys = new Set<string>()
      for (const property of node.children ?? []) {
        const key: unknown = property.children?.[0]?.value
        if (typeof key !== "string" || keys.has(key)) throw new Error("Config has duplicate object keys")
        keys.add(key)
      }
    }
    stack.push(...(node.children ?? []))
  }
}

/** Fault-tolerant JSONC parsing is deliberately converted into fail-closed parsing. */
export function parseConfig(text: string): ConfigDocument {
  // Replacing rather than removing the BOM preserves all source offsets.
  const source = text.startsWith("\uFEFF") ? ` ${text.slice(1)}` : text
  bounds(source)
  const errors: ParseError[] = []
  const tree = parseTree(source, errors, { allowTrailingComma: true, allowEmptyContent: false })
  if (errors.length || !tree || tree.type !== "object") throw new Error("Invalid JSONC config")
  inspect(tree)
  const value: unknown = getNodeValue(tree)
  if (!isRecord(value)) throw new Error("Config must be an object")
  return { value, tree }
}

function entries(document: ConfigDocument, providerID: string): Record<string, unknown> {
  if (!providerID || providerID.length > 1024) throw new Error("Invalid provider identifier")
  const providers = document.value.providers
  const provider = isRecord(providers) && Object.hasOwn(providers, providerID) ? providers[providerID] : undefined
  if (!isRecord(provider) || !isRecord(provider.models)) throw new Error("Existing provider models object required")
  const target = findNodeAtLocation(document.tree, ["providers", providerID, "models"])
  const nodes = target ? [target] : []
  while (nodes.length) {
    const node = nodes.pop()!
    if (node.type === "number" && Number.isInteger(node.value) && !Number.isSafeInteger(node.value)) {
      throw new Error("Model metadata contains an integer outside the exact supported range")
    }
    nodes.push(...(node.children ?? []))
  }
  if (Object.keys(provider.models).length > MAX_MODELS) throw new Error("Too many configured models")
  return provider.models
}

export function modelEntries(text: string, providerID: string): Record<string, unknown> {
  return entries(parseConfig(text), providerID)
}

function jsonValue(value: unknown, depth = 0, ancestors = new Set<object>()): void {
  if (depth > MAX_CONFIG_DEPTH) throw new Error("Models exceed depth limit")
  if (value === null || typeof value === "string" || typeof value === "boolean") return
  if (typeof value === "number" && Number.isFinite(value)) return
  if (typeof value !== "object" || value === null || ancestors.has(value)) throw new Error("Models must be JSON values")
  const prototype: unknown = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && prototype !== null && prototype !== Object.prototype) throw new Error("Models must be plain JSON values")
  const next = new Set(ancestors).add(value)
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable) continue
    if (!("value" in descriptor)) throw new Error("Models cannot contain accessors")
    jsonValue(descriptor.value, depth + 1, next)
  }
}

function unrelated(value: Record<string, unknown>, providerID: string): unknown {
  const providers = value.providers as Record<string, unknown>
  const provider = providers[providerID] as Record<string, unknown>
  return { ...value, providers: { ...providers, [providerID]: { ...provider, models: null } } }
}

/** Only the existing models value span is replaced; no surrounding byte is reformatted. */
export function replaceModels(text: string, providerID: string, models: Record<string, unknown>): string {
  const document = parseConfig(text)
  entries(document, providerID)
  if (!isRecord(models) || Object.keys(models).length > MAX_MODELS) throw new Error("Invalid models object")
  jsonValue(models)
  const replacement = JSON.stringify(models, null, 2).replace(/\n/g, text.includes("\r\n") ? "\r\n" : "\n")
  const node = findNodeAtLocation(document.tree, ["providers", providerID, "models"])
  if (!node || node.type !== "object") throw new Error("Existing models span required")
  const after = text.slice(0, node.offset) + replacement + text.slice(node.offset + node.length)
  const checked = parseConfig(after)
  if (!isDeepStrictEqual(unrelated(document.value, providerID), unrelated(checked.value, providerID))) {
    throw new Error("Unrelated config fields changed")
  }
  if (JSON.stringify(entries(checked, providerID)) !== JSON.stringify(models)) throw new Error("Models changed during serialization")
  return after
}
