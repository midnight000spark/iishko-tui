/**
 * Разбор публичных документов reformboss.com. Только чистые функции: ни сети,
 * ни состояния. Ошибка формы — `SiteError("shape")`.
 */

import {
  RANKS,
  RANK_LABELS,
  SITE_STATES,
  type MeasuredModel,
  type ModelKind,
  type ParsedStatus,
  type Price,
  type Rank,
  type RankMap,
} from "./site.js"

export class SiteError extends Error {
  constructor(
    readonly code: "shape" | "http" | "network",
    message: string,
  ) {
    super(message)
    this.name = "SiteError"
  }
}

const MAX_MODELS = 10_000
const MAX_DISPLAY_LENGTH = 512
const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024
const UNSAFE_DISPLAY = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g

/** IDs are validated, never sanitized: changing an ID changes model identity. */
function modelId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    !/[\s\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f<>{}"'\\]/u.test(value)
    ? value
    : undefined
}

/** Разбирает `/api/status.json`. Бросает `SiteError("shape")` только на структурный мусор. */
export function parseStatus(raw: unknown): ParsedStatus {
  if (!isRecord(raw)) throw new SiteError("shape", "ответ сайта — не объект")
  const updated = nonnegative(raw["updated"])
  if (updated === undefined) throw new SiteError("shape", "в ответе нет времени обновления")
  const list = raw["models"]
  if (!Array.isArray(list)) throw new SiteError("shape", "в ответе нет списка моделей")
  const remaining = raw["unmeasured"]
  if (!Array.isArray(remaining)) throw new SiteError("shape", "в ответе нет списка unmeasured")
  if (list.length + remaining.length > MAX_MODELS) throw new SiteError("shape", "слишком много моделей")
  const models = list.map(parseModel)
  const unmeasured = remaining.map((value) => {
    const id = modelId(value)
    if (id === undefined) throw new SiteError("shape", "неверный id в unmeasured")
    return id
  })
  const ids = [...models.map((model) => model.id), ...unmeasured]
  if (new Set(ids).size !== ids.length) throw new SiteError("shape", "повторяющиеся id моделей")
  const uptime = isRecord(raw["uptime"]) ? raw["uptime"] : undefined

  return {
    updated,
    overall: text(raw["overall"]) ?? "неизвестно",
    uptime: {
      h1: percentage(uptime?.["h1"]),
      d24: percentage(uptime?.["d24"]),
    },
    medianLatencyMs: nonnegative(raw["median_latency_ms"]) ?? null,
    models,
    unmeasured,
  }
}

/** Разбирает `/api/pricing`: `model_name` → `enable_groups` ∩ t1..t4. */
export function parseRanksJson(raw: unknown): RankMap {
  const ranks: Map<string, readonly Rank[]> = new Map()
  if (!isRecord(raw) || !Array.isArray(raw["data"])) throw new SiteError("shape", "неверная форма рангов API")
  if (raw["data"].length > MAX_MODELS) throw new SiteError("shape", "слишком много рангов")
  for (const entry of raw["data"]) {
    if (!isRecord(entry)) continue
    const id = modelId(entry["model_name"])
    if (id === undefined) continue
    const groups = entry["enable_groups"]
    if (!Array.isArray(groups) || !groups.every((group) => typeof group === "string")) continue
    const found = RANKS.filter((rank) => groups.includes(rank))
    if (ranks.has(id)) throw new SiteError("shape", "повторяющиеся id рангов API")
    ranks.set(id, found)
  }
  return ranks
}

/** Разбирает серверную таблицу `/pricing`: последняя ячейка строки — ранги. */
export function parseRanksHtml(html: string): RankMap {
  if (html.length > MAX_DOCUMENT_BYTES) throw new SiteError("shape", "слишком большой каталог рангов")
  const ranks: Map<string, readonly Rank[]> = new Map()
  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)) {
    const body = row[1] ?? ""
    const cells = [...body.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/g)].map((cell) =>
      strip(cell[1] ?? ""),
    )
    const id = modelId(cells[0])
    if (cells.length !== 6 || id === undefined || id === "Модель") continue
    const last = cells[cells.length - 1] ?? ""
    const found = RANKS.filter((rank) => last.includes(RANK_LABELS[rank]))
    if (ranks.has(id)) throw new SiteError("shape", "повторяющиеся id рангов сайта")
    if (ranks.size >= MAX_MODELS) throw new SiteError("shape", "слишком много рангов")
    ranks.set(id, found)
  }
  return ranks
}

function parseModel(raw: unknown): MeasuredModel {
  if (!isRecord(raw)) throw new SiteError("shape", "неверная строка модели")
  const id = modelId(raw["id"])
  if (id === undefined) throw new SiteError("shape", "неверный id модели")
  const state = raw["state"]
  return {
    id,
    lab: text(raw["lab"]) ?? "—",
    kind: kindOf(raw["kind"]),
    state: SITE_STATES.find((known) => known === state) ?? "unknown",
    checkedAt: nonnegative(raw["checked_at"]) ?? null,
    latencyMs: nonnegative(raw["latency_ms"]) ?? null,
    uptime1h: percentage(raw["uptime_1h"]),
    uptime24h: percentage(raw["uptime_24h"]),
    probes1h: probes(raw["probes_1h"]),
    bars: typeof raw["bars"] === "string" && raw["bars"].length <= 24 && !/[^uds-]/.test(raw["bars"]) ? raw["bars"] : "",
    price: parsePrice(raw["price"]),
  }
}

function parsePrice(raw: unknown): Price {
  if (!isRecord(raw)) return { input: null, output: null, perCall: null }
  return {
    input: text(raw["input"]) ?? null,
    output: text(raw["output"]) ?? null,
    perCall: text(raw["per_call"]) ?? null,
  }
}

function kindOf(value: unknown): ModelKind {
  return value === "chat" || value === "image" || value === "video" ? value : "other"
}

function strip(value: string): string {
  return decode(value.replace(/<[^>]*>/g, ""))
}

function decode(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const safe = value.replace(UNSAFE_DISPLAY, "").slice(0, MAX_DISPLAY_LENGTH)
  return safe === "" ? undefined : safe
}

function nonnegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function percentage(value: unknown): number | null {
  const number = nonnegative(value)
  return number !== undefined && number <= 100 ? number : null
}

function probes(value: unknown): number | null {
  const number = nonnegative(value)
  return number !== undefined && Number.isSafeInteger(number) ? number : null
}
