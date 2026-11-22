/**
 * Публичные данные ИИШКО Gateway: разбор `/api/status.json`, слияние рангов из
 * каталога сайта и `/api/pricing`, фильтрация. Модуль чистый: без сети, таймеров
 * и глобального состояния.
 */

export type Rank = "t1" | "t2" | "t3" | "t4"
export type SiteState = "up" | "busy" | "down" | "unknown"
export type CatalogState = SiteState | "unmeasured" | "unlisted"
export type ModelKind = "chat" | "image" | "video" | "other"
/** Каталог сайта главнее или пересечение источников рангов. */
export type RankPriority = "site" | "conservative"

export const RANKS: readonly Rank[] = ["t1", "t2", "t3", "t4"]

export const RANK_LABELS: Readonly<Record<Rank, string>> = {
  t1: "Новичок",
  t2: "Актив",
  t3: "Профи",
  t4: "Легенда",
}

export const STATE_LABELS: Readonly<Record<CatalogState, string>> = {
  up: "тест прошёл",
  busy: "только 429",
  down: "тест не прошёл",
  unknown: "нет свежего замера",
  unmeasured: "не измеряется",
  unlisted: "нет в каталоге сайта",
}

export const STATE_ICONS: Readonly<Record<CatalogState, string>> = {
  up: "🟢",
  busy: "⏳",
  down: "🔴",
  unknown: "❓",
  unmeasured: "➖",
  unlisted: "⚠️",
}

/** Порядок группировки и сортировки: рабочее сверху, мусор снизу. */
const STATE_ORDER: readonly CatalogState[] = [
  "up",
  "busy",
  "unknown",
  "down",
  "unmeasured",
  "unlisted",
]

export const SITE_STATES: readonly SiteState[] = ["up", "busy", "down", "unknown"]

export interface Price {
  readonly input: string | null
  readonly output: string | null
  readonly perCall: string | null
}

export interface MeasuredModel {
  readonly id: string
  readonly lab: string
  readonly kind: ModelKind
  readonly state: SiteState
  readonly checkedAt: number | null
  readonly latencyMs: number | null
  readonly uptime1h: number | null
  readonly uptime24h: number | null
  readonly probes1h: number | null
  readonly bars: string
  readonly price: Price
}

export interface ParsedStatus {
  readonly updated: number
  readonly overall: string
  readonly uptime: { readonly h1: number | null; readonly d24: number | null }
  readonly medianLatencyMs: number | null
  readonly models: readonly MeasuredModel[]
  readonly unmeasured: readonly string[]
}

export interface CatalogModel {
  readonly id: string
  readonly lab: string
  readonly kind: ModelKind
  readonly state: CatalogState
  readonly checkedAt: number | null
  readonly latencyMs: number | null
  readonly uptime1h: number | null
  readonly uptime24h: number | null
  readonly probes1h: number | null
  readonly bars: string
  readonly price: Price
  /** Пустой список при известном источнике означает запрет для всех рангов. */
  readonly ranks: readonly Rank[]
  readonly rankSource: "catalog" | "api" | "both" | "unknown"
  /** HTML-каталог и `/api/pricing` расходятся по составу рангов. */
  readonly ranksConflict: boolean
  /** id есть в providers.reformbossV2.models. */
  readonly configured: boolean
}

export interface Catalog {
  readonly updated: number
  readonly overall: string
  readonly uptime: { readonly h1: number | null; readonly d24: number | null }
  readonly medianLatencyMs: number | null
  readonly counts: Readonly<Record<CatalogState, number>>
  readonly models: readonly CatalogModel[]
}

export interface Filters {
  readonly state: "all" | CatalogState
  readonly lab: "all" | string
  readonly kind: "all" | ModelKind
  readonly rank: "any" | Rank
  readonly configuredOnly: boolean
  readonly showUnlisted: boolean
}

export const DEFAULT_FILTERS: Filters = {
  state: "all",
  lab: "all",
  kind: "all",
  rank: "any",
  configuredOnly: false,
  showUnlisted: false,
}

export type RankMap = ReadonlyMap<string, readonly Rank[]>

/** Итог слияния источников для одной модели. */
export interface RankResolution {
  readonly ranks: readonly Rank[]
  readonly source: "catalog" | "api" | "both" | "unknown"
  readonly conflict: boolean
}

export type RankIndex = ReadonlyMap<string, RankResolution>

/**
 * Сливает два источника рангов. `site` берёт каталог сайта, `conservative` —
 * пересечение; расхождение фиксируется в `conflict` при любом режиме.
 */
export function resolveRanks(catalog: RankMap, api: RankMap, priority: RankPriority): RankIndex {
  const ids = new Set([...catalog.keys(), ...api.keys()])
  const merged: Map<string, RankResolution> = new Map()
  for (const id of ids) {
    const fromCatalog = catalog.get(id)
    const fromApi = api.get(id)
    const conflict =
      fromCatalog !== undefined && fromApi !== undefined && !sameRanks(fromCatalog, fromApi)
    const shared = intersect(fromCatalog, fromApi)
    const chosen =
      priority === "site" ? (fromCatalog ?? fromApi) : (shared ?? fromCatalog ?? fromApi)
    const source =
      priority === "conservative" && fromCatalog !== undefined && fromApi !== undefined
        ? "both"
        : fromCatalog !== undefined
          ? "catalog"
          : fromApi !== undefined
            ? "api"
            : "unknown"
    merged.set(id, { ranks: chosen ?? [], source, conflict })
  }
  return merged
}

