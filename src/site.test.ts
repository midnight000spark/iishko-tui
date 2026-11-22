import { describe, expect, test } from "bun:test"
import { SiteError, parseRanksHtml, parseRanksJson, parseStatus } from "./parse.js"
import { detailFor, optionFor, percent } from "./format.js"
import {
  DEFAULT_FILTERS,
  filterCatalog,
  labs,
  mergeCatalog,
  resolveRanks,
  upByRank,
  type RankMap,
} from "./site.js"

function measured(
  id: string,
  state: string,
  lab: string,
  uptime: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    lab,
    kind: "chat",
    state,
    checked_at: 1_700_000_000 - 120,
    latency_ms: 500,
    uptime_1h: uptime,
    uptime_24h: uptime,
    probes_1h: 60,
    bars: "u".repeat(24),
    price: { input: "$0.15", output: "$0.60", per_call: null },
    ...extra,
  }
}

function rawStatus(): Record<string, unknown> {
  return {
    updated: 1_700_000_000,
    overall: "outage",
    // Намеренно неверные счётчики: каталог обязан считать сам.
    counts: { up: 99, busy: 0, down: 0, unknown: 0, unmeasured: 0 },
    uptime: { h1: 50, d24: 37.7 },
    median_latency_ms: 2885,
    bars: { slots: 24, slot_seconds: 600 },
    models: [
      measured("m-up", "up", "qwen", 97.8),
      measured("m-busy", "busy", "glm", 96.1),
      measured("m-down", "down", "kimi", 0),
      measured("m-weird", "exploded", "gpt", 1),
    ],
    unmeasured: ["m-media"],
  }
}

function indexOf(catalog: RankMap, api: RankMap, priority: "site" | "conservative") {
  return resolveRanks(catalog, api, priority)
}

function fixtureCatalog(configured: readonly string[] = ["m-up", "m-ghost"]) {
  const status = parseStatus(rawStatus())
  const catalogRanks: RankMap = new Map([
    ["m-up", ["t1", "t2", "t3"]],
    ["m-weird", ["t2", "t3"]],
  ])
  const apiRanks: RankMap = new Map([
    ["m-up", ["t2", "t3"]],
    ["m-busy", ["t4"]],
  ])
  return mergeCatalog(status, indexOf(catalogRanks, apiRanks, "site"), configured)
}

