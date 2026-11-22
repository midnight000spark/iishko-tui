import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import type { AccountStore } from "./accounts.js"
import type { CatalogDeps, SelectInput } from "./catalog.js"
import { modelEntries, parseConfig } from "./config-document.js"
import { compatibility, createController, type ControllerDeps, type ControllerUi } from "./controller.js"
import type { LocalAccount } from "./discovery.js"
import type { CatalogLoad, LoadOptions } from "./loader.js"
import type { PublicDocument } from "./public-data.js"
import { buildRefreshPlan, type RefreshInput } from "./refresh-plan.js"
import type { CatalogModel } from "./site.js"
import { prepareUpdate, type ApplyUpdateOptions, type PreparedUpdate } from "./transaction.js"

const NOW = 1_795_305_600_000
const PATH = resolve("/fixture/opencode.jsonc")
const BACKUP = `${PATH}.iishko-fixture.bak`
const DOCUMENT = JSON.stringify({ providers: {
  alpha: { settings: { baseURL: "https://api.reformboss.com/v1" }, models: { old: { name: "Keep" } } },
  beta: { settings: { baseURL: "https://reformboss.com/v1" }, models: { other: { name: "Other" } } },
}, unrelated: { preserve: true } })

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void
  const promise = new Promise<Value>((done) => { resolve = done })
  return { promise, resolve }
}

function local(providerID = "alpha"): LocalAccount {
  return { providerID, label: `Local ${providerID}`, path: PATH, models: modelEntries(DOCUMENT, providerID) }
}

function loaded(): CatalogLoad {
  const row: CatalogModel = {
    id: "qwen4-max", lab: "qwen", kind: "chat", state: "up", checkedAt: NOW / 1000,
    latencyMs: 100, uptime1h: 99, uptime24h: 99, probes1h: 60, bars: "u".repeat(24),
    price: { input: null, output: null, perCall: null }, ranks: ["t3"],
    rankSource: "catalog", ranksConflict: false, configured: false,
  }
  return { catalog: { updated: NOW / 1000, overall: "up", uptime: { h1: 99, d24: 99 },
    medianLatencyMs: 100, counts: { up: 1, busy: 0, down: 0, unknown: 0, unmeasured: 0, unlisted: 0 },
    models: [row] }, warnings: [], fromCache: false, fetchedAt: NOW }
}

function fixture(overrides: Partial<ControllerDeps> = {}) {
  const selects: { title: string; current?: unknown; options: readonly { value: unknown; description?: string }[] }[] = []
  const alerts: { title: string; message: string }[] = []
  const confirms: { title: string; message: string }[] = []
  const toasts: { message: string; variant?: string }[] = []
  const answers: unknown[] = ["t3", "add", "continue"]
  const calls = { discovers: 0, reads: [] as string[], saves: [] as AccountStore[], loads: [] as (LoadOptions | undefined)[],
    documents: [] as PublicDocument[], builds: [] as RefreshInput[], prepared: [] as PreparedUpdate[],
    applies: [] as { prepared: PreparedUpdate; identity: string; options: ApplyUpdateOptions }[], clears: 0 }
  let state: AccountStore = { ranks: { alpha: "t1" }, priority: "conservative", activeAccount: "alpha" }
  let consent: boolean | undefined = true
  const ui: ControllerUi = {
    async select<Value>(input: SelectInput<Value>) {
      selects.push({ title: input.title, current: input.current, options: input.options })
      return answers.shift() as Value | undefined
    },
    async alert(input) { alerts.push(input) },
    async confirm(input) { confirms.push(input); return consent },
    toast(input) { toasts.push(input) },
    clear() { calls.clears++ },
  }
  const deps: ControllerDeps = {
    ui, state: () => state,
    save: async (next, signal) => { signal.throwIfAborted(); calls.saves.push(next); state = next },
    discover: async () => { calls.discovers++; return [local()] },
    read: async (path) => { calls.reads.push(path); return DOCUMENT },
    loader: { load: async (options) => { calls.loads.push(options); return loaded() } },
    documents: { load: async (kind) => { calls.documents.push(kind); return kind === "schema" ? { type: "object" }
      : kind === "modelSchema" ? { $id: "https://models.dev/model-schema.json", $defs: {} } : {} } },
    build: (input) => { calls.builds.push(input); return buildRefreshPlan(input) },
    prepare: (input) => { const value = prepareUpdate(input); calls.prepared.push(value); return value },
    apply: async (prepared, identity, options) => {
      calls.applies.push({ prepared, identity, options })
      await options.validate(prepared.after)
      return { backupPath: BACKUP }
    },
    now: () => NOW, compatibility: "supported", ...overrides,
  }
  return { controller: createController(deps), deps, calls, ui, selects, alerts, confirms, toasts, answers,
    consent(value: boolean | undefined) { consent = value }, state: () => state }
}

