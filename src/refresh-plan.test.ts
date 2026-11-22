import { describe, expect, test } from "bun:test"
import { DEFAULT_POLICY } from "./policy.js"
import { buildRefreshPlan, type RefreshInput } from "./refresh-plan.js"
import { mergeCatalog, type CatalogModel, type RankResolution } from "./site.js"

const NOW = 1_795_305_600_000
const UPDATED = NOW / 1000

function row(id: string, extra: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id, lab: "test", kind: "chat", state: "up", checkedAt: UPDATED,
    latencyMs: 100, uptime1h: 99, uptime24h: 97, probes1h: 60, bars: "u".repeat(24),
    price: { input: null, output: null, perCall: null }, ranks: ["t3"],
    rankSource: "catalog", ranksConflict: false, configured: false, ...extra,
  }
}

function input(rows: readonly CatalogModel[], extra: Partial<RefreshInput> = {}): RefreshInput {
  const counts = { up: 0, busy: 0, down: 0, unknown: 0, unmeasured: 0, unlisted: 0 }
  rows.forEach((model) => { counts[model.state] += 1 })
  return {
    catalog: { updated: UPDATED, overall: "up", uptime: { h1: 99, d24: 97 },
      medianLatencyMs: 100, counts, models: rows },
    existing: {}, providerID: "gateway", rank: "t3", mode: "full", now: NOW, ...extra,
  }
}

function parity(): RefreshInput {
  const rows = [
    row("qwen3.8-flash"), row("qwen3.7-max"),
    row("glm-5.3-flash", { rankSource: "unknown", ranks: [] }),
    row("grok-4.7", { state: "down", uptime24h: 62, bars: "u".repeat(20) + "dddd" }),
    row("glm-5.3-prime", { state: "down", uptime24h: 0, bars: "d".repeat(24) }),
    row("claude-opus-5-5", { state: "busy", uptime24h: 2, bars: "d" + "s".repeat(23) }),
    row("qwen3.8-max-0902"), row("qwen4-max", { ranks: ["t2"] }),
    row("zai-org/GLM-5.3", { state: "unmeasured", kind: "other" }),
  ]
  const existing = Object.fromEntries([
    "qwen3.8-flash", "qwen3.7-max", "grok-4.7", "glm-5.3-prime", "claude-opus-5-5", "ghost-model",
  ].map((id) => [id, { name: id }]))
  return input(rows, { existing, allowUnlistedRemoval: true })
}

describe("buildRefreshPlan parity", () => {
  test("full preserves working policy/rank outsiders and removes only evidenced failures/unlisted", () => {
    const { plan } = buildRefreshPlan(parity())
    expect(plan.add).toEqual(["qwen3.8-max-0902"])
    expect(plan.rankUnknown).toEqual(["glm-5.3-flash"])
    expect(plan.removed).toEqual({ failed: ["glm-5.3-prime"], unlisted: ["ghost-model"], forced: [] })
    expect(plan.keptUncertain).toEqual(["claude-opus-5-5", "grok-4.7"])
    expect(plan.models).toContain("qwen3.7-max")
    expect(plan.models).not.toContain("qwen4-max")
    expect(plan.evidence).toEqual({ source: "site", mode: "full", rank: "t3",
      provider: "gateway", pruneUnlisted: true, priority: "site" })
  })

  test("add never removes and records the catalog's already-resolved rank priority", () => {
    const result = buildRefreshPlan({ ...parity(), rank: "t2", mode: "add", priority: "conservative" })
    expect(result.plan.add).toEqual(["qwen4-max"])
    expect(result.plan.remove).toEqual([])
    expect(result.plan.models).toContain("ghost-model")
    expect(result.plan.evidence.pruneUnlisted).toBe(false)
    expect(result.plan.evidence.priority).toBe("conservative")
  })

  test("unknown ranks never add, and authoritative empty ranks are denial rather than unknown", () => {
    const result = buildRefreshPlan(input([
      row("qwen4-max", { ranks: [], rankSource: "unknown" }),
      row("glm-5.3", { ranks: [] }), row("kimi-k3", { ranks: ["t2"] }), row("gpt-6.1-sol"),
    ]))
    expect(result.plan.models).toEqual(["gpt-6.1-sol"])
    expect(result.plan.rankUnknown).toEqual(["qwen4-max"])
  })

  test("current up models outside policy or rank are not uncertain in full mode", () => {
    const result = buildRefreshPlan(input([row("qwen3.7-max"), row("qwen4-max", { ranks: ["t1"] })], {
      existing: { "qwen3.7-max": {}, "qwen4-max": {} },
    }))
    expect(result.plan.remove).toEqual([])
    expect(result.plan.keptUncertain).toEqual([])
  })
})