/** Собирает каталог из трёх списков: измеренные, unmeasured, только в конфиге. */
export function mergeCatalog(
  status: ParsedStatus,
  ranks: RankIndex,
  configured: readonly string[],
): Catalog {
  const configuredSet = new Set(configured)
  const byId = new Map<string, CatalogModel>()

  for (const model of status.models) {
    byId.set(model.id, toCatalogModel(model, ranks, configuredSet))
  }
  for (const id of status.unmeasured) {
    if (!byId.has(id)) byId.set(id, placeholder(id, "unmeasured", configuredSet, ranks))
  }
  for (const id of configured) {
    if (!byId.has(id)) byId.set(id, placeholder(id, "unlisted", configuredSet, ranks))
  }

  const models = [...byId.values()].sort(compareModels)
  return {
    updated: status.updated,
    overall: status.overall,
    uptime: status.uptime,
    medianLatencyMs: status.medianLatencyMs,
    counts: countStates(models),
    models,
  }
}

export function filterCatalog(
  models: readonly CatalogModel[],
  filters: Filters,
): readonly CatalogModel[] {
  return models.filter((model) => {
    if (!filters.showUnlisted && model.state === "unlisted") return false
    if (filters.state !== "all" && model.state !== filters.state) return false
    if (filters.lab !== "all" && model.lab !== filters.lab) return false
    if (filters.kind !== "all" && model.kind !== filters.kind) return false
    if (filters.configuredOnly && !model.configured) return false
    if (
      filters.rank !== "any" &&
      model.rankSource !== "unknown" &&
      !model.ranks.includes(filters.rank)
    ) {
      return false
    }
    return true
  })
}

/** Лаборатории, реально присутствующие в каталоге, по алфавиту. */
export function labs(models: readonly CatalogModel[]): readonly string[] {
  const found = new Set<string>()
  for (const model of models) {
    if (model.lab !== "" && model.lab !== "—") found.add(model.lab)
  }
  return [...found].sort((left, right) => left.localeCompare(right))
}

/** Сколько `up`-моделей доступно на каждом ранге. */
export function upByRank(models: readonly CatalogModel[]): Readonly<Record<Rank, number>> {
  const counts: Record<Rank, number> = { t1: 0, t2: 0, t3: 0, t4: 0 }
  for (const model of models) {
    if (model.state !== "up") continue
    for (const rank of model.ranks) counts[rank] += 1
  }
  return counts
}

function toCatalogModel(
  model: MeasuredModel,
  index: RankIndex,
  configured: ReadonlySet<string>,
): CatalogModel {
  const resolution = index.get(model.id)
  return {
    ...model,
    ranks: resolution?.ranks ?? [],
    rankSource: resolution?.source ?? "unknown",
    ranksConflict: resolution?.conflict ?? false,
    configured: configured.has(model.id),
  }
}

function placeholder(
  id: string,
  state: "unmeasured" | "unlisted",
  configured: ReadonlySet<string>,
  index: RankIndex,
): CatalogModel {
  const resolution = index.get(id)
  return {
    id,
    lab: "—",
    kind: "other",
    state,
    checkedAt: null,
    latencyMs: null,
    uptime1h: null,
    uptime24h: null,
    probes1h: null,
    bars: "",
    price: { input: null, output: null, perCall: null },
    ranks: resolution?.ranks ?? [],
    rankSource: resolution?.source ?? "unknown",
    ranksConflict: resolution?.conflict ?? false,
    configured: configured.has(id),
  }
}

function countStates(models: readonly CatalogModel[]): Record<CatalogState, number> {
  const counts: Record<CatalogState, number> = {
    up: 0,
    busy: 0,
    down: 0,
    unknown: 0,
    unmeasured: 0,
    unlisted: 0,
  }
  for (const model of models) counts[model.state] += 1
  return counts
}

function compareModels(left: CatalogModel, right: CatalogModel): number {
  const byState = orderOf(left.state) - orderOf(right.state)
  if (byState !== 0) return byState
  const byUptime = (right.uptime24h ?? -1) - (left.uptime24h ?? -1)
  return byUptime !== 0 ? byUptime : left.id.localeCompare(right.id)
}

function orderOf(state: CatalogState): number {
  return STATE_ORDER.indexOf(state)
}

function intersect(
  left: readonly Rank[] | undefined,
  right: readonly Rank[] | undefined,
): readonly Rank[] | undefined {
  if (left === undefined || right === undefined) return undefined
  return left.filter((rank) => right.includes(rank))
}

function sameRanks(left: readonly Rank[], right: readonly Rank[]): boolean {
  return left.length === right.length && left.every((rank) => right.includes(rank))
}