describe("parseStatus", () => {
  test("сохраняет все валидные строки и нормализует неизвестное состояние", () => {
    const status = parseStatus(rawStatus())
    expect(status.models.map((model) => model.id)).toEqual([
      "m-up",
      "m-busy",
      "m-down",
      "m-weird",
    ])
    expect(status.models.find((model) => model.id === "m-weird")?.state).toBe("unknown")
    expect(status.unmeasured).toEqual(["m-media"])
    expect(status.uptime).toEqual({ h1: 50, d24: 37.7 })
    expect(status.medianLatencyMs).toBe(2885)
  })

  test("структурный мусор — SiteError, а не падение", () => {
    expect(() => parseStatus(null)).toThrow(SiteError)
    expect(() => parseStatus({ updated: 1 })).toThrow("списка моделей")
    expect(() => parseStatus({ models: [] })).toThrow("времени обновления")
  })

  test("недостающие метрики становятся null, а не нулями", () => {
    const status = parseStatus({
      updated: 10,
      models: [{ id: "bare" }],
      unmeasured: [],
    })
    const model = status.models[0]
    expect(model?.state).toBe("unknown")
    expect(model?.latencyMs).toBeNull()
    expect(model?.checkedAt).toBeNull()
    expect(model?.uptime1h).toBeNull()
    expect(model?.uptime24h).toBeNull()
    expect(model?.probes1h).toBeNull()
    expect(status.uptime).toEqual({ h1: null, d24: null })
    expect(model?.price).toEqual({ input: null, output: null, perCall: null })
    expect(status.overall).toBe("неизвестно")
  })

  test("частичные строки, повторные id и неверный unmeasured не создают доказательства удаления", () => {
    for (const models of [[{ id: "" }], ["junk"], [null], [{ id: "a" }, { id: "a" }]]) {
      expect(() => parseStatus({ updated: 1, models, unmeasured: [] })).toThrow(SiteError)
    }
    for (const unmeasured of [undefined, "partial", [42], ["a", "a"], ["measured"]]) {
      expect(() => parseStatus({ updated: 1, models: [{ id: "measured" }], unmeasured })).toThrow(SiteError)
    }
  })

  test("ограничивает список моделей и отвергает опасные id без изменения идентичности", () => {
    expect(() => parseStatus({ updated: 1, models: [], unmeasured: Array(10_001).fill("a") })).toThrow("слишком много")
    for (const id of [" a", "a ", "a\n", "a\u001b[31m", "a\u202eb", "a".repeat(257)]) {
      expect(() => parseStatus({ updated: 1, models: [{ id }], unmeasured: [] })).toThrow("id")
    }
    expect(() => parseStatus({ updated: -1, models: [], unmeasured: [] })).toThrow("времени")
  })

  test("проверяет диапазоны метрик, сохраняя настоящие нули", () => {
    const status = parseStatus({
      updated: 0,
      models: [measured("a", "down", "lab", 0, {
        checked_at: -1, latency_ms: -1, uptime_1h: 101, uptime_24h: Number.NaN, probes_1h: 1.5,
      })],
      unmeasured: [], uptime: { h1: 0, d24: Infinity }, median_latency_ms: -1,
    })
    expect(status.models[0]).toMatchObject({ checkedAt: null, latencyMs: null, uptime1h: null, uptime24h: null, probes1h: null })
    expect(status.uptime).toEqual({ h1: 0, d24: null })
    expect(status.medianLatencyMs).toBeNull()
    const zero = parseStatus({ updated: 0, models: [measured("a", "down", "lab", 0, { probes_1h: 0 })], unmeasured: [] })
    expect(zero.models[0]).toMatchObject({ uptime1h: 0, uptime24h: 0, probes1h: 0 })
  })

  test("очищает и ограничивает текст для отображения, но не создаёт полосы из мусора", () => {
    const status = parseStatus({
      updated: 1, overall: "up\n\u001b", unmeasured: [],
      models: [measured("a", "up", "lab\u0000\n", 0, { bars: "d".repeat(12) + "\n", price: { input: "x".repeat(600), output: "$1\r\n" } })],
    })
    expect(status.overall).toBe("up")
    expect(status.models[0]?.lab).toBe("lab")
    expect(status.models[0]?.price.input).toHaveLength(512)
    expect(status.models[0]?.price.output).toBe("$1")
    expect(status.models[0]?.bars).toBe("")
  })
})

