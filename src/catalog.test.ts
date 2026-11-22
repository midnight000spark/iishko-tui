import { describe, expect, test } from "bun:test"
import type { Account } from "./accounts.js"
import {
  showCatalog,
  type CatalogDeps,
  type CatalogUi,
  type Option,
  type SelectAction,
  type SelectInput,
} from "./catalog.js"
import {
  DEFAULT_SOURCES,
  createLoader,
  type FetchLike,
  type Sources,
} from "./loader.js"
import { SiteError, parseStatus } from "./parse.js"
import {
  mergeCatalog,
  resolveRanks,
  type Catalog,
} from "./site.js"

function measured(id: string, state: string, lab: string, uptime: number): Record<string, unknown> {
  return {
    id,
    lab,
    kind: "chat",
    state,
    checked_at: 1_699_999_880,
    latency_ms: 500,
    uptime_1h: uptime,
    uptime_24h: uptime,
    probes_1h: 60,
    bars: "u".repeat(24),
    price: { input: "$0.15", output: "$0.60", per_call: null },
  }
}

const STATUS_BODY = JSON.stringify({
  updated: 1_700_000_000,
  overall: "outage",
  uptime: { h1: 50, d24: 37.7 },
  median_latency_ms: 2885,
  models: [measured("m-up", "up", "qwen", 97.8), measured("m-down", "down", "glm", 0)],
  unmeasured: [],
})

const RANKS_JSON = JSON.stringify({
  data: [{ model_name: "m-up", enable_groups: ["early", "t2"] }],
})

const RANKS_HTML =
  "<table><tbody><tr><th>Модель</th><td>Тип</td><td>Вход</td><td>Выход</td><td>Вызов</td><td>Ранги</td></tr>" +
  "<tr><td>m-up</td><td>чат</td><td>$1</td><td>$2</td><td>—</td><td>🥉 Новичок, 🥇 Профи</td></tr>" +
  "</tbody></table>"

const SOURCES: Sources = {
  status: "https://test/status",
  pricingJson: "https://test/json",
  pricingHtml: "https://test/html",
}

function stubFetch(fail: ReadonlySet<string> = new Set()) {
  const calls: string[] = []
  const bodies = new Map([
    [SOURCES.status, STATUS_BODY],
    [SOURCES.pricingJson, RANKS_JSON],
    [SOURCES.pricingHtml, RANKS_HTML],
  ])
  const http: FetchLike = async (url) => {
    calls.push(url)
    if (fail.has(url)) return { ok: false, status: 500, text: async () => "" }
    const body = bodies.get(url)
    if (body === undefined) throw new Error(`нет маршрута: ${url}`)
    return { ok: true, status: 200, text: async () => body }
  }
  return { http, calls }
}