describe("buildRefreshPlan conservative removal", () => {
  test("preserves models with separate routing, runtime or variants even when gateway says down or unlisted", () => {
    const entries = [
      { settings: { baseURL: "https://other.example/v1" } },
      { package: "custom-runtime" },
      { variants: [{ id: "route", settings: { baseURL: "https://other.example/v1" } }] },
    ]
    for (const entry of entries) {
      for (const state of ["down", "unlisted"] as const) {
        const result = buildRefreshPlan(input([row("qwen4-max", { state, uptime24h: 0, bars: "d".repeat(24) }), row("glm-5.3-flash")], {
          existing: { "qwen4-max": entry }, allowUnlistedRemoval: true,
        }))
        expect(result.plan.remove).toEqual([])
        expect(result.models["qwen4-max"]).toEqual(entry)
      }
    }
  })
  test("only chat down with valid uptime <=10 and at least twelve failed bars is removable", () => {
    const cases: Partial<CatalogModel>[] = [
      { uptime24h: null }, { uptime24h: NaN }, { uptime24h: Infinity }, { uptime24h: -1 },
      { uptime24h: 10.01 }, { bars: "d".repeat(11) }, { bars: "d".repeat(12) + "x" },
      { bars: "d".repeat(25) }, { state: "busy" }, { state: "unknown" },
      { state: "unmeasured" }, { kind: "image" }, { kind: "other" },
    ]
    const uncertain = cases.map((extra, index) => row(`old-${index}`, {
      state: "down", uptime24h: 0, bars: "d".repeat(24), ...extra,
    }))
    const result = buildRefreshPlan(input([...uncertain, row("failed", {
      state: "down", uptime24h: 10, bars: "d".repeat(12) + "s".repeat(12),
    }), row("qwen4-max")], { existing: Object.fromEntries([...uncertain.map((model) => model.id), "failed"].map((id) => [id, {}])) }))
    expect(result.plan.remove).toEqual(["failed"])
    expect(result.plan.keptUncertain).toEqual(uncertain.map((model) => model.id).sort())
  })

  test("unlisted pruning defaults off and derives absent current IDs without configured markers", () => {
    const base = input([row("qwen4-max"), row("explicit-unlisted", { state: "unlisted" })], {
      existing: { absent: {}, "explicit-unlisted": {}, "qwen4-max": {} },
    })
    const safe = buildRefreshPlan(base)
    expect(safe.plan.remove).toEqual([])
    expect(safe.plan.keptUncertain).toEqual(["absent", "explicit-unlisted"])
    const optedIn = buildRefreshPlan({ ...base, allowUnlistedRemoval: true })
    expect(optedIn.plan.removed.unlisted).toEqual(["absent", "explicit-unlisted"])
  })

  test("merged configured-only placeholders do not count as measured status", () => {
    const catalog = mergeCatalog({ updated: UPDATED, overall: "up", uptime: { h1: null, d24: null },
      medianLatencyMs: null, models: [], unmeasured: ["qwen4-max"] }, new Map<string, RankResolution>(), ["ghost"])
    expect(() => buildRefreshPlan(input([], { catalog, existing: { ghost: {} } }))).toThrow("no measured")
  })

  test("disabled and modelID aliases remain unchanged even when down or explicitly dropped", () => {
    const existing = {
      alias: { modelID: "glm-5.3", name: "My alias", custom: [1] },
      "glm-5.3": { modelID: "different-model", name: "Remapped" },
      disabled: { disabled: true }, inactive: { enabled: false }, legacy: null,
    }
    const base = input([row("qwen4-max"), row("glm-5.3", { state: "down", uptime24h: 0, bars: "d".repeat(24) })], {
      existing, allowUnlistedRemoval: true,
      policy: { ...DEFAULT_POLICY, alwaysDrop: Object.keys(existing) },
    })
    const result = buildRefreshPlan(base)
    expect(result.plan.remove).toEqual([])
    Object.entries(existing).forEach(([id, entry]) => { expect(result.models[id]).toEqual(entry) })
    expect(result.warnings.some((warning) => warning.includes("alias") && warning.includes("preserved unchanged"))).toBe(true)
  })

  test("alwaysKeep protects current failures/unlisted; full explicit alwaysDrop wins policy conflicts", () => {
    const base = input([row("qwen4-max"), row("kept", { state: "down", uptime24h: 0, bars: "d".repeat(24) })], {
      existing: { kept: {}, missing: {}, forced: {} }, allowUnlistedRemoval: true,
      policy: { ...DEFAULT_POLICY, alwaysKeep: ["kept", "missing", "forced"], alwaysDrop: ["forced"] },
    })
    expect(buildRefreshPlan(base).plan.removed).toEqual({ failed: [], unlisted: [], forced: ["forced"] })
    expect(buildRefreshPlan({ ...base, mode: "add" }).plan.remove).toEqual([])
  })

  test("alwaysKeep cannot invent new IDs or bypass state/rank evidence", () => {
    const base = input([row("qwen4-max"), row("foreign", { state: "busy" }),
      row("rankless", { rankSource: "unknown", ranks: [] })], {
      policy: { ...DEFAULT_POLICY, alwaysKeep: ["foreign", "rankless"] },
    })
    expect(buildRefreshPlan(base).plan.add).toEqual(["qwen4-max"])
    expect(() => buildRefreshPlan({ ...base, policy: { ...DEFAULT_POLICY, alwaysKeep: ["invented"] } })).toThrow("lacks public status evidence")
  })

  test("new image/video/noncandidate models never enter the chat refresh", () => {
    const result = buildRefreshPlan(input([row("qwen4-max"), row("glm-5.3", { kind: "image" }),
      row("kimi-k3", { kind: "video" }), row("gpt-unknown")]))
    expect(result.plan.add).toEqual(["qwen4-max"])
  })

  test("empty outcomes and all-down mass removal fail closed", () => {
    expect(() => buildRefreshPlan(input([row("qwen4-max", { ranks: [] })]))).toThrow("Empty refresh")
    const base = input([row("failed", { state: "down", uptime24h: 0, bars: "d".repeat(24) })], {
      existing: { failed: {}, ghost: {} },
    })
    expect(() => buildRefreshPlan(base)).toThrow("All-down")
    expect(() => buildRefreshPlan({ ...base, allowUnlistedRemoval: true })).toThrow("Empty refresh")
    expect(buildRefreshPlan({ ...base, mode: "add" }).plan.remove).toEqual([])
  })
})

