/** Public account labels/preferences only. Routing is proved by local discovery. */

import { RANKS, type Rank, type RankPriority } from "./site.js"
import type { LocalAccount } from "./discovery.js"

export interface Account {
  /** Стабильный id для хранения ранга; совпадает с providerID. */
  readonly id: string
  readonly label: string
  readonly providerID: string
  /** Ранг из конфига; применяется, пока в хранилище нет сохранённого. */
  readonly rank: Rank | null
}

export interface AccountSettings {
  readonly accounts: readonly Account[]
  readonly priority: RankPriority
}

/** Existing storage without activeAccount is intentionally still valid. */
export interface AccountStore {
  ranks: Record<string, Rank | null>
  priority: RankPriority
  activeAccount?: string
}

export function catalogAccounts(accounts: readonly LocalAccount[]): readonly Account[] {
  return accounts.map((account) => ({
    id: account.providerID, providerID: account.providerID,
    label: account.label, rank: null,
  }))
}

/** Accept old persisted {ranks,priority}, ignoring malformed/untrusted fields. */
export function readStore(value: unknown, priority: RankPriority = "site"): AccountStore {
  const raw = field(value, "ranks")
  const ranks = Object.fromEntries(isRecord(raw) ? Object.entries(raw).filter(
    (entry): entry is [string, Rank | null] => entry[1] === null || RANKS.some((rank) => rank === entry[1]),
  ) : [])
  const activeAccount = text(field(value, "activeAccount"))
  return {
    ranks,
    priority: field(value, "priority") === "conservative" ? "conservative"
      : field(value, "priority") === "site" ? "site" : priority,
    ...(activeAccount === undefined ? {} : { activeAccount }),
  }
}

export const DEFAULT_PROVIDER = "reformbossV2"

/**
 * Читает `options.catalog`. Пока `accounts.enabled !== true`, возвращает один
 * неявный аккаунт — поведение плагина остаётся прежним.
 */
export function readAccounts(options: unknown, fallbackProvider = DEFAULT_PROVIDER): readonly Account[] {
  const catalog = field(options, "catalog")
  const accounts = field(catalog, "accounts")
  if (field(accounts, "enabled") !== true) return [implicit(fallbackProvider)]
  const items = field(accounts, "items")
  if (!Array.isArray(items)) return [implicit(fallbackProvider)]

  const parsed: Account[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const account = parseAccount(item)
    if (account === undefined || seen.has(account.id)) continue
    seen.add(account.id)
    parsed.push(account)
  }
  return parsed.length === 0 ? [implicit(fallbackProvider)] : parsed
}

/** Приоритет источников рангов из `options.catalog.priority`. */
export function readPriority(options: unknown): RankPriority {
  return field(field(options, "catalog"), "priority") === "conservative"
    ? "conservative"
    : "site"
}

function parseAccount(raw: unknown): Account | undefined {
  const providerID = text(field(raw, "providerID")) ?? text(field(raw, "id"))
  if (providerID === undefined) return undefined
  const rank = text(field(raw, "rank"))
  return {
    id: providerID,
    label: text(field(raw, "label")) ?? providerID,
    providerID,
    rank: RANKS.find((known) => known === rank) ?? null,
  }
}

function implicit(providerID: string): Account {
  return { id: providerID, label: providerID, providerID, rank: null }
}

function field(source: unknown, key: string): unknown {
  return isRecord(source) ? source[key] : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
