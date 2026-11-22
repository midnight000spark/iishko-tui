/**
 * Диалог каталога: список моделей, фильтры, ранги и переключение аккаунтов.
 * Сеть приходит через `Loader`, поэтому весь цикл тестируется без OpenCode.
 */

import type { Account } from "./accounts.js"
import { detailFor, optionFor, titleFor } from "./format.js"
import type { CatalogLoad, Loader } from "./loader.js"
import { SiteError } from "./parse.js"
import {
  DEFAULT_FILTERS,
  RANKS,
  RANK_LABELS,
  STATE_LABELS,
  filterCatalog,
  labs,
  upByRank,
  type Catalog,
  type Filters,
  type Rank,
  type RankPriority,
} from "./site.js"

export type DialogSize = "medium" | "large" | "xlarge"

/** Опция диалога, обобщённая по типу значения. */
export interface Option<Value> {
  readonly title: string
  readonly value: Value
  readonly description?: string
  readonly footer?: string
  readonly category?: string
}

export interface SelectAction {
  readonly bind: string
  readonly title: string
  readonly selection: "none"
  readonly onTrigger: () => void
}

export interface SelectInput<Value> {
  readonly title: string
  readonly placeholder?: string
  readonly current?: Value
  readonly options: readonly Option<Value>[]
  readonly search?: (
    query: string,
    options: readonly Option<Value>[],
  ) => readonly Option<Value>[]
  readonly actions?: readonly SelectAction[]
}

/** Подмножество диалогового API плагина, которое нужно каталогу. */
export interface CatalogUi {
  size?(size: DialogSize): void
  select<Value>(input: SelectInput<Value>): Promise<Value | undefined>
  alert(input: { readonly title: string; readonly message: string }): Promise<void>
  toast(input: {
    readonly message: string
    readonly variant?: "info" | "success" | "warning" | "error"
    readonly duration?: number
  }): void
  clear(): void
}

export interface CatalogDeps {
  readonly ui: CatalogUi
  readonly loader: Loader
  /** Минимум один аккаунт; при выключенной опции это неявный reformbossV2. */
  readonly accounts: readonly Account[]
  readonly initialAccount: string
  /** Сохранённые ранги по id аккаунта; отсутствие ключа = ранг из конфига. */
  readonly ranks: Readonly<Record<string, Rank | null>>
  readonly priority: RankPriority
  /** id моделей провайдера активного аккаунта. */
  readonly configured: (account: Account) => readonly string[]
  readonly saveRank: (accountID: string, rank: Rank | null) => Promise<void>
  readonly savePriority: (priority: RankPriority) => Promise<void>
  /** Сохраняется только после успешной загрузки выбранного аккаунта. */
  readonly saveAccount?: (accountID: string) => Promise<void>
  readonly now?: () => number
  readonly signal?: AbortSignal
}

type Intent = "filters" | "rank" | "refresh" | "account"

interface Screen {
  readonly accountID: string
  readonly filters: Filters
  readonly priority: RankPriority
}

type Field = "state" | "lab" | "kind" | "rank" | "priority" | "configured" | "unlisted" | "reset"

/** Открывает каталог и держит диалог до Esc. */
export async function showCatalog(deps: CatalogDeps): Promise<void> {
  const ui = guardedUi(deps.ui, deps.signal)
  try {
    await browse({ ...deps, ui })
  } catch (error) {
    if (cancelled(deps.signal, error)) return
    try {
      await ui.alert({ title: "Каталог сайта недоступен", message: explain(error) })
    } catch (alertError) {
      if (!cancelled(deps.signal, alertError)) throw alertError
    }
  }
}