describe("buildRefreshPlan boundaries and metadata", () => {
  test("freshness uses status Unix seconds and injected epoch milliseconds with exact boundaries", () => {
    const base = input([row("qwen4-max")])
    for (const age of [0, 60 * 60_000, -5 * 60_000]) {
      expect(buildRefreshPlan({ ...base, now: NOW + age }).plan.updated).toBe(UPDATED)
    }
    for (const age of [60 * 60_000 + 1, -5 * 60_000 - 1]) {
      expect(() => buildRefreshPlan({ ...base, now: NOW + age })).toThrow("stale")
    }
    for (const updated of [0, -1, NaN, Infinity, NOW]) {
      expect(() => buildRefreshPlan({ ...base, catalog: { ...base.catalog, updated } })).toThrow("timestamp")
    }
  })

  test("rejects duplicate IDs, missing measured status, and truncated source counts", () => {
    expect(() => buildRefreshPlan(input([row("qwen4-max"), row("qwen4-max")]))).toThrow("Duplicate")
    expect(() => buildRefreshPlan(input([]))).toThrow("nonempty")
    const base = input([row("qwen4-max")])
    expect(() => buildRefreshPlan({ ...base, catalog: { ...base.catalog,
      counts: { ...base.catalog.counts, down: 1 } } })).toThrow("Incomplete")
    expect(() => buildRefreshPlan(input([row("bad", { state: "unlisted" })]))).toThrow("no measured")
  })

  test("rejects invalid runtime selections and malformed direct catalog states", () => {
    const base = input([row("qwen4-max")])
    for (const extra of [{ rank: "t5" }, { mode: "delete" }, { priority: "api" }, { providerID: "" }]) {
      expect(() => buildRefreshPlan({ ...base, ...extra } as RefreshInput)).toThrow("Invalid refresh")
    }
    expect(() => buildRefreshPlan(input([row("bad", { state: "broken" as CatalogModel["state"] })]))).toThrow("invalid public status row")
  })

  test("preserves existing metadata and enriches only missing new fields with public prices", () => {
    const existing = { "glm-5.3": { name: "Mine", limit: { context: 42 }, cost: { input: 9 }, options: { nested: [1, 2] } } }
    const base = input([row("glm-5.3"), row("qwen4-max", { price: { input: "$0.1", output: "$0.2", perCall: null } })], {
      existing, metadata: { alibaba: { models: { "qwen4-max": { name: "Qwen 4 Max", limit: { context: 100, output: 10 } } } } },
    })
    const before = structuredClone(base)
    const result = buildRefreshPlan(base)
    expect(result.models["glm-5.3"]).toEqual(existing["glm-5.3"])
    expect(result.models["qwen4-max"]).toEqual({ name: "Qwen 4 Max", limit: { context: 1_000_000, output: 262_144 }, cost: { input: 0.1, output: 0.2 } })
    expect(base).toEqual(before)
    expect(Object.isFrozen(result.plan)).toBe(true)
    expect(Object.isFrozen(result.plan.models)).toBe(true)
    expect(Object.isFrozen(result.plan.removed.failed)).toBe(true)
    expect(Object.isFrozen(result.models["glm-5.3"])).toBe(true)
    expect(Object.isFrozen(existing["glm-5.3"])).toBe(false)
  })

  test("unknown metadata is warned about without invented limits or capabilities", () => {
    const result = buildRefreshPlan(input([row("gpt-6.1-sol")]))
    expect(result.models["gpt-6.1-sol"]).toEqual({ name: "GPT 6.1 Sol" })
    expect(result.warnings).toEqual(["gpt-6.1-sol: limit.context/output missing from models.dev"])
  })
})
