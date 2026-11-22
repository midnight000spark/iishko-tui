import { metadataId } from "./policy.js"
import type { Price } from "./site.js"

export type ModelEntries = Readonly<Record<string, unknown>>

export interface ModelLimit {
  readonly context: number
  readonly output: number
}

export interface MetadataConfig {
  readonly preferredProviders: readonly string[]
  /** Explicit aliases only; digit/version/size changes are not accepted. */
  readonly aliases: Readonly<Record<string, string>>
  /** Exact gateway IDs only: an override must not leak into another version. */
  readonly limitOverrides: Readonly<Record<string, ModelLimit>>
}

export const DEFAULT_METADATA_CONFIG: MetadataConfig = Object.freeze({
  preferredProviders: Object.freeze([
    "anthropic", "openai", "google", "deepseek", "xai", "zai", "alibaba",
    "moonshotai", "moonshotai-cn", "minimax", "minimax-cn", "nvidia", "mistral",
  ]),
  aliases: Object.freeze({ "gemini-3.8-flash-tiered": "gemini-3.8-flash" }),
  limitOverrides: Object.freeze({
    "glm-5.3-flash": Object.freeze({ context: 1_000_000, output: 131_072 }),
    "qwen4-max": Object.freeze({ context: 1_000_000, output: 262_144 }),
    "qwen3.8-max-0902": Object.freeze({ context: 1_000_000, output: 131_072 }),
  }),
})

interface Match {
  readonly provider: string
  readonly key: string
  readonly entry: Record<string, unknown>
  readonly stage: number
  readonly rank: number
}