async function browse(deps: CatalogDeps): Promise<void> {
  check(deps.signal)
  const now = deps.now ?? Date.now
  const first = deps.accounts.find((account) => account.id === deps.initialAccount) ?? deps.accounts[0]
  if (first === undefined) return
  deps.ui.size?.("xlarge")

  // deps.ranks может быть неизменяемым снимком storage, а не живым объектом.
  const ranks = { ...deps.ranks }
  let screen: Screen = {
    accountID: first.id,
    priority: deps.priority,
    filters: { ...DEFAULT_FILTERS, rank: storedRank(ranks, first) },
  }

  let load = await reload(deps, screen)

  let warned = false
  for (;;) {
    check(deps.signal)
    if (!warned && load.warnings.length > 0) {
      deps.ui.toast({ message: load.warnings.join("; "), variant: "warning", duration: 8000 })
      warned = true
    }
    const visible = filterCatalog(load.catalog.models, screen.filters)
    if (visible.length === 0) {
      await deps.ui.alert({
        title: "Ничего не найдено",
        message: "Под текущие фильтры не подошла ни одна модель. Откройте фильтры и ослабьте условия.",
      })
      const next = await editFilters(deps.ui, screen, load.catalog)
      if (next.priority !== screen.priority) {
        const loaded = await reload(deps, next)
        await wait(deps.signal, () => deps.savePriority(next.priority))
        load = loaded
        warned = false
      }
      screen = next
      if (filterCatalog(load.catalog.models, screen.filters).length === 0) return
      continue
    }

    let intent: Intent | undefined
    const close = (next: Intent) => () => {
      // Поздний hotkey от уже закрытого диалога не должен трогать UI.
      if (deps.signal?.aborted === true) return
      intent = next
      deps.ui.clear()
    }
    const actions: SelectAction[] = [
      { bind: "ctrl+f", title: "Фильтры", selection: "none", onTrigger: close("filters") },
      { bind: "ctrl+g", title: "Ранг", selection: "none", onTrigger: close("rank") },
      { bind: "ctrl+o", title: "Обновить", selection: "none", onTrigger: close("refresh") },
    ]
    if (deps.accounts.length > 1) {
      actions.push({ bind: "ctrl+a", title: "Аккаунт", selection: "none", onTrigger: close("account") })
    }
    const choice = await deps.ui.select<string>({
      title: titleFor(
        load.catalog,
        screen.filters.rank,
        deps.accounts.length > 1 ? labelOf(deps, screen.accountID) : null,
        now(),
      ),
      placeholder: "поиск по id или лаборатории…",
      options: visible.map((model) => optionFor(model)),
      search: match,
      actions,
    })
    const wanted = intent

    if (wanted === "filters") {
      const next = await editFilters(deps.ui, screen, load.catalog)
      if (next.priority !== screen.priority) {
        const loaded = await reload(deps, next)
        await wait(deps.signal, () => deps.savePriority(next.priority))
        load = loaded
        warned = false
      }
      screen = next
      continue
    }
    if (wanted === "rank") {
      const picked = await pickRank(deps.ui, screen.filters.rank, load.catalog, labelOf(deps, screen.accountID))
      if (picked !== undefined) {
        await wait(deps.signal, () => deps.saveRank(screen.accountID, picked))
        ranks[screen.accountID] = picked
        screen = { ...screen, filters: { ...screen.filters, rank: picked ?? "any" } }
      }
      continue
    }
    if (wanted === "account") {
      const picked = await pickAccount(deps.ui, deps.accounts, screen.accountID)
      const account = deps.accounts.find((entry) => entry.id === picked)
      if (account !== undefined && account.id !== screen.accountID) {
        const next: Screen = {
          ...screen,
          accountID: account.id,
          filters: { ...screen.filters, rank: storedRank(ranks, account) },
        }
        const loaded = await reload(deps, next)
        const saveAccount = deps.saveAccount
        if (saveAccount !== undefined) {
          await wait(deps.signal, () => saveAccount(account.id))
        }
        check(deps.signal)
        screen = next
        load = loaded
        warned = false
      }
      continue
    }
    if (wanted === "refresh") {
      load = await reload(deps, screen, true)
      warned = false
      continue
    }
    if (choice === undefined) return
    const model = visible.find((entry) => entry.id === choice)
    if (model !== undefined) await deps.ui.alert(detailFor(model, load.catalog, now()))
  }
}

