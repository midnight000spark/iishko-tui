/** One local operation owns its dialogs, cancellation and exact approved artifact. */
import { createHash } from "node:crypto"
import { catalogAccounts, readStore, type AccountStore } from "./accounts.js"
import { showCatalog, type CatalogDeps, type CatalogUi, type SelectInput } from "./catalog.js"
import { isRecord, modelEntries, parseConfig, replaceModels } from "./config-document.js"
import type { DiscoveryOptions, LocalAccount } from "./discovery.js"
import type { Loader } from "./loader.js"
import type { PublicData } from "./public-data.js"
import { buildRefreshPlan, type RefreshMode } from "./refresh-plan.js"
import { createSchemaValidator } from "./schema.js"
import { RANKS, RANK_LABELS, type Rank } from "./site.js"
import { applyUpdate, prepareUpdate } from "./transaction.js"

export interface ControllerUi extends CatalogUi {
  confirm(input: {
    readonly title: string; readonly message: string
    readonly label?: { readonly confirm: string; readonly cancel: string }
  }): Promise<boolean | undefined>
}

export interface ControllerDeps {
  readonly ui: ControllerUi
  readonly discover: (options: DiscoveryOptions) => Promise<readonly LocalAccount[]>
  readonly read: (path: string, signal: AbortSignal) => Promise<string>
  readonly loader: Loader
  readonly documents: PublicData
  readonly state: () => unknown
  /** Implementations must also guard the actual async storage mutation with signal. */
  readonly save: (state: AccountStore, signal: AbortSignal) => Promise<void>
  readonly configPath?: string
  readonly compatibility?: "supported" | "old" | "unknown"
  readonly now?: () => number
  readonly catalog?: (deps: CatalogDeps) => Promise<void>
  readonly build?: typeof buildRefreshPlan
  readonly prepare?: typeof prepareUpdate
  readonly apply?: typeof applyUpdate
  readonly validator?: typeof createSchemaValidator
}

export interface Controller {
  menu(): Promise<void>
  catalog(): Promise<void>
  refresh(): Promise<void>
  dispose(): void
}

type Operation = { readonly abort: AbortController; readonly ui: ControllerUi }
type Built = ReturnType<typeof buildRefreshPlan>
type Choice = "refresh" | "catalog" | "help"

const HELP = "Этот инструмент работает только с ЛОКАЛЬНЫМ конфигом на машине, где запущен TUI, не с подключённым удалённым сервером. Аккаунты и отметки моделей берутся из локальных файлов. Ключи не читаются; платных API-запросов и проб нет. Используются публичные данные сайта, models.dev и официальная схема. Старые Python-команды pull/probe/plan/apply намеренно заменены встроенным обновлением: выбор → предпросмотр → подтверждение → бэкап. Меняется только models выбранного провайдера в указанном файле; унаследованные/встроенные модели вне этого файла не удаляются."
const LOCAL_CONFIG_HELP = "Проверьте глобальный opencode.json/jsonc: providers.<id>.settings.baseURL должен явно указывать на https://api.reformboss.com/v1 (или https://reformboss.com/v1), а models — быть задан в том же файле. Один провайдер не должен повторяться в нескольких конфигурациях; уберите конфликтующие project/inline-настройки. Для другого локального файла задайте абсолютный configPath в настройках плагина."
const FAILURE = `Операция не завершена. ${LOCAL_CONFIG_HELP} Проверьте права доступа, публичные данные и схему; создайте новый предпросмотр. При изменении файла или занятой блокировке запись запрещена. Если запись уже началась, проверьте файл и бэкап перед повтором. Содержимое конфига и текст системных ошибок не выводятся.`

export function compatibility(version: string, channel = ""): "supported" | "old" | "unknown" {
  if (/canary|nightly|dev|preview/i.test(channel)) return "unknown"
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z.-]+)?$/.exec(version)
  if (!match) return "unknown"
  const parts = match.slice(1, 4).map(Number)
  if (!parts.every(Number.isSafeInteger)) return "unknown"
  const [major = 0, minor = 0, patch = 0] = parts
  if (major > 2) return "unknown"
  return major === 2 && (minor > 2 || minor === 2 && patch >= 5) ? "supported" : "old"
}