describe("controller compatibility", () => {
  test("accepts only stable supported 2.x versions", () => {
    for (const version of ["2.2.5", "2.2.6+build.1", "2.3.0", "2.99.0"]) expect(compatibility(version)).toBe("supported")
    for (const version of ["1.9.9", "2.2.4", "2.1.99"]) expect(compatibility(version)).toBe("old")
    for (const version of ["3.0.0", "2.2.5-beta", "unknown", "02.2.5"]) expect(compatibility(version)).toBe("unknown")
    expect(compatibility("2.2.5", "canary")).toBe("unknown")
  })

  test("unsupported versions allow help but no discovery or network", async () => {
    const f = fixture({ compatibility: "unknown" })
    await f.controller.refresh()
    expect(f.calls.discovers).toBe(0)
    expect(f.calls.loads).toHaveLength(0)
    expect(f.alerts[0]?.title).toContain("Совместимость")
    f.answers.splice(0, f.answers.length, "help")
    await f.controller.menu()
    expect(f.alerts[1]?.message).toContain("Ключи не читаются")
  })
})

describe("exclusive operation and lifetime", () => {
  test("menu acquires the gate before awaiting and dispatch retains that same owner", async () => {
    const selected = deferred<unknown>()
    const opened = deferred<void>()
    const browsing = deferred<void>()
    const entered = deferred<void>()
    let selectCount = 0
    let catalogCount = 0
    const f = fixture({
      ui: { select: async <Value>() => { selectCount++; opened.resolve(); return await selected.promise as Value | undefined },
        alert: async () => {}, confirm: async () => true, toast: () => {}, clear: () => {} },
      catalog: async () => { catalogCount++; entered.resolve(); await browsing.promise },
    })
    const task = f.controller.menu()
    await opened.promise
    await Promise.all([f.controller.menu(), f.controller.catalog(), f.controller.refresh()])
    expect(selectCount).toBe(1)
    expect(f.calls.discovers).toBe(0)
    selected.resolve("catalog")
    await entered.promise
    await f.controller.refresh()
    expect(catalogCount).toBe(1)
    expect(f.calls.discovers).toBe(1)
    browsing.resolve()
    await task
    await f.controller.catalog()
    expect(catalogCount).toBe(2)
  })

  test("dispose while storage waits aborts the actual mutation and starts no late network or apply", async () => {
    const pending = deferred<void>()
    const entered = deferred<AbortSignal>()
    let mutations = 0
    const f = fixture({ save: async (_next, signal) => {
      entered.resolve(signal)
      await pending.promise
      if (!signal.aborted) mutations++
    } })
    const task = f.controller.refresh()
    const signal = await entered.promise
    f.controller.dispose()
    await task
    expect(signal.aborted).toBe(true)
    expect(f.calls.clears).toBe(1)
    pending.resolve()
    await pending.promise
    await f.controller.menu()
    expect(mutations).toBe(0)
    expect(f.selects).toHaveLength(1)
    expect(f.calls.loads).toHaveLength(0)
    expect(f.calls.applies).toHaveLength(0)
    expect(f.toasts).toHaveLength(0)
    f.controller.dispose()
    expect(f.calls.clears).toBe(1)
  })

  test("dispose during discovery ignores late accounts without opening dialogs", async () => {
    const pending = deferred<readonly LocalAccount[]>()
    const entered = deferred<AbortSignal | undefined>()
    const f = fixture({ discover: async (options) => { entered.resolve(options.signal); return pending.promise } })
    const task = f.controller.refresh()
    const signal = await entered.promise
    f.controller.dispose()
    await task
    pending.resolve([local()])
    await pending.promise
    expect(signal?.aborted).toBe(true)
    expect(f.selects).toHaveLength(0)
    expect(f.calls.reads).toHaveLength(0)
    expect(f.alerts).toHaveLength(0)
  })

  test("dispose during load prevents preparation, confirmation and subsequent effects", async () => {
    const pending = deferred<CatalogLoad>()
    const entered = deferred<AbortSignal | undefined>()
    const f = fixture({ loader: { load: async (options) => { entered.resolve(options?.signal); return pending.promise } } })
    const task = f.controller.refresh()
    const signal = await entered.promise
    const before = f.toasts.length
    f.controller.dispose()
    await task
    pending.resolve(loaded())
    await pending.promise
    expect(signal?.aborted).toBe(true)
    expect(f.calls.prepared).toHaveLength(0)
    expect(f.confirms).toHaveLength(0)
    expect(f.calls.applies).toHaveLength(0)
    expect(f.toasts).toHaveLength(before)
  })

  test("late affirmative confirmation after disposal cannot rediscover or apply", async () => {
    const pending = deferred<boolean>()
    const entered = deferred<void>()
    const f = fixture()
    const controller = createController({ ...f.deps, ui: { ...f.ui, confirm: async () => { entered.resolve(); return pending.promise } } })
    const task = controller.refresh()
    await entered.promise
    controller.dispose()
    await task
    pending.resolve(true)
    await pending.promise
    expect(f.calls.discovers).toBe(1)
    expect(f.calls.applies).toHaveLength(0)
    expect(f.alerts).toHaveLength(0)
  })

  test("dispose during preview blocks a late continue choice", async () => {
    const pending = deferred<unknown>()
    const entered = deferred<void>()
    const f = fixture()
    const controller = createController({ ...f.deps, ui: { ...f.ui, select: async <Value>(input: SelectInput<Value>) => {
      if (input.title === "Предпросмотр локального обновления") {
        entered.resolve()
        return await pending.promise as Value | undefined
      }
      return f.ui.select(input)
    } } })
    const task = controller.refresh()
    await entered.promise
    controller.dispose()
    await task
    pending.resolve("continue")
    await pending.promise
    expect(f.confirms).toHaveLength(0)
    expect(f.calls.applies).toHaveLength(0)
  })

  test("dispose during apply aborts transaction and suppresses late success alert", async () => {
    const pending = deferred<{ backupPath: string }>()
    const entered = deferred<AbortSignal | undefined>()
    const f = fixture({ apply: async (_preview, _identity, options) => { entered.resolve(options.signal); return pending.promise } })
    const task = f.controller.refresh()
    const signal = await entered.promise
    f.controller.dispose()
    await task
    pending.resolve({ backupPath: BACKUP })
    await pending.promise
    expect(signal?.aborted).toBe(true)
    expect(f.alerts).toHaveLength(0)
  })
})

