/** Pure public-site refresh planning. No network, config paths, or writes. */
import { renderModels } from "./metadata.js"
import type { Plan, PlanEvidence, RemovedGroups } from "./plan.js"
import { candidate, DEFAULT_POLICY, type CandidatePolicy } from "./policy.js"
import { RANKS, SITE_STATES, type Catalog, type CatalogModel, type Rank, type RankPriority } from "./site.js"

export type RefreshMode = "full" | "add"

export interface RefreshPlan extends Plan {
  readonly providerID: string
  readonly rank: Rank
  readonly mode: RefreshMode
  /** Public status timestamp, in Unix seconds. */
  readonly updated: number
  readonly priority: RankPriority
  readonly evidence: PlanEvidence & { readonly priority: RankPriority }
}

export interface RefreshInput {
  readonly catalog: Catalog
  readonly existing: Readonly<Record<string, unknown>>
  readonly providerID: string
  readonly rank: Rank
  readonly mode: RefreshMode
  /** Records the priority already used to resolve catalog ranks; does not re-resolve them. */
  readonly priority?: RankPriority
  readonly policy?: CandidatePolicy
  readonly metadata?: unknown
  /** Current time in epoch milliseconds; inject for deterministic tests. */
  readonly now?: number
  /** Explicit opt-in only, after the controller has obtained complete fresh status. */
  readonly allowUnlistedRemoval?: boolean
}

const MAX_MODELS = 10_000
const MAX_AGE_MS = 60 * 60_000
const MAX_FUTURE_MS = 5 * 60_000
const STATES = [...SITE_STATES, "unmeasured", "unlisted"] as const

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validID(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    && !/[\s\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f<>{}"'\\]/u.test(value)
}

function isCatalogModel(value: unknown): value is CatalogModel {
  if (!record(value) || !validID(value.id) || typeof value.state !== "string"
    || !STATES.some((state) => state === value.state)
    || typeof value.kind !== "string" || !["chat", "image", "video", "other"].includes(value.kind)
    || typeof value.rankSource !== "string" || !["catalog", "api", "both", "unknown"].includes(value.rankSource)
    || !Array.isArray(value.ranks) || !value.ranks.every((rank: unknown) => RANKS.some((known) => known === rank))) return false
  const nullableNumber = (item: unknown) => item === null || typeof item === "number"
  return typeof value.lab === "string" && typeof value.bars === "string"
    && typeof value.configured === "boolean" && typeof value.ranksConflict === "boolean"
    && [value.checkedAt, value.latencyMs, value.uptime1h, value.uptime24h, value.probes1h].every(nullableNumber)
    && record(value.price) && [value.price.input, value.price.output, value.price.perCall]
      .every((item) => item === null || typeof item === "string")
}

function validate(input: RefreshInput): Map<string, CatalogModel> {
  if (!validID(input.providerID) || !RANKS.includes(input.rank)
    || !["full", "add"].includes(input.mode)
    || (input.priority !== undefined && !["site", "conservative"].includes(input.priority))) {
    throw new Error("Invalid refresh provider, rank, mode, or priority")
  }
  const now = input.now ?? Date.now()
  const age = now - input.catalog.updated * 1000
  if (!Number.isFinite(now) || now <= 0 || !Number.isFinite(input.catalog.updated)
    || input.catalog.updated <= 0 || !Number.isFinite(age) || age > MAX_AGE_MS || age < -MAX_FUTURE_MS) {
    throw new Error("Public status timestamp is invalid or stale")
  }
  if (!record(input.existing) || !Array.isArray(input.catalog.models)
    || input.catalog.models.length === 0 || input.catalog.models.length > MAX_MODELS
    || Object.keys(input.existing).length > MAX_MODELS) {
    throw new Error("Refresh requires a nonempty, bounded status catalog")
  }
  const byID = new Map<string, CatalogModel>()
  for (const row of input.catalog.models) {
    if (!isCatalogModel(row)) {
      throw new Error("Incomplete or invalid public status row")
    }
    if (byID.has(row.id)) throw new Error("Duplicate public status model ID")
    byID.set(row.id, row)
  }
  if (!input.catalog.models.some((row) => row.state !== "unmeasured" && row.state !== "unlisted")) {
    throw new Error("Public status has no measured models")
  }
  // A direct caller must not silently truncate rows while retaining source counts.
  if (!record(input.catalog.counts) || STATES.some((state) => input.catalog.counts[state]
    !== input.catalog.models.filter((row) => row.state === state).length)) {
    throw new Error("Incomplete public status counts")
  }
  if (Object.keys(input.existing).some((id) => !validID(id))) throw new Error("Invalid configured model ID")
  return byID
}

function protectedEntry(id: string, entry: unknown): boolean {
  return !record(entry) || entry.disabled === true || entry.enabled === false
    || (Object.hasOwn(entry, "modelID") && entry.modelID !== id)
    || Object.hasOwn(entry, "package") || Object.hasOwn(entry, "headers") || Object.hasOwn(entry, "body")
    || Object.hasOwn(entry, "compatibility") || Object.hasOwn(entry, "variants")
    || (record(entry.settings) && (Object.hasOwn(entry.settings, "baseURL") || Object.hasOwn(entry.settings, "apiKey")))
}

function removable(row: CatalogModel): boolean {
  return row.kind === "chat" && row.state === "down"
    && typeof row.uptime24h === "number" && Number.isFinite(row.uptime24h)
    && row.uptime24h >= 0 && row.uptime24h <= 10
    && typeof row.bars === "string" && row.bars.length <= 24 && /^[uds-]+$/.test(row.bars)
    && [...row.bars].filter((bar) => bar === "d").length >= 12
}

function removal(
  id: string, row: CatalogModel | undefined, input: RefreshInput, policy: CandidatePolicy,
): keyof RemovedGroups | undefined {
  if (input.mode === "add" || protectedEntry(id, input.existing[id])) return undefined
  if (policy.alwaysDrop?.includes(id)) return "forced"
  if (policy.alwaysKeep?.includes(id)) return undefined
  if (!row || row.state === "unlisted") return input.allowUnlistedRemoval === true ? "unlisted" : undefined
  return removable(row) ? "failed" : undefined
}

function freeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value
  seen.add(value)
  Object.values(value).forEach((child) => freeze(child, seen))
  return Object.freeze(value)
}