describe("createLoader", () => {
  test("полная загрузка: каталог, ранги сайта и нулевые предупреждения", async () => {
    const stub = stubFetch()
    const loader = createLoader(stub.http, SOURCES)
    const load = await loader.load({ configured: ["m-up"] })
    expect(stub.calls).toHaveLength(3)
    expect(load.warnings).toEqual([])
    expect(load.fromCache).toBe(false)
    expect(load.catalog.counts.up).toBe(1)
    const model = load.catalog.models.find((entry) => entry.id === "m-up")
    expect(model?.ranks).toEqual(["t1", "t3"])
    expect(model?.configured).toBe(true)
  })

  test("падение /pricing не мешает каталогу: ранги из api и предупреждение", async () => {
    const stub = stubFetch(new Set([SOURCES.pricingHtml]))
    const loader = createLoader(stub.http, SOURCES)
    const load = await loader.load({ configured: [] })
    expect(load.warnings.join(" ")).toContain("/pricing")
    expect(load.catalog.models.find((entry) => entry.id === "m-up")?.ranks).toEqual(["t2"])
  })

  test("status обязателен: без него ошибка", async () => {
    const stub = stubFetch(new Set([SOURCES.status]))
    const loader = createLoader(stub.http, SOURCES)
    await expect(loader.load()).rejects.toBeInstanceOf(SiteError)
  })

  test("кэш живёт ttl, force его обходит", async () => {
    let clock = 1_000_000
    const stub = stubFetch()
    const loader = createLoader(stub.http, SOURCES, { now: () => clock, ttlMs: 30_000 })
    await loader.load()
    const cached = await loader.load()
    expect(cached.fromCache).toBe(true)
    expect(stub.calls).toHaveLength(3)
    clock += 31_000
    await loader.load()
    expect(stub.calls).toHaveLength(6)
    await loader.load({ force: true })
    expect(stub.calls).toHaveLength(9)
  })

  test("при падении сайта отдаёт свежий кэш с пометкой, но не вечный", async () => {
    let clock = 1_000_000
    const stub = stubFetch()
    let failing = false
    const http: FetchLike = async (url, init) => {
      if (failing && url === SOURCES.status) return { ok: false, status: 500, text: async () => "" }
      return stub.http(url, init)
    }
    const loader = createLoader(http, SOURCES, { now: () => clock, ttlMs: 30_000, staleMs: 600_000 })
    await loader.load()
    clock += 60_000
    failing = true
    const stale = await loader.load({ force: true })
    expect(stale.fromCache).toBe(true)
    expect(stale.warnings.join(" ")).toContain("сайт недоступен")
    clock += 11 * 60_000
    await expect(loader.load({ force: true })).rejects.toBeInstanceOf(SiteError)
  })

  test("по умолчанию источники указывают на reformboss.com", () => {
    expect(DEFAULT_SOURCES.status).toBe("https://reformboss.com/api/status.json")
    expect(DEFAULT_SOURCES.pricingHtml).toBe("https://reformboss.com/pricing")
  })
})

interface SelectCall {
  readonly title: string
  readonly current?: unknown
  readonly options: readonly Option<unknown>[]
  readonly actions?: readonly SelectAction[]
}

interface Fake {
  readonly ui: CatalogUi
  readonly selects: SelectCall[]
  readonly alerts: { title: string; message: string }[]
  readonly toasts: { message: string; variant?: string }[]
  clears: number
}

type Behaviour = (call: SelectCall, index: number, fake: Fake) => Promise<unknown>

function fakeUi(behaviour: Behaviour): Fake {
  const fake = {
    selects: [] as SelectCall[],
    alerts: [] as { title: string; message: string }[],
    toasts: [] as { message: string; variant?: string }[],
    clears: 0,
  } as Fake
  const ui: CatalogUi = {
    select<Value>(input: SelectInput<Value>) {
      fake.selects.push(input as unknown as SelectCall)
      return behaviour(input as unknown as SelectCall, fake.selects.length - 1, fake) as Promise<
        Value | undefined
      >
    },
    async alert(input) {
      fake.alerts.push({ title: input.title, message: input.message })
    },
    toast(input) {
      fake.toasts.push({ message: input.message, variant: input.variant })
    },
    clear() {
      fake.clears += 1
    },
  }
  return Object.assign(fake, { ui })
}

const ACCOUNTS: readonly Account[] = [
  { id: "v2", label: "V2", providerID: "reformbossV2", rank: "t3" },
  { id: "v1", label: "V1", providerID: "reformbossV1", rank: "t1" },
]

/** Каталог строится тем же путём, что и в рантайме, но без сети. */
function fixture(configured: readonly string[] = ["m-up"]): Catalog {
  const parsed = parseStatus({
    updated: 1_700_000_000,
    overall: "outage",
    uptime: { h1: 50, d24: 37.7 },
    median_latency_ms: 2885,
    models: [measured("m-up", "up", "qwen", 97.8), measured("m-down", "down", "glm", 0)],
    unmeasured: [],
  })
  const index = resolveRanks(
    new Map([["m-up", ["t1", "t2", "t3"]]]),
    new Map([["m-down", ["t2", "t3", "t4"]]]),
    "site",
  )
  return mergeCatalog(parsed, index, configured)
}