describe("ранги", () => {
  test("parseRanksJson берёт только t1..t4", () => {
    const ranks = parseRanksJson({
      data: [
        { model_name: "a", enable_groups: ["early", "premium", "t2", "t4", "default"] },
        { model_name: "b", enable_groups: ["premium"] },
        { model_name: "", enable_groups: ["t1"] },
        "мусор",
      ],
    })
    expect([...ranks]).toEqual([["a", ["t2", "t4"]], ["b", []]])
  })

  test("parseRanksHtml пропускает заголовок и берёт ранги из последней ячейки", () => {
    const html = [
      "<table><tbody>",
      '<tr><th>Модель</th><td>Тип</td><td>Вход</td><td>Выход</td><td>Вызов</td><td>Ранги</td></tr>',
      '<tr data-kind="chat"><th scope="row" class="model-name">a&amp;b</th><td>чат</td>',
      '<td class="num">$1</td><td class="num">$2</td><td class="num">—</td>',
      "<td>🥉 Новичок, 🥇 Профи</td></tr>",
      '<tr data-kind="chat"><th scope="row" class="model-name">no-ranks</th><td>чат</td>',
      '<td class="num">—</td><td class="num">—</td><td class="num">—</td><td>—</td></tr>',
      "<tr><td>сломано</td></tr>",
      "</tbody></table>",
    ].join("")
    const ranks = parseRanksHtml(html)
    expect([...ranks]).toEqual([["a&b", ["t1", "t3"]], ["no-ranks", []]])
  })

  test("приоритет сайта берёт каталог, консервативный — пересечение", () => {
    const site = indexOf(new Map([["m", ["t2", "t3"]]]), new Map([["m", ["t1", "t2"]]]), "site")
    const conservative = indexOf(
      new Map([["m", ["t2", "t3"]]]),
      new Map([["m", ["t1", "t2"]]]),
      "conservative",
    )
    expect(site.get("m")).toEqual({
      ranks: ["t2", "t3"],
      source: "catalog",
      conflict: true,
    })
    expect(conservative.get("m")).toEqual({
      ranks: ["t2"],
      source: "both",
      conflict: true,
    })
  })

  test("модель только из api/pricing получает источник api", () => {
    const index = indexOf(new Map(), new Map([["only-api", ["t4"]]]), "site")
    expect(index.get("only-api")).toEqual({ ranks: ["t4"], source: "api", conflict: false })
  })

  test("известное пустое пересечение запрещает все ранги, неизвестный источник остаётся видимым", () => {
    const status = parseStatus({ updated: 1, models: [{ id: "denied" }, { id: "unknown" }], unmeasured: [] })
    const ranks = resolveRanks(new Map([["denied", ["t1"]]]), new Map([["denied", ["t4"]]]), "conservative")
    const catalog = mergeCatalog(status, ranks, [])
    expect(ranks.get("denied")).toEqual({ ranks: [], source: "both", conflict: true })
    expect(filterCatalog(catalog.models, { ...DEFAULT_FILTERS, rank: "t2" }).map((model) => model.id)).toEqual(["unknown"])
    expect(filterCatalog(catalog.models, DEFAULT_FILTERS)).toHaveLength(2)
    expect(optionFor(catalog.models.find((model) => model.id === "denied")!).description).toContain("нет доступных рангов")
  })

  test("известные пустые группы и пустой сайт не подменяются разрешениями другого источника", () => {
    const api = parseRanksJson({ data: [{ model_name: "m", enable_groups: [] }, { model_name: "unknown" }] })
    expect(api.has("unknown")).toBe(false)
    expect(resolveRanks(api, new Map([["m", ["t1"]]]), "site").get("m")?.ranks).toEqual([])
    expect(() => parseRanksJson({ data: [{ model_name: "m", enable_groups: [] }, { model_name: "m", enable_groups: [] }] })).toThrow("повторяющиеся")
  })
})