/** Build an immutable preview; callers must reject stale loader fallbacks before calling. */
export function buildRefreshPlan(input: RefreshInput): {
  plan: RefreshPlan; models: Record<string, unknown>; warnings: readonly string[]
} {
  const byID = validate(input)
  const policy = input.policy ?? DEFAULT_POLICY
  for (const id of policy.alwaysKeep ?? []) {
    if (!Object.hasOwn(input.existing, id) && (!byID.has(id) || byID.get(id)?.state === "unlisted")) {
      throw new Error("New alwaysKeep model lacks public status evidence")
    }
  }
  const available = input.catalog.models.filter((row) => row.kind === "chat" && row.state === "up"
    && candidate(row.id, policy))
  const eligible = new Set(available.filter((row) => row.rankSource !== "unknown"
    && row.ranks.includes(input.rank)).map((row) => row.id))
  const rankUnknown = available.filter((row) => row.rankSource === "unknown"
    && !Object.hasOwn(input.existing, row.id)).map((row) => row.id).sort()
  const removed = { failed: [] as string[], unlisted: [] as string[], forced: [] as string[] }
  const keptUncertain: string[] = []
  const warnings: string[] = []
  const kept = Object.keys(input.existing).filter((id) => {
    const row = byID.get(id)
    const reason = removal(id, row, input, policy)
    if (reason) {
      removed[reason].push(id)
      return false
    }
    if (protectedEntry(id, input.existing[id])) warnings.push(`${id}: disabled, alias, or custom entry preserved unchanged`)
    if (protectedEntry(id, input.existing[id]) || (input.mode === "add" ? !eligible.has(id) : row?.state !== "up")) {
      keptUncertain.push(id)
    }
    return true
  })
  const add = [...eligible].filter((id) => !Object.hasOwn(input.existing, id)).sort()
  const models = [...kept, ...add].sort()
  if (models.length === 0) throw new Error("Empty refresh plan refused")
  if (models.length > MAX_MODELS) throw new Error("Refresh model limit exceeded")
  const remove = Object.values(removed).flat().sort()
  if (remove.length > 0 && !input.catalog.models.some((row) => row.state === "up")) {
    throw new Error("All-down public status cannot authorize removals")
  }
  Object.values(removed).forEach((group) => group.sort())
  const priority = input.priority ?? "site"
  const plan: RefreshPlan = {
    models, add, remove, keptUncertain: keptUncertain.sort(), rankUnknown, removed,
    providerID: input.providerID, rank: input.rank, mode: input.mode, updated: input.catalog.updated, priority,
    evidence: { source: "site", mode: input.mode, rank: input.rank, provider: input.providerID,
      pruneUnlisted: input.mode === "full" && input.allowUnlistedRemoval === true, priority },
  }
  const renderIDs = models.filter((id) => !Object.hasOwn(input.existing, id)
    || !protectedEntry(id, input.existing[id]))
  const rendered = renderModels(renderIDs, input.existing, input.metadata,
    new Map(input.catalog.models.map((row) => [row.id, row.price])))
  // Do not enrich an alias with metadata/prices belonging to its config key.
  const entries = models.map((id): [string, unknown] => [id,
    Object.hasOwn(input.existing, id) && protectedEntry(id, input.existing[id])
      ? structuredClone(input.existing[id]) : rendered.models[id]])
  return freeze({ plan, models: Object.fromEntries(entries), warnings: [...warnings, ...rendered.warnings] })
}