function fakeLoader(catalog: Catalog) {
  const options: { configured?: readonly string[]; priority?: string; force?: boolean }[] = []
  return {
    options,
    loader: {
      async load(input: { configured?: readonly string[]; priority?: string; force?: boolean } = {}) {
        options.push(input)
        return { catalog, warnings: [], fromCache: false, fetchedAt: 1_700_000_000_000 }
      },
    },
  }
}

function deps(ui: CatalogUi, overrides: Partial<CatalogDeps> = {}): CatalogDeps {
  const catalog = fixture()
  const loader = fakeLoader(catalog)
  return {
    ui,
    loader: loader.loader,
    accounts: ACCOUNTS,
    initialAccount: "v2",
    ranks: {},
    priority: "site",
    configured: (account) => (account.providerID === "reformbossV2" ? ["m-up"] : []),
    saveRank: async () => {},
    savePriority: async () => {},
    now: () => 1_700_000_060_000,
    ...overrides,
  }
}

function trigger(call: SelectCall, bind: string): void {
  call.actions?.find((action) => action.bind === bind)?.onTrigger()
}

function deferred<Value>() {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((done) => { resolve = done })
  return { promise, resolve }
}

describe("showCatalog", () => {
  test("открывает список с меткой аккаунта и закрывается по Esc", async () => {
    const fake = fakeUi(async () => undefined)
    await showCatalog(deps(fake.ui))
    expect(fake.selects).toHaveLength(1)
    expect(fake.selects[0]?.title).toContain("ИИШКО · каталог")
    expect(fake.selects[0]?.title).toContain("V2")
    expect(fake.selects[0]?.options.map((option) => option.value)).toEqual(["m-up", "m-down"])
  })

  test("Enter открывает детали с оговоркой про ключ сайта", async () => {
    const fake = fakeUi(async (_call, index) => (index === 0 ? "m-up" : undefined))
    await showCatalog(deps(fake.ui))
    expect(fake.alerts).toHaveLength(1)
    expect(fake.alerts[0]?.message).toContain("ключ сайта")
    expect(fake.alerts[0]?.message).toContain("полосы 4ч")
  })

  test("ctrl+f фильтрует по состоянию", async () => {
    const fake = fakeUi(async (call, index) => {
      if (index === 0) trigger(call, "ctrl+f")
      if (index === 1) return "state"
      if (index === 2) return "up"
      return undefined
    })
    await showCatalog(deps(fake.ui))
    expect(fake.clears).toBe(1)
    expect(fake.selects[2]?.title).toBe("Состояние")
    expect(fake.selects[3]?.title).toBe("Фильтры каталога")
    expect(fake.selects[4]?.options.map((option) => option.value)).toEqual(["m-up"])
  })

  test("ctrl+g сохраняет ранг активного аккаунта и перестраивает фильтр", async () => {
    const saved: string[] = []
    const fake = fakeUi(async (call, index) => {
      if (index === 0) trigger(call, "ctrl+g")
      if (index === 1) return "t1"
      return undefined
    })
    await showCatalog(
      deps(fake.ui, {
        saveRank: async (accountID, rank) => {
          saved.push(`${accountID}:${rank ?? "null"}`)
        },
      }),
    )
    expect(saved).toEqual(["v2:t1"])
    expect(fake.selects[2]?.title).toContain("Новичок")
    expect(fake.selects[2]?.options.map((option) => option.value)).toEqual(["m-up"])
  })

  test("ctrl+o форсирует перезагрузку", async () => {
    const catalog = fixture()
    const calls: { force?: boolean }[] = []
    const fake = fakeUi(async (call, index) => {
      if (index === 0) trigger(call, "ctrl+o")
      return undefined
    })
    await showCatalog(
      deps(fake.ui, {
        loader: {
          async load(input: { force?: boolean } = {}) {
            calls.push(input)
            return { catalog, warnings: [], fromCache: false, fetchedAt: 0 }
          },
        },
      }),
    )
    expect(calls).toHaveLength(2)
    expect(calls[1]).toMatchObject({ force: true })
  })

  test("ctrl+a переключает аккаунт и его ранг/конфиг", async () => {
    const fake = fakeUi(async (call, index) => {
      if (index === 0) trigger(call, "ctrl+a")
      if (index === 1) return "v1"
      return undefined
    })
    const seen: (readonly string[])[] = []
    await showCatalog(
      deps(fake.ui, {
        configured: (account) => {
          const ids = account.providerID === "reformbossV2" ? ["m-up"] : []
          seen.push(ids)
          return ids
        },
      }),
    )
    expect(seen).toEqual([["m-up"], []])
    expect(fake.selects[2]?.title).toContain("V1")
    expect(fake.selects[2]?.title).toContain("Новичок")
  })

  test("смена приоритета источников сохраняется и перезагружает каталог", async () => {
    const saved: string[] = []
    const calls: { priority?: string }[] = []
    const catalog = fixture()
    const fake = fakeUi(async (call, index) => {
      if (index === 0) trigger(call, "ctrl+f")
      if (index === 1) return "priority"
      if (index === 2) return "conservative"
      return undefined
    })
    await showCatalog(
      deps(fake.ui, {
        loader: {
          async load(input: { priority?: string } = {}) {
            calls.push(input)
            return { catalog, warnings: [], fromCache: false, fetchedAt: 0 }
          },
        },
        savePriority: async (priority) => {
          saved.push(priority)
        },
      }),
    )
    expect(saved).toEqual(["conservative"])
    expect(calls.map((call) => call.priority)).toEqual(["site", "conservative"])
  })

  test("недоступный сайт без кэша — alert вместо падения", async () => {
    const fake = fakeUi(async () => undefined)
    await showCatalog(
      deps(fake.ui, {
        loader: {
          async load() {
            throw new SiteError("http", "HTTP 500")
          },
        },
      }),
    )
    expect(fake.selects).toHaveLength(0)
    expect(fake.alerts[0]?.title).toBe("Каталог сайта недоступен")
    expect(fake.alerts[0]?.message).toContain("HTTP 500")
  })

  test("предупреждения загрузчика показываются один раз", async () => {
    const catalog = fixture()
    const fake = fakeUi(async () => undefined)
    await showCatalog(
      deps(fake.ui, {
        loader: {
          async load() {
            return { catalog, warnings: ["ранги недоступны"], fromCache: true, fetchedAt: 0 }
          },
        },
      }),
    )
    expect(fake.toasts).toHaveLength(1)
  })

  test("initialAccount выбирается по id, неизвестный id возвращает первый аккаунт", async () => {
    for (const [initialAccount, label, configured] of [
      ["v1", "V1", []],
      ["missing", "V2", ["m-up"]],
    ] as const) {
      const fake = fakeUi(async () => undefined)
      const loader = fakeLoader(fixture())
      await showCatalog(deps(fake.ui, { initialAccount, loader: loader.loader }))
      expect(fake.selects[0]?.title).toContain(label)
      expect(loader.options[0]?.configured).toEqual(configured)
    }
  })

  test("выбранный ранг сохраняется при переключении аккаунта туда и обратно", async () => {
    const fake = fakeUi(async (call, index) => {
      if (index === 0 || index === 6) trigger(call, "ctrl+g")
      if (index === 1) return "t1"
      if (index === 2 || index === 4) trigger(call, "ctrl+a")
      if (index === 3) return "v1"
      if (index === 5) return "v2"
      return undefined
    })
    const ranks = Object.freeze({ v2: "t3" as const })
    const saved: string[] = []
    await showCatalog(deps(fake.ui, {
      ranks,
      saveAccount: async (id) => { saved.push(id) },
    }))
    expect(fake.selects[6]?.title).toContain("Новичок")
    expect(fake.selects[7]?.current).toBe("t1")
    expect(saved).toEqual(["v1", "v2"])
    expect(ranks).toEqual({ v2: "t3" })
  })

  test("сброс очищает все фильтры, включая временный ранг, но не сохранённый ранг аккаунта", async () => {
    const values = [undefined, "state", "up", "lab", "qwen", "kind", "chat",
      "configured", "unlisted", "rank", "t1", "reset", undefined, undefined]
    const fake = fakeUi(async (call, index) => {
      if (index === 0) trigger(call, "ctrl+f")
      return values[index]
    })
    const saved: string[] = []
    await showCatalog(deps(fake.ui, {
      saveRank: async (id) => { saved.push(id) },
    }))
    const reset = fake.selects[12]
    expect(reset?.options.map((option) => option.title)).toEqual([
      "Состояние: любое", "Лаборатория: все", "Тип: любой", "Ранг: любой",
      "Источники рангов: каталог сайта", "Только в конфиге: нет",
      "Показывать отсутствующие на сайте: нет (0)", "Сбросить все фильтры",
    ])
    expect(fake.selects[13]?.options.map((option) => option.value)).toEqual(["m-up", "m-down"])
    expect(saved).toEqual([])
  })

  for (const mode of ["account", "priority", "refresh"] as const) {
    test(`истёкший кэш и ошибка ${mode}: alert и выход без старого каталога/сохранения`, async () => {
      let clock = 1_700_000_000_000
      let failing = false
      const stub = stubFetch()
      const http: FetchLike = async (url, init) => {
        if (failing && url === SOURCES.status) return { ok: false, status: 500, text: async () => "" }
        return stub.http(url, init)
      }
      const loader = createLoader(http, SOURCES, { now: () => clock, ttlMs: 10, staleMs: 100 })
      const saved: string[] = []
      const fake = fakeUi(async (call, index) => {
        if (index === 0) {
          clock += 101
          failing = true
          trigger(call, mode === "account" ? "ctrl+a" : mode === "priority" ? "ctrl+f" : "ctrl+o")
        }
        if (mode === "account" && index === 1) return "v1"
        if (mode === "priority" && index === 1) return "priority"
        if (mode === "priority" && index === 2) return "conservative"
        return undefined
      })
      await showCatalog(deps(fake.ui, {
        loader,
        saveAccount: async (id) => { saved.push(id) },
        savePriority: async (priority) => { saved.push(priority) },
      }))
      expect(fake.selects).toHaveLength(mode === "account" ? 2 : mode === "priority" ? 4 : 1)
      expect(fake.alerts).toHaveLength(1)
      expect(fake.alerts[0]?.title).toBe("Каталог сайта недоступен")
      expect(fake.alerts[0]?.message).toContain("HTTP 500")
      expect(fake.toasts).toEqual([])
      expect(saved).toEqual([])
    })
  }

  test("приоритет и аккаунт сохраняются только после успешной загрузки", async () => {
    const events: string[] = []
    const loader = fakeLoader(fixture()).loader
    const fake = fakeUi(async (call, index) => {
      if (index === 0) trigger(call, "ctrl+a")
      if (index === 1) return "v1"
      if (index === 2) trigger(call, "ctrl+f")
      if (index === 3) return "priority"
      if (index === 4) return "conservative"
      return undefined
    })
    await showCatalog(deps(fake.ui, {
      loader: { async load(input) {
        const loaded = await loader.load(input)
        events.push(`load:${input?.priority}`)
        return loaded
      } },
      saveAccount: async (id) => { events.push(`account:${id}`) },
      savePriority: async (priority) => { events.push(`priority:${priority}`) },
    }))
    expect(events).toEqual(["load:site", "load:site", "account:v1", "load:conservative", "priority:conservative"])
  })

  test("отмена до старта не вызывает size, загрузку даже свежего кэша или UI", async () => {
    const controller = new AbortController()
    const stub = stubFetch()
    const loader = createLoader(stub.http, SOURCES)
    await loader.load()
    controller.abort()
    const fake = fakeUi(async () => undefined)
    const effects: string[] = []
    await showCatalog(deps({ ...fake.ui, size: () => { effects.push("size") } }, {
      signal: controller.signal,
      loader: { async load(input) { effects.push("load"); return loader.load(input) } },
    }))
    expect(effects).toEqual([])
    expect(stub.calls).toHaveLength(3)
    expect(fake.selects).toEqual([])
    expect(fake.alerts).toEqual([])
    expect(fake.toasts).toEqual([])
  })

  test("отмена в size не начинает загрузку", async () => {
    const controller = new AbortController()
    const fake = fakeUi(async () => undefined)
    const loader = fakeLoader(fixture())
    await showCatalog(deps({ ...fake.ui, size: () => { controller.abort() } }, {
      signal: controller.signal, loader: loader.loader,
    }))
    expect(loader.options).toEqual([])
    expect(fake.alerts).toEqual([])
  })

  for (const stage of ["initial", "reload"] as const) {
    test(`отмена во время отложенной загрузки ${stage} не показывает UI/предупреждения и не сохраняет аккаунт`, async () => {
      const controller = new AbortController()
      const started = deferred<void>()
      const pending = deferred<Awaited<ReturnType<CatalogDeps["loader"]["load"]>>>()
      const loaded = { catalog: fixture(), warnings: ["warning"], fromCache: true, fetchedAt: 0 }
      let calls = 0
      const saved: string[] = []
      const fake = fakeUi(async (call, index) => {
        if (index === 0) trigger(call, "ctrl+a")
        return index === 1 ? "v1" : undefined
      })
      const running = showCatalog(deps(fake.ui, {
        signal: controller.signal,
        loader: { async load() {
          calls += 1
          if (stage === "reload" && calls === 1) return { ...loaded, warnings: [] }
          started.resolve()
          return pending.promise
        } },
        saveAccount: async (id) => { saved.push(id) },
      }))
      await started.promise
      controller.abort()
      pending.resolve(loaded)
      await running
      expect(fake.selects).toHaveLength(stage === "reload" ? 2 : 0)
      expect(fake.alerts).toEqual([])
      expect(fake.toasts).toEqual([])
      expect(saved).toEqual([])
    })
  }

  for (const stage of ["main", "filters", "state", "rank", "account", "priority"] as const) {
    test(`отмена ожидающего select ${stage} блокирует последующие UI/storage`, async () => {
      const controller = new AbortController()
      const started = deferred<void>()
      const pending = deferred<unknown>()
      const saved: string[] = []
      const stop = stage === "main" ? 0 : stage === "state" || stage === "priority" ? 2 : 1
      let delayedAction: SelectCall | undefined
      const fake = fakeUi(async (call, index) => {
        if (index === stop) {
          delayedAction = call
          started.resolve()
          return pending.promise
        }
        if (index === 0) trigger(call, stage === "rank" ? "ctrl+g" : stage === "account" ? "ctrl+a" : "ctrl+f")
        return stage === "priority" ? "priority" : "state"
      })
      const running = showCatalog(deps(fake.ui, {
        signal: controller.signal,
        saveRank: async () => { saved.push("rank") },
        saveAccount: async () => { saved.push("account") },
        savePriority: async () => { saved.push("priority") },
      }))
      await started.promise
      const clears = fake.clears
      controller.abort()
      if (delayedAction !== undefined) trigger(delayedAction, "ctrl+g")
      pending.resolve(stage === "main" ? "m-up" : stage === "rank" ? "t1" : stage === "account" ? "v1" : "conservative")
      await running
      expect(fake.selects).toHaveLength(stop + 1)
      expect(fake.clears).toBe(clears)
      expect(fake.alerts).toEqual([])
      expect(fake.toasts).toEqual([])
      expect(saved).toEqual([])
    })
  }

  for (const stage of ["rank", "account", "priority"] as const) {
    test(`отмена ожидающего save ${stage} не возвращается к каталогу`, async () => {
      const controller = new AbortController()
      const started = deferred<void>()
      const pending = deferred<void>()
      const save = async () => { started.resolve(); await pending.promise }
      const fake = fakeUi(async (call, index) => {
        if (index === 0) trigger(call, stage === "rank" ? "ctrl+g" : stage === "account" ? "ctrl+a" : "ctrl+f")
        if (index === 1) return stage === "rank" ? "t1" : stage === "account" ? "v1" : "priority"
        if (index === 2) return "conservative"
        return undefined
      })
      const running = showCatalog(deps(fake.ui, {
        signal: controller.signal, saveRank: save, saveAccount: save, savePriority: save,
      }))
      await started.promise
      controller.abort()
      pending.resolve()
      await running
      expect(fake.selects).toHaveLength(stage === "priority" ? 4 : 2)
      expect(fake.alerts).toEqual([])
      expect(fake.toasts).toEqual([])
    })
  }

  test("AbortError без сигнала тоже считается отменой, а не недоступностью сайта", async () => {
    const fake = fakeUi(async () => undefined)
    await showCatalog(deps(fake.ui, {
      loader: { async load() { throw new DOMException("cancelled", "AbortError") } },
    }))
    expect(fake.alerts).toEqual([])
    expect(fake.toasts).toEqual([])
  })

  test("отмена во время alert не открывает фильтры и не выдаёт ошибку", async () => {
    const controller = new AbortController()
    const fake = fakeUi(async () => undefined)
    const empty = fixture([])
    const catalog = { ...empty, models: [] }
    const alerts: string[] = []
    await showCatalog(deps({ ...fake.ui, async alert(input) {
      alerts.push(input.title)
      controller.abort()
    } }, {
      signal: controller.signal,
      loader: fakeLoader(catalog).loader,
    }))
    expect(alerts).toEqual(["Ничего не найдено"])
    expect(fake.selects).toEqual([])
    expect(fake.toasts).toEqual([])
  })

  test("отмена внутри предупреждения не открывает список", async () => {
    const controller = new AbortController()
    const fake = fakeUi(async () => undefined)
    let toasts = 0
    await showCatalog(deps({ ...fake.ui, toast() { toasts += 1; controller.abort() } }, {
      signal: controller.signal,
      loader: { async load() {
        return { catalog: fixture(), warnings: ["warning"], fromCache: false, fetchedAt: 0 }
      } },
    }))
    expect(toasts).toBe(1)
    expect(fake.selects).toEqual([])
    expect(fake.alerts).toEqual([])
  })

  test("приоритет из фильтров пустого списка тоже сначала загружается, затем сохраняется", async () => {
    const events: string[] = []
    const fake = fakeUi(async (_call, index) => {
      if (index === 0) return "priority"
      if (index === 1) return "conservative"
      return undefined
    })
    let calls = 0
    await showCatalog(deps(fake.ui, {
      loader: { async load(input) {
        calls += 1
        events.push(`load:${input?.priority}`)
        const catalog = fixture()
        return { catalog: calls === 1 ? { ...catalog, models: [] } : catalog,
          warnings: [], fromCache: false, fetchedAt: 0 }
      } },
      savePriority: async (priority) => { events.push(`save:${priority}`) },
    }))
    expect(events).toEqual(["load:site", "load:conservative", "save:conservative"])
    expect(fake.selects[3]?.title).toContain("ИИШКО · каталог")
  })
})