describe("safe local refresh", () => {
  for (const consent of [false, undefined]) {
    test(`confirmation ${String(consent)} never writes`, async () => {
      const f = fixture()
      f.consent(consent)
      await f.controller.refresh()
      expect(f.confirms).toHaveLength(1)
      expect(f.calls.prepared).toHaveLength(1)
      expect(f.calls.applies).toHaveLength(0)
      expect(f.calls.discovers).toBe(1)
    })
  }

  test("canceling preview never asks consent or applies", async () => {
    const f = fixture()
    f.answers.splice(2, 1, undefined)
    await f.controller.refresh()
    expect(f.confirms).toHaveLength(0)
    expect(f.calls.applies).toHaveLength(0)
  })

  test("selected local account determines route, configured models, preview and persisted rank", async () => {
    const f = fixture({ discover: async () => [local(), local("beta")] })
    f.answers.splice(0, f.answers.length, "beta", "t3", "add", "continue")
    await f.controller.refresh()
    expect(f.selects[0]?.current).toBe("alpha")
    expect(f.calls.reads).toEqual([PATH])
    expect(f.calls.loads[0]).toMatchObject({ force: true, configured: ["other"], priority: "conservative" })
    expect(f.calls.builds[0]).toMatchObject({ providerID: "beta", rank: "t3", mode: "add", allowUnlistedRemoval: false })
    expect(f.state()).toEqual({ ranks: { alpha: "t1", beta: "t3" }, priority: "conservative", activeAccount: "beta" })
    const approved = f.calls.prepared[0]!
    expect(approved.providerID).toBe("beta")
    expect(modelEntries(approved.after, "alpha")).toEqual(modelEntries(DOCUMENT, "alpha"))
    expect(modelEntries(approved.after, "beta")).toHaveProperty("qwen4-max")
    expect(f.confirms[0]?.message).toContain("Провайдер: beta")
  })

  test("full mode has no unlisted-pruning option and preserves absent models", async () => {
    const f = fixture()
    f.answers[1] = "full"
    await f.controller.refresh()
    expect(f.selects).toHaveLength(3)
    expect(f.selects[1]?.options[1]?.description).toContain("сохраняются")
    expect(f.calls.builds[0]?.allowUnlistedRemoval).toBe(false)
    expect(modelEntries(f.calls.prepared[0]!.after, "alpha")).toHaveProperty("old")
    expect(f.confirms[0]?.message).toContain("Удалять отсутствующие: НЕТ")
  })

  test("stale fallback is rejected before plan, consent and apply", async () => {
    const f = fixture({ loader: { load: async () => ({ ...loaded(), stale: true }) } })
    await f.controller.refresh()
    expect(f.calls.builds).toHaveLength(0)
    expect(f.confirms).toHaveLength(0)
    expect(f.calls.applies).toHaveLength(0)
    expect(f.toasts.at(-1)?.variant).toBe("error")
  })

  test("schema failure blocks preparation, consent and apply", async () => {
    const f = fixture({ documents: { load: async (kind) => kind === "schema" ? false : {} } })
    await f.controller.refresh()
    expect(f.calls.builds).toHaveLength(1)
    expect(f.calls.prepared).toHaveLength(0)
    expect(f.confirms).toHaveLength(0)
    expect(f.calls.applies).toHaveLength(0)
  })

  test("changed local endpoint is refused before public requests", async () => {
    const f = fixture({ read: async () => DOCUMENT.replace("https://api.reformboss.com/v1", "https://unrelated.example/v1") })
    await f.controller.refresh()
    expect(f.calls.loads).toHaveLength(0)
    expect(f.calls.documents).toHaveLength(0)
    expect(f.confirms).toHaveLength(0)
    expect(f.calls.applies).toHaveLength(0)
  })

  test("a new conflicting local owner after confirmation blocks apply", async () => {
    let discoveries = 0
    const f = fixture({ discover: async () => ++discoveries === 1 ? [local()] : [local(), { ...local(), path: `${PATH}.override` }] })
    await f.controller.refresh()
    expect(f.confirms).toHaveLength(1)
    expect(discoveries).toBe(2)
    expect(f.calls.applies).toHaveLength(0)
    expect(f.toasts.at(-1)?.variant).toBe("error")
  })

  test("success applies the very same frozen approved identity and shows backup", async () => {
    const f = fixture()
    await f.controller.refresh()
    const approved = f.calls.prepared[0]!
    expect(Object.isFrozen(approved)).toBe(true)
    expect(f.calls.applies).toHaveLength(1)
    expect(f.calls.applies[0]?.prepared).toBe(approved)
    expect(f.calls.applies[0]?.identity).toBe(approved.identity)
    expect(f.confirms[0]?.message).toBe(approved.summary)
    expect(parseConfig(approved.after).value.unrelated).toEqual({ preserve: true })
    expect(f.alerts[0]?.message).toContain(`Бэкап: ${BACKUP}`)
    expect(f.alerts[0]?.message).toContain("Удалённый сервер не изменялся")
  })

  test("optional metadata failure warns without skipping mandatory schema validation", async () => {
    const f = fixture({ documents: { load: async (kind) => {
      if (kind === "metadata") throw new Error("private diagnostic must not appear")
      if (kind === "modelSchema") return { $id: "https://models.dev/model-schema.json", $defs: {} }
      return { type: "object" }
    } } })
    await f.controller.refresh()
    expect(f.calls.applies).toHaveLength(1)
    expect(f.confirms[0]?.message).toContain("Метаданные models.dev недоступны")
    expect(JSON.stringify([f.alerts, f.toasts, f.confirms])).not.toContain("private diagnostic")
  })

  test("empty local discovery gives actionable safe setup guidance", async () => {
    const f = fixture({ discover: async () => [] })
    await f.controller.catalog()
    expect(f.alerts[0]?.message).toContain("providers.<id>.settings.baseURL")
    expect(f.alerts[0]?.message).toContain("configPath")
    expect(f.calls.loads).toHaveLength(0)
    expect(f.calls.applies).toHaveLength(0)
  })

  test("arbitrary errors are not displayed, and gate is released on failure", async () => {
    let fail = true
    const f = fixture({ discover: async () => {
      if (fail) throw new Error("sensitive config contents")
      return []
    } })
    await f.controller.refresh()
    expect(f.toasts[0]?.message).not.toContain("sensitive")
    expect(f.toasts[0]?.message).toContain("конфликтующие")
    fail = false
    await f.controller.refresh()
    expect(f.alerts).toHaveLength(1)
  })

  test("catalog uses discovered local markers and saves account/rank/priority via guarded storage", async () => {
    let captured: CatalogDeps | undefined
    const f = fixture({ discover: async () => [local(), local("beta")], catalog: async (deps) => {
      captured = deps
      await deps.saveAccount?.("beta")
      await deps.saveRank("beta", "t2")
      await deps.savePriority("site")
    } })
    await f.controller.catalog()
    expect(captured?.accounts.map((entry) => entry.providerID)).toEqual(["alpha", "beta"])
    expect(captured?.configured(captured.accounts[1]!)).toEqual(["other"])
    expect(f.state()).toEqual({ ranks: { alpha: "t1", beta: "t2" }, priority: "site", activeAccount: "beta" })
    expect(f.calls.loads).toHaveLength(0)
    expect(f.calls.applies).toHaveLength(0)
  })

  test("retained catalog callbacks cannot mutate storage or UI after their owner exits", async () => {
    let captured!: CatalogDeps
    const f = fixture({ catalog: async (deps) => { captured = deps } })
    await f.controller.catalog()
    await expect(Promise.resolve().then(() => captured.saveAccount!("beta"))).rejects.toThrow()
    await expect(Promise.resolve().then(() => captured.ui.alert({ title: "late", message: "late" }))).rejects.toThrow()
    expect(f.calls.saves).toHaveLength(0)
    expect(f.alerts).toHaveLength(0)
  })
})