describe("mergeCatalog", () => {
  test("считает состояния сам и добавляет unmeasured/unlisted", () => {
    const catalog = fixtureCatalog()
    expect(catalog.counts).toEqual({
      up: 1,
      busy: 1,
      down: 1,
      unknown: 1,
      unmeasured: 1,
      unlisted: 1,
    })
    expect(catalog.models).toHaveLength(6)
    expect(catalog.models.find((model) => model.id === "m-media")?.state).toBe("unmeasured")
    expect(catalog.models.find((model) => model.id === "m-ghost")?.state).toBe("unlisted")
    expect(catalog.models.find((model) => model.id === "m-up")?.configured).toBe(true)
    expect(catalog.models.find((model) => model.id === "m-down")?.configured).toBe(false)
  })

  test("сортирует по состоянию и uptime, рабочее сверху", () => {
    const ids = fixtureCatalog().models.map((model) => model.id)
    expect(ids).toEqual(["m-up", "m-busy", "m-weird", "m-down", "m-media", "m-ghost"])
  })

  test("upByRank считает только рабочие модели", () => {
    const counts = upByRank(fixtureCatalog().models)
    expect(counts).toEqual({ t1: 1, t2: 1, t3: 1, t4: 0 })
  })

  test("labs возвращает уникальные лаборатории без заглушки", () => {
    expect(labs(fixtureCatalog().models)).toEqual(["glm", "gpt", "kimi", "qwen"])
  })

  test("заглушки сохраняют ранги, конфликты и показывают их в деталях", () => {
    const status = parseStatus({ updated: 1, models: [], unmeasured: ["media"] })
    const ranks = resolveRanks(new Map([["media", ["t2"]], ["ghost", ["t1"]]]), new Map([["media", ["t4"]]]), "conservative")
    const catalog = mergeCatalog(status, ranks, ["ghost"])
    const media = catalog.models.find((model) => model.id === "media")!
    const ghost = catalog.models.find((model) => model.id === "ghost")!
    expect(media).toMatchObject({ ranks: [], rankSource: "both", ranksConflict: true, uptime24h: null, probes1h: null })
    expect(ghost).toMatchObject({ ranks: ["t1"], rankSource: "catalog", uptime1h: null })
    expect(detailFor(media, catalog, 1000).message).toContain("нет доступных рангов")
    expect(detailFor(media, catalog, 1000).message).toContain("источники рангов расходятся")
    expect(detailFor(ghost, catalog, 1000).message).toContain("Новичок")
    expect(filterCatalog(catalog.models, { ...DEFAULT_FILTERS, rank: "t2", showUnlisted: true })).toHaveLength(0)
  })

  test("отсутствующие метрики не отображаются как нули", () => {
    const catalog = mergeCatalog(parseStatus({ updated: 1, models: [{ id: "bare" }], unmeasured: [] }), new Map(), [])
    expect(percent(null)).toBe("—")
    expect(percent(0)).toBe("0.0%")
    expect(detailFor(catalog.models[0]!, catalog, 1000).message).toContain("uptime: 1ч — · 24ч — · проб за час —")
  })
})

describe("filterCatalog", () => {
  const catalog = fixtureCatalog()

  test("по умолчанию скрывает модели вне каталога сайта", () => {
    expect(catalog.models.filter((model) => model.state === "unlisted")).toHaveLength(1)
    expect(filterCatalog(catalog.models, DEFAULT_FILTERS).some((model) => model.state === "unlisted")).toBe(false)
    expect(
      filterCatalog(catalog.models, { ...DEFAULT_FILTERS, showUnlisted: true }).some(
        (model) => model.state === "unlisted",
      ),
    ).toBe(true)
  })

  test("фильтрует по состоянию, лаборатории и типу", () => {
    expect(filterCatalog(catalog.models, { ...DEFAULT_FILTERS, state: "up" }).map((model) => model.id)).toEqual(["m-up"])
    expect(filterCatalog(catalog.models, { ...DEFAULT_FILTERS, lab: "glm" }).map((model) => model.id)).toEqual(["m-busy"])
    expect(filterCatalog(catalog.models, { ...DEFAULT_FILTERS, kind: "chat" })).toHaveLength(4)
    expect(filterCatalog(catalog.models, { ...DEFAULT_FILTERS, kind: "video" })).toHaveLength(0)
  })

  test("ранг отсекает чужие модели, но не теряет модели без данных", () => {
    const t2 = filterCatalog(catalog.models, { ...DEFAULT_FILTERS, rank: "t2" })
    expect(t2.map((model) => model.id)).toEqual(["m-up", "m-weird", "m-down", "m-media"])
    const t4 = filterCatalog(catalog.models, { ...DEFAULT_FILTERS, rank: "t4" })
    expect(t4.map((model) => model.id)).toEqual(["m-busy", "m-down", "m-media"])
  })

  test("configuredOnly оставляет только модели из конфига", () => {
    expect(
      filterCatalog(catalog.models, { ...DEFAULT_FILTERS, configuredOnly: true }).map((model) => model.id),
    ).toEqual(["m-up"])
  })
})