async function reload(
  deps: CatalogDeps,
  screen: Screen,
  force = false,
): Promise<CatalogLoad> {
  check(deps.signal)
  const configured = configuredFor(deps, screen.accountID)
  // Только Loader решает, допустим ли его сырой кэш. Старый merged-каталог
  // нельзя переиспользовать под другим аккаунтом/приоритетом или после expiry.
  return wait(deps.signal, () => deps.loader.load({
    force,
    configured,
    priority: screen.priority,
    signal: deps.signal,
  }))
}

function check(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new DOMException("Каталог закрыт", "AbortError")
}

function cancelled(signal: AbortSignal | undefined, error: unknown): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError")
}

function invoke<Value>(signal: AbortSignal | undefined, operation: () => Value): Value {
  check(signal)
  const value = operation()
  check(signal)
  return value
}

async function wait<Value>(signal: AbortSignal | undefined, operation: () => Promise<Value>): Promise<Value> {
  check(signal)
  const value = await operation()
  check(signal)
  return value
}

/** Единая граница lifetime для всех главных и вложенных диалогов. */
function guardedUi(ui: CatalogUi, signal?: AbortSignal): CatalogUi {
  return {
    size: (size) => invoke(signal, () => ui.size?.(size)),
    select: <Value>(input: SelectInput<Value>) => wait(signal, () => ui.select(input)),
    alert: (input) => wait(signal, () => ui.alert(input)),
    toast: (input) => invoke(signal, () => ui.toast(input)),
    clear: () => invoke(signal, () => ui.clear()),
  }
}

async function editFilters(ui: CatalogUi, screen: Screen, catalog: Catalog): Promise<Screen> {
  let { filters } = screen
  let { priority } = screen
  for (;;) {
    const choice = await ui.select<Field>({
      title: "Фильтры каталога",
      options: [
        { title: `Состояние: ${stateValue(filters.state)}`, value: "state" },
        { title: `Лаборатория: ${filters.lab === "all" ? "все" : filters.lab}`, value: "lab" },
        { title: `Тип: ${filters.kind === "all" ? "любой" : filters.kind}`, value: "kind" },
        { title: `Ранг: ${filters.rank === "any" ? "любой" : RANK_LABELS[filters.rank]}`, value: "rank" },
        {
          title: `Источники рангов: ${priority === "site" ? "каталог сайта" : "пересечение"}`,
          value: "priority",
        },
        { title: `Только в конфиге: ${filters.configuredOnly ? "да" : "нет"}`, value: "configured" },
        {
          title: `Показывать отсутствующие на сайте: ${filters.showUnlisted ? "да" : "нет"} (${catalog.counts.unlisted})`,
          value: "unlisted",
        },
        { title: "Сбросить все фильтры", value: "reset" },
      ],
    })
    if (choice === undefined) return { ...screen, filters, priority }

    if (choice === "state") {
      const value = await ui.select<Filters["state"]>({
        title: "Состояние",
        current: filters.state,
        options: [
          { title: "Любое", value: "all" },
          { title: "🟢 тест прошёл", value: "up" },
          { title: "⏳ только 429", value: "busy" },
          { title: "🔴 тест не прошёл", value: "down" },
          { title: "❓ нет свежего замера", value: "unknown" },
          { title: "➖ не измеряется", value: "unmeasured" },
          { title: "⚠️ нет в каталоге сайта", value: "unlisted" },
        ],
      })
      if (value !== undefined) filters = { ...filters, state: value }
      continue
    }
    if (choice === "lab") {
      const value = await ui.select<string>({
        title: "Лаборатория",
        current: filters.lab,
        options: [
          { title: "Все", value: "all" },
          ...labs(catalog.models).map((lab) => ({ title: lab, value: lab })),
        ],
      })
      if (value !== undefined) filters = { ...filters, lab: value }
      continue
    }
    if (choice === "kind") {
      const value = await ui.select<Filters["kind"]>({
        title: "Тип модели",
        current: filters.kind,
        options: [
          { title: "Любой", value: "all" },
          { title: "чат", value: "chat" },
          { title: "изображения", value: "image" },
          { title: "видео", value: "video" },
          { title: "прочее", value: "other" },
        ],
      })
      if (value !== undefined) filters = { ...filters, kind: value }
      continue
    }
    if (choice === "rank") {
      const value = await ui.select<"any" | Rank>({
        title: "Ранг модели",
        current: filters.rank,
        options: [
          { title: "Любой", value: "any" },
          ...RANKS.map((rank) => ({ title: `${rank} · ${RANK_LABELS[rank]}`, value: rank })),
        ],
      })
      if (value !== undefined) filters = { ...filters, rank: value }
      continue
    }
    if (choice === "priority") {
      priority = await pickPriority(ui, priority)
      continue
    }
    if (choice === "configured") {
      filters = { ...filters, configuredOnly: !filters.configuredOnly }
      continue
    }
    if (choice === "unlisted") {
      filters = { ...filters, showUnlisted: !filters.showUnlisted }
      continue
    }
    // Ранг здесь — временный фильтр. Сохранённый ранг аккаунта меняет ctrl+g,
    // поэтому reset очищает и этот фильтр, но не пишет storage и не меняет priority.
    filters = { ...DEFAULT_FILTERS }
  }
}