interface LimitResolution {
  readonly limit?: ModelLimit
  readonly source: "override" | "vendor" | "mode" | "median" | "missing"
  readonly spread: number
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validLimit(value: unknown): value is ModelLimit {
  return record(value) && typeof value.context === "number" && typeof value.output === "number"
    && Number.isSafeInteger(value.context) && value.context > 0
    && Number.isSafeInteger(value.output) && value.output > 0
}

function aliasFor(model: string, config: MetadataConfig): string | undefined {
  const normalized = metadataId(model)
  const target = Object.hasOwn(config.aliases, normalized) ? config.aliases[normalized] : undefined
  if (!target) return undefined
  // Never turn a 30B model into an unsized model or drop a release number.
  const digits = (id: string) => metadataId(id).match(/\d+(?:\.\d+)?[a-z]*/g) ?? []
  return JSON.stringify(digits(normalized)) === JSON.stringify(digits(target)) ? target : undefined
}

function matches(model: string, catalog: unknown, config: MetadataConfig): readonly Match[] {
  if (!record(catalog)) return []
  const normalized = metadataId(model)
  const alias = aliasFor(model, config)
  return Object.entries(catalog).flatMap(([provider, info]) => {
    if (!record(info) || !record(info.models)) return []
    const preferred = config.preferredProviders.indexOf(provider)
    return Object.entries(info.models).flatMap(([key, entry]): Match[] => {
      if (!record(entry)) return []
      const ids = typeof entry.id === "string" ? [key, entry.id] : [key]
      const stage = ids.includes(model) ? 0
        : ids.some((id) => metadataId(id) === normalized) ? 1
          : alias && ids.some((id) => metadataId(id) === metadataId(alias)) ? 2 : -1
      if (stage < 0) return []
      return [{ provider, key, entry, stage, rank: preferred < 0 ? config.preferredProviders.length : preferred }]
    })
  }).sort((a, b) => a.stage - b.stage || a.rank - b.rank
    || compare(a.provider, b.provider) || compare(a.key, b.key))
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const lower = sorted[Math.floor((sorted.length - 1) / 2)] ?? 0
  const upper = sorted[Math.floor(sorted.length / 2)] ?? lower
  return Math.trunc(lower + (upper - lower) / 2)
}

function spreadOf(limits: readonly ModelLimit[]): number {
  const ratio = (values: readonly number[]) => {
    const min = values.reduce((a, b) => Math.min(a, b), Infinity)
    const max = values.reduce((a, b) => Math.max(a, b), 0)
    return max / min
  }
  return Math.max(ratio(limits.map((limit) => limit.context)), ratio(limits.map((limit) => limit.output)))
}

function secondary(limits: readonly ModelLimit[]): LimitResolution {
  const counts = new Map<string, { limit: ModelLimit; hits: number }>()
  for (const limit of limits) {
    const key = `${limit.context}/${limit.output}`
    counts.set(key, { limit, hits: (counts.get(key)?.hits ?? 0) + 1 })
  }
  const mode = [...counts.values()].sort((a, b) => b.hits - a.hits)[0]
  const spread = spreadOf(limits)
  if (mode && mode.hits >= 2) return { limit: mode.limit, source: "mode", spread }
  return {
    limit: { context: median(limits.map((l) => l.context)), output: median(limits.map((l) => l.output)) },
    source: "median", spread,
  }
}

function limits(model: string, rows: readonly Match[], config: MetadataConfig): LimitResolution {
  const fixed = Object.hasOwn(config.limitOverrides, model) ? config.limitOverrides[model] : undefined
  if (validLimit(fixed)) return { limit: fixed, source: "override", spread: 1 }
  const valid = rows.filter((row) => validLimit(row.entry.limit))
  // A normalized canonical vendor beats an exact secondary reseller, as in Python.
  const vendor = valid.find((row) => row.stage < 2 && row.rank < config.preferredProviders.length)
  if (vendor && validLimit(vendor.entry.limit)) return { limit: vendor.entry.limit, source: "vendor", spread: 1 }
  const stage = valid[0]?.stage
  if (stage === undefined) return { source: "missing", spread: 0 }
  const chosen = valid.filter((row) => row.stage === stage)
  // Explicit safe aliases are a last resort, not a substitute for real ID matches.
  const aliasedVendor = chosen.find((row) => row.rank < config.preferredProviders.length)
  if (stage === 2 && aliasedVendor && validLimit(aliasedVendor.entry.limit)) {
    return { limit: aliasedVendor.entry.limit, source: "vendor", spread: 1 }
  }
  return secondary(chosen.flatMap((row) => validLimit(row.entry.limit) ? [row.entry.limit] : []))
}

const BRANDS: Readonly<Record<string, string>> = {
  deepseek: "DeepSeek", glm: "GLM", gpt: "GPT", kimi: "Kimi", minimax: "MiniMax",
  qwen: "Qwen", nvidia: "NVIDIA", gemini: "Gemini",
}

function readable(model: string): string {
  return (model.split("/").at(-1) ?? model).replace(/[-_]+/g, " ").split(/\s+/)
    .map((word) => Object.hasOwn(BRANDS, word.toLowerCase()) ? BRANDS[word.toLowerCase()]
      : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(" ")
}

function priceNumber(value: string | null): number | undefined {
  if (typeof value !== "string") return undefined
  const text = value.trim()
  if (!/^\$?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)$/.test(text)) return undefined
  const number = Number(text.replace(/[$,]/g, ""))
  return Number.isFinite(number) && number >= 0 ? number : undefined
}

function cost(price: Price | undefined): { input: number; output: number } | undefined {
  if (!price || price.perCall !== null) return undefined
  const input = priceNumber(price.input)
  const output = priceNumber(price.output)
  return input === undefined || output === undefined ? undefined : { input, output }
}

function limitWarnings(model: string, resolution: LimitResolution): readonly string[] {
  if (!resolution.limit) return [`${model}: limit.context/output missing from models.dev`]
  return [
    ...(["mode", "median"].includes(resolution.source)
      ? [`${model}: secondary models.dev limit source (${resolution.source})`] : []),
    ...(resolution.spread > 2 ? [`${model}: limit sources spread ${resolution.spread.toFixed(1)}x`] : []),
  ]
}

/** Enrich missing fields only. Does not infer tools, capabilities, or media token costs. */
export function renderModels(
  ids: readonly string[],
  old: ModelEntries,
  catalog: unknown,
  prices?: ReadonlyMap<string, Price>,
  config: MetadataConfig = DEFAULT_METADATA_CONFIG,
): { models: Record<string, unknown>; warnings: readonly string[] } {
  const warnings: string[] = []
  const entries = ids.map((model): [string, unknown] => {
    if (/[{}\u0000-\u001f\u007f-\u009f]/u.test(model)) throw new Error("Недопустимый идентификатор модели.")
    const existing = Object.hasOwn(old, model) ? old[model] : undefined
    if (Object.hasOwn(old, model) && !record(existing)) {
      warnings.push(`${model}: existing non-object metadata preserved unchanged`)
      return [model, structuredClone(existing)]
    }
    const entry: Record<string, unknown> = record(existing) ? structuredClone(existing) : {}
    const rows = matches(model, catalog, config)
    if (!Object.hasOwn(entry, "name")) {
      const name = rows[0]?.entry.name
      entry.name = typeof name === "string" && name.trim() && name.length <= 512
        && !/[{}\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(name) ? name : readable(model)
    }
    if (!Object.hasOwn(entry, "limit")) {
      const resolution = limits(model, rows, config)
      if (resolution.limit) entry.limit = { context: resolution.limit.context, output: resolution.limit.output }
      warnings.push(...limitWarnings(model, resolution))
    }
    if (!Object.hasOwn(entry, "cost")) {
      const fresh = cost(prices?.get(model))
      if (fresh) entry.cost = fresh
    }
    return [model, entry]
  })
  return { models: Object.fromEntries(entries), warnings }
}