export function createController(deps: ControllerDeps): Controller {
  let disposed = false
  let active: Operation | undefined
  const now = deps.now ?? Date.now
  const state = () => readStore(deps.state())
  const save = (op: Operation, next: AccountStore) => wait(op, () => deps.save(next, op.abort.signal))
  const discover = (op: Operation) => wait(op, () => deps.discover({
    ...(deps.configPath === undefined ? {} : { configPath: deps.configPath }), signal: op.abort.signal,
  }))

  async function accounts(op: Operation): Promise<readonly LocalAccount[]> {
    const found = await discover(op)
    if (!found.length) await op.ui.alert({ title: "Локальный аккаунт ИИШКО не найден", message: LOCAL_CONFIG_HELP })
    return found
  }

  async function catalog(op: Operation): Promise<void> {
    const local = await accounts(op)
    if (!local.length) return
    const initial = state()
    const first = local.find((entry) => entry.providerID === initial.activeAccount) ?? local[0]!
    await wait(op, () => (deps.catalog ?? showCatalog)({
      ui: op.ui, loader: deps.loader, accounts: catalogAccounts(local),
      initialAccount: first.providerID, ranks: initial.ranks, priority: initial.priority,
      configured: (account) => Object.keys(local.find((entry) => entry.providerID === account.providerID)?.models ?? {}),
      saveRank: (id, rank) => save(op, { ...state(), ranks: { ...state().ranks, [id]: rank } }),
      savePriority: (priority) => save(op, { ...state(), priority }),
      saveAccount: (activeAccount) => save(op, { ...state(), activeAccount }),
      now, signal: op.abort.signal,
    }))
  }

  async function refresh(op: Operation): Promise<void> {
    const local = await accounts(op)
    if (!local.length) return
    const account = await pickAccount(op, local, state().activeAccount)
    if (!account) return
    const stored = state().ranks[account.providerID]
    const rank = await op.ui.select<Rank>({
      title: `Подтвердите ранг аккаунта · ${display(account.label)}`,
      current: stored ?? undefined,
      options: RANKS.map((value) => ({ title: `${value} · ${RANK_LABELS[value]}`, value })),
    })
    if (rank === undefined || !RANKS.includes(rank)) return
    await save(op, { ...state(), ranks: { ...state().ranks, [account.providerID]: rank }, activeAccount: account.providerID })
    const mode = await op.ui.select<RefreshMode>({
      title: "Локальное обновление · режим", current: "add",
      options: [
        { title: "Только добавить (безопасный вариант)", value: "add", description: "Добавить доступные модели выбранного ранга, не удалять существующие." },
        { title: "Полная синхронизация", value: "full", description: "Добавить доступные; удалить только доказанно неработающие (uptime ≤10%, ≥12 неудачных отметок). Отсутствующие на сайте модели сохраняются." },
      ],
    })
    if (mode !== "add" && mode !== "full") return
    await preview(op, local, account, rank, mode)
  }

  async function preview(op: Operation, local: readonly LocalAccount[], account: LocalAccount,
    rank: Rank, mode: RefreshMode): Promise<void> {
    const before = await wait(op, () => deps.read(account.path, op.abort.signal))
    assertEndpoint(before, account.providerID)
    const existing = modelEntries(before, account.providerID)
    op.ui.toast({ message: "Загружаю публичные данные и проверяю локальный конфиг…", variant: "info" })
    const priority = state().priority
    const [load, metadata, schema, modelSchema] = await wait(op, () => Promise.all([
      deps.loader.load({ force: true, configured: Object.keys(existing), priority, signal: op.abort.signal }),
      deps.documents.load("metadata", op.abort.signal).then((value) => ({ value, failed: false }), () => ({ value: undefined, failed: true })),
      deps.documents.load("schema", op.abort.signal),
      deps.documents.load("modelSchema", op.abort.signal),
    ]))
    if (load.stale === true) throw new Error("stale public status refused")
    const built = (deps.build ?? buildRefreshPlan)({
      catalog: load.catalog, existing, providerID: account.providerID, rank, mode, priority,
      // The public source does not guarantee authoritative listing completeness.
      metadata: metadata.value, now: now(), allowUnlistedRemoval: false,
    })
    const after = replaceModels(before, account.providerID, built.models)
    const validate = (deps.validator ?? createSchemaValidator)(schema, modelSchema)
    validate(parseConfig(after).value)
    const warnings = [...load.warnings, ...built.warnings,
      ...(metadata.failed ? ["Метаданные models.dev недоступны: недостающие поля не выдумываются."] : [])]
    const summary = summaryFor(account, built, warnings)
    const prepared = (deps.prepare ?? prepareUpdate)({ path: account.path, providerID: account.providerID,
      before, after, summary, createdAt: now() })
    if (!await inspect(op, built, warnings, prepared.summary)) return
    const allowed = await op.ui.confirm({ title: "Записать именно этот локальный предпросмотр?", message: prepared.summary,
      label: { confirm: "Записать с бэкапом", cancel: "Отмена" } })
    if (allowed !== true) return
    // Re-resolve ALL local owners: an added override must not silently change routing.
    const current = await discover(op)
    if (owners(current) !== owners(local) || !current.some((entry) => entry.providerID === account.providerID && entry.path === account.path)) {
      throw new Error("local owner changed")
    }
    op.ui.toast({ message: "Повторная проверка и безопасная запись…", variant: "info" })
    const result = await wait(op, () => (deps.apply ?? applyUpdate)(prepared, prepared.identity, {
      signal: op.abort.signal, now,
      validate: (text) => { check(op); assertEndpoint(text, account.providerID); validate(parseConfig(text).value); check(op) },
    }))
    await op.ui.alert({ title: "Локальный конфиг обновлён", message: `Провайдер: ${display(account.providerID)}\nФайл: ${display(account.path)}\nБэкап: ${display(result.backupPath)}\n${result.warning ? `${display(result.warning)}\n` : ""}OpenCode подхватывает изменения автоматически; при необходимости /reload. Удалённый сервер не изменялся.` })
  }

  async function dispatch(op: Operation, choice: Choice): Promise<void> {
    if (choice === "help") return op.ui.alert({ title: "ИИШКО · локальный инструмент", message: HELP })
    if (deps.compatibility !== undefined && deps.compatibility !== "supported") {
      return op.ui.alert({ title: "Совместимость OpenCode не подтверждена", message: deps.compatibility === "old"
        ? "Нужен стабильный OpenCode 2.x версии не ниже 2.2.5. Обновите приложение перед использованием инструмента."
        : "Не удалось подтвердить стабильную версию OpenCode 2.x не ниже 2.2.5 (неизвестная версия, будущая major-версия или canary). Каталог и запись отключены; используйте поддерживаемую стабильную версию." })
    }
    if (choice === "catalog") return catalog(op)
    return refresh(op)
  }

  async function run(choice?: Choice): Promise<void> {
    // Acquired synchronously before any await; menu dispatch keeps this SAME token.
    if (disposed || active) return
    const abort = new AbortController()
    const op: Operation = { abort, ui: guardedUi(deps.ui, abort.signal) }
    active = op
    try {
      const selected = choice ?? await op.ui.select<Choice>({
        title: "ИИШКО · ЛОКАЛЬНЫЙ конфиг этой машины", current: "refresh",
        options: [
          { title: "Обновить модели · предпросмотр и бэкап", value: "refresh" },
          { title: "Каталог сайта · локальные отметки", value: "catalog" },
          { title: "Помощь · область действия и безопасность", value: "help" },
        ],
      })
      check(op)
      if (selected === "refresh" || selected === "catalog" || selected === "help") await dispatch(op, selected)
    } catch {
      // Never print arbitrary parser/network/filesystem errors: they can contain config secrets.
      if (!op.abort.signal.aborted && !disposed) op.ui.toast({ message: FAILURE, variant: "error", duration: 12000 })
    } finally {
      abort.abort()
      if (active === op) active = undefined
    }
  }

  return {
    menu: () => run(), catalog: () => run("catalog"), refresh: () => run("refresh"),
    dispose() {
      if (disposed) return
      disposed = true
      const op = active
      // Close owned pending dialog BEFORE abort; never issue delayed UI effects after abort.
      try { if (op) deps.ui.clear() } finally { op?.abort.abort() }
    },
  }
}