async function pickRank(
  ui: CatalogUi,
  current: "any" | Rank,
  catalog: Catalog,
  account: string,
): Promise<Rank | null | undefined> {
  const counts = upByRank(catalog.models)
  const picked = await ui.select<"any" | Rank>({
    title: `Ранг аккаунта · ${account}`,
    current,
    options: [
      { title: "Любой ранг", value: "any" },
      ...RANKS.map((rank) => ({
        title: `${rank} · ${RANK_LABELS[rank]} · ${counts[rank]} up`,
        value: rank,
      })),
    ],
  })
  if (picked === undefined) return undefined
  return picked === "any" ? null : picked
}

async function pickAccount(
  ui: CatalogUi,
  accounts: readonly Account[],
  current: string,
): Promise<string | undefined> {
  return ui.select<string>({
    title: "Аккаунт ИИШКО",
    current,
    options: accounts.map((account) => ({
      title: account.label,
      value: account.id,
      description: account.rank === null ? "ранг не задан" : RANK_LABELS[account.rank],
    })),
  })
}

async function pickPriority(ui: CatalogUi, current: RankPriority): Promise<RankPriority> {
  const picked = await ui.select<RankPriority>({
    title: "Источники рангов",
    current,
    options: [
      { title: "Каталог сайта (приоритет)", value: "site" },
      { title: "Пересечение каталога и /api/pricing", value: "conservative" },
    ],
  })
  return picked ?? current
}

function storedRank(ranks: CatalogDeps["ranks"], account: Account): "any" | Rank {
  const stored = Object.hasOwn(ranks, account.id) ? ranks[account.id] : account.rank
  return stored ?? "any"
}

function configuredFor(deps: CatalogDeps, accountID: string): readonly string[] {
  const account = deps.accounts.find((entry) => entry.id === accountID)
  return account === undefined ? [] : deps.configured(account)
}

function labelOf(deps: CatalogDeps, accountID: string): string {
  return deps.accounts.find((entry) => entry.id === accountID)?.label ?? accountID
}

function stateValue(state: Filters["state"]): string {
  return state === "all" ? "любое" : STATE_LABELS[state]
}

function match(query: string, options: readonly Option<string>[]): readonly Option<string>[] {
  const needle = query.trim().toLowerCase()
  if (needle === "") return options
  return options.filter((option) =>
    `${option.title} ${option.value} ${option.description ?? ""} ${option.footer ?? ""}`
      .toLowerCase()
      .includes(needle),
  )
}

function explain(error: unknown): string {
  if (error instanceof SiteError) {
    if (error.code === "http") return `Сайт ответил ошибкой: ${error.message}. Повторите позже.`
    if (error.code === "network") return `Сеть недоступна: ${error.message}.`
    return `Неожиданный формат ответа сайта: ${error.message}.`
  }
  return error instanceof Error ? error.message : String(error)
}
