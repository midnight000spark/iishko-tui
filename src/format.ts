/** Представление каталога: подписи, строка списка, заголовок и детали модели. */

import {
  RANK_LABELS,
  STATE_ICONS,
  STATE_LABELS,
  type Catalog,
  type CatalogModel,
  type Price,
  type Rank,
} from "./site.js"

/** Строка `dialog.select`; форма совпадает с опциями плагина. */
export interface CatalogOption {
  readonly title: string
  readonly value: string
  readonly description?: string
  readonly footer?: string
  readonly category?: string
}

const NO_VALUE = "—"
const STALE_AFTER_S = 15 * 60

export function iconOf(model: CatalogModel): string {
  return STATE_ICONS[model.state]
}

export function stateLabel(model: CatalogModel): string {
  return STATE_LABELS[model.state]
}

/** `Новичок, Актив, Профи` или `ранг ?`. */
export function rankList(ranks: readonly Rank[], source: CatalogModel["rankSource"] = "unknown"): string {
  return ranks.length === 0
    ? source === "unknown" ? "ранг ?" : "нет доступных рангов"
    : ranks.map((rank) => RANK_LABELS[rank]).join(", ")
}

/** `$0.15 / $0.60`, `$1.20 / вызов` или `цена ?`. */
export function priceLabel(price: Price): string {
  if (price.perCall !== null) return `${display(price.perCall)} / вызов`
  if (price.input === null && price.output === null) return "цена ?"
  return `${display(price.input ?? NO_VALUE)} / ${display(price.output ?? NO_VALUE)}`
}

export function latencyLabel(ms: number | null): string {
  return ms === null ? NO_VALUE : `${Math.round(ms)} ms`
}

export function percent(value: number | null): string {
  return value === null ? NO_VALUE : `${value.toFixed(1)}%`
}

/** `только что`, `7 мин назад`, `3 ч назад`; `at` — unix-секунды сайта. */
export function ageLabel(atSeconds: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round(nowMs / 1000 - atSeconds))
  if (seconds < 45) return "только что"
  const minutes = Math.round(seconds / 60)
  return minutes < 60 ? `${minutes} мин назад` : `${Math.round(minutes / 60)} ч назад`
}

export function optionFor(model: CatalogModel): CatalogOption {
  const uptime = model.state === "unmeasured" || model.state === "unlisted" ? NO_VALUE : percent(model.uptime24h)
  return {
    title: `${iconOf(model)} ${display(model.id)}`,
    value: model.id,
    description: `${stateLabel(model)} · 24ч ${uptime} · ${latencyLabel(model.latencyMs)} · ${priceLabel(model.price)} · ${rankList(model.ranks, model.rankSource)}`,
    ...(model.configured ? { footer: "в конфиге" } : {}),
    category: stateLabel(model),
  }
}

export function titleFor(
  catalog: Catalog,
  rank: "any" | Rank,
  account: string | null,
  nowMs: number,
): string {
  const parts = [
    "ИИШКО · каталог",
    ...(account === null ? [] : [display(account)]),
    `up ${catalog.counts.up}`,
    `24ч ${percent(catalog.uptime.d24)}`,
    `сайт: ${display(catalog.overall)}`,
    `ранг: ${rank === "any" ? "любой" : RANK_LABELS[rank]}`,
    ageLabel(catalog.updated, nowMs),
  ]
  if (nowMs / 1000 - catalog.updated > STALE_AFTER_S) parts.push("данные устарели")
  return parts.join(" · ")
}

export function detailFor(model: CatalogModel, catalog: Catalog, nowMs: number): {
  readonly title: string
  readonly message: string
} {
  return { title: `${iconOf(model)} ${display(model.id)}`, message: body(model, catalog, nowMs) }
}

function body(model: CatalogModel, catalog: Catalog, nowMs: number): string {
  if (model.state === "unlisted") {
    return [
      `id: ${display(model.id)}`,
      "состояние: модели нет в каталоге сайта",
      ...rankDetails(model),
      model.configured ? "в конфиге: да" : "в конфиге: нет",
      "",
      "Модели нет в статусе сайта; сведения о рангах могут быть доступны отдельно.",
      "Отсутствие замера само по себе не означает поломку.",
    ].join("\n")
  }
  if (model.state === "unmeasured") {
    return [
      `id: ${display(model.id)}`,
      "состояние: сайт знает модель, но не пробит её",
      ...rankDetails(model),
      model.configured ? "в конфиге: да" : "в конфиге: нет",
      "",
      "Обычно это медиа-модели или позиции вне цикла проб. Отсутствие замера",
      "не означает поломку.",
    ].join("\n")
  }

  const lines = [
    `id: ${display(model.id)}`,
    `состояние: ${stateLabel(model)} · проверено ${model.checkedAt === null ? NO_VALUE : ageLabel(model.checkedAt, nowMs)}`,
    `uptime: 1ч ${percent(model.uptime1h)} · 24ч ${percent(model.uptime24h)} · проб за час ${model.probes1h ?? NO_VALUE}`,
    `задержка: ${latencyLabel(model.latencyMs)} (медиана сайта ${latencyLabel(catalog.medianLatencyMs)})`,
    `цена: ${priceLabel(model.price)}`,
    ...rankDetails(model),
    `в конфиге: ${model.configured ? "да" : "нет"}`,
  ]
  if (model.bars !== "") {
    lines.push(`полосы 4ч: ${display(model.bars)}  (u — прошёл, d — провал, s — 429, - — нет пробы)`)
  }
  lines.push("", "⚠️ пробу выполнил ключ сайта, не ваш: 402, 403 и лимиты вашего ключа здесь не видны.")
  return lines.join("\n")
}

function rankDetails(model: CatalogModel): readonly string[] {
  return [
    `ранги: ${rankList(model.ranks, model.rankSource)}`,
    ...(model.ranksConflict ? ["источники рангов расходятся: действует приоритет из настроек каталога"] : []),
  ]
}

function display(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, "").slice(0, 512)
}