function check(op: Operation): void { op.abort.signal.throwIfAborted() }

/** Settles promptly even if a host dialog/storage promise ignores cancellation. */
function abortable<Value>(signal: AbortSignal, operation: () => Promise<Value>): Promise<Value> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException("Операция закрыта", "AbortError"))
    signal.addEventListener("abort", abort, { once: true })
    Promise.resolve().then(() => { signal.throwIfAborted(); return operation() }).then(
      (value) => { signal.removeEventListener("abort", abort); if (signal.aborted) abort(); else resolve(value) },
      (error: unknown) => { signal.removeEventListener("abort", abort); reject(error) },
    )
  })
}

function wait<Value>(op: Operation, operation: () => Promise<Value>): Promise<Value> {
  return abortable(op.abort.signal, operation)
}

function guardedUi(ui: ControllerUi, signal: AbortSignal): ControllerUi {
  const invoke = (effect: () => void) => { signal.throwIfAborted(); effect() }
  return {
    select: <Value>(input: SelectInput<Value>) => abortable(signal, () => ui.select(input)),
    alert: (input) => abortable(signal, () => ui.alert(input)),
    confirm: (input) => abortable(signal, () => ui.confirm(input)),
    toast: (input) => invoke(() => ui.toast(input)), clear: () => invoke(() => ui.clear()),
    size: (size) => invoke(() => ui.size?.(size)),
  }
}

async function pickAccount(op: Operation, accounts: readonly LocalAccount[], active?: string): Promise<LocalAccount | undefined> {
  if (accounts.length === 1) return accounts[0]
  const picked = await op.ui.select<string>({ title: "Аккаунт · только локальная конфигурация", current: active,
    options: accounts.map((entry) => ({ title: display(entry.label), value: entry.providerID, description: display(entry.path) })) })
  return accounts.find((entry) => entry.providerID === picked)
}

function assertEndpoint(text: string, id: string): void {
  const providers = parseConfig(text).value.providers
  const provider = isRecord(providers) && Object.hasOwn(providers, id) ? providers[id] : undefined
  const settings = isRecord(provider) ? provider.settings : undefined
  if (!isRecord(provider) || provider.canonical !== undefined || !isRecord(settings) || typeof settings.baseURL !== "string") throw new Error("routing unavailable")
  const url = new URL(settings.baseURL)
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash
    || !["api.reformboss.com", "reformboss.com"].includes(url.hostname) || !["/v1", "/v1/"].includes(url.pathname)) throw new Error("unsupported endpoint")
}

function owners(accounts: readonly LocalAccount[]): string {
  return JSON.stringify(accounts.map((entry) => [entry.providerID, entry.path]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
}

function display(value: string, limit = 1024): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/gu, "").slice(0, limit)
}

function summaryFor(account: LocalAccount, built: Built, warnings: readonly string[]): string {
  const plan = built.plan
  const evidence = createHash("sha256").update(JSON.stringify({ plan, warnings })).digest("hex")
  return ["Область: только ЛОКАЛЬНЫЙ файл этой машины, не удалённый сервер.",
    `Файл: ${display(account.path)}`, `Провайдер: ${display(account.providerID)}`,
    `Режим: ${plan.mode === "add" ? "только добавить (без удаления)" : "полная синхронизация"}; ранг: ${plan.rank}; ранги: ${plan.priority}`,
    `Удалять отсутствующие: ${plan.evidence.pruneUnlisted ? "ДА — явно разрешено" : "НЕТ"}; статус сайта: ${plan.updated}`,
    `Добавить: ${plan.add.length}; удалить: ${plan.remove.length}; сохранить при неопределённости: ${plan.keptUncertain.length}; неизвестный ранг: ${plan.rankUnknown.length}; итог: ${plan.models.length}.`,
    `Удаления: отказ сайта ${plan.removed.failed.length}, отсутствуют ${plan.removed.unlisted.length}, политика ${plan.removed.forced.length}.`,
    `Предупреждений: ${warnings.length}`, ...warnings.slice(0, 5).map((warning) => `• ${display(warning, 240)}`),
    "Полные списки доступны в предпросмотре. До записи будет создан уникальный бэкап рядом с файлом. Меняется только models этого провайдера, не все эффективные источники моделей.",
    `Отпечаток данных/политики: ${evidence}`,
  ].join("\n")
}

async function inspect(op: Operation, built: Built, warnings: readonly string[], summary: string): Promise<boolean> {
  const groups = [
    { title: "Добавления", values: built.plan.add }, { title: "Удаления", values: built.plan.remove },
    { title: "Сохранены при неопределённости", values: built.plan.keptUncertain },
    { title: "Неизвестный ранг — не добавлены", values: built.plan.rankUnknown },
    { title: "Предупреждения", values: warnings },
  ]
  for (;;) {
    const choice = await op.ui.select<string>({ title: "Предпросмотр локального обновления", current: "continue", options: [
      { title: "Сводка", value: "summary" },
      ...groups.map((group, index) => ({ title: `${group.title}: ${group.values.length}`, value: String(index) })),
      { title: "Перейти к подтверждению записи", value: "continue" },
    ] })
    if (choice === undefined) return false
    if (choice === "continue") return true
    if (choice === "summary") { await op.ui.alert({ title: "Локальный предпросмотр", message: summary }); continue }
    const group = groups[Number(choice)]
    if (group) await inspectList(op, group.title, group.values)
  }
}

async function inspectList(op: Operation, title: string, values: readonly string[]): Promise<void> {
  const pages = Math.max(1, Math.ceil(values.length / 40))
  let page = 0
  for (;;) {
    const picked = await op.ui.select<string>({ title: `${title} · ${values.length} · стр. ${page + 1}/${pages}`, options: [
      ...values.slice(page * 40, (page + 1) * 40).map((value, index) => ({ title: display(value, 240), value: String(page * 40 + index) })),
      ...(page > 0 ? [{ title: "← Назад", value: "prev" }] : []),
      ...(page + 1 < pages ? [{ title: "Далее →", value: "next" }] : []),
      { title: "К предпросмотру", value: "close" },
    ] })
    if (picked === undefined || picked === "close") return
    if (picked === "next") { page = Math.min(page + 1, pages - 1); continue }
    if (picked === "prev") { page = Math.max(page - 1, 0); continue }
    const value = values[Number(picked)]
    if (value !== undefined) await op.ui.alert({ title, message: display(value, 4096) })
  }
}
