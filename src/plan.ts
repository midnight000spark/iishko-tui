/** Человеческая сводка обновления в памяти для подтверждения записи. Файлы Python не используются. */

import { RANKS, RANK_LABELS } from "./site.js"

export interface RemovedGroups {
  readonly failed: readonly string[]
  readonly unlisted: readonly string[]
  readonly forced: readonly string[]
}

export interface PlanEvidence {
  readonly source: string
  readonly mode: "add" | "full"
  readonly rank: string | null
  readonly provider: string | null
  readonly pruneUnlisted: boolean
}

export interface Plan {
  readonly models: readonly string[]
  readonly add: readonly string[]
  readonly remove: readonly string[]
  readonly keptUncertain: readonly string[]
  /** up и политика проходят, но ранга нет в данных сайта. */
  readonly rankUnknown: readonly string[]
  readonly removed: RemovedGroups
  readonly evidence?: PlanEvidence
}

const PREVIEW = 5

/** Текст диалога подтверждения. Без жаргона: что добавится, что уйдёт. */
export function summarize(plan: Plan): string {
  const lines: string[] = []
  if (plan.evidence !== undefined) {
    lines.push(headline(plan.evidence))
    lines.push("")
  }
  const added = plan.add.length
  const removed = plan.remove.length
  lines.push(added === 0 ? "Новых моделей нет." : `Будет добавлено: ${added}`)
  if (added > 0) lines.push(`  ${preview(plan.add)}`)
  if (plan.rankUnknown.length > 0) {
    lines.push("")
    lines.push(`Без данных о ранге: ${plan.rankUnknown.length} — не добавляем`)
    lines.push(`  ${preview(plan.rankUnknown)}`)
  }
  lines.push("")
  if (removed === 0) {
    lines.push("Удалять ничего не будем.")
  } else {
    lines.push(`Будет удалено: ${removed}`)
    const failed = plan.removed.failed.length
    const unlisted = plan.removed.unlisted.length
    const forced = plan.removed.forced.length
    if (failed > 0) lines.push(`  ${failed} — не отвечают на пробах сайта`)
    if (unlisted > 0) lines.push(`  ${unlisted} — отсутствуют в каталоге сайта`)
    if (forced > 0) lines.push(`  ${forced} — в always_drop`)
    if (failed + unlisted + forced === 0) lines.push(`  ${preview(plan.remove)}`)
  }
  if (plan.keptUncertain.length > 0) {
    lines.push("")
    lines.push(`Оставим, хотя данных мало: ${plan.keptUncertain.length}`)
    lines.push(`  ${preview(plan.keptUncertain)}`)
  }
  lines.push("")
  lines.push(`Всего моделей после обновления: ${plan.models.length}`)
  lines.push("Будет сделан бэкап. Записать конфиг?")
  return lines.join("\n")
}

function headline(evidence: PlanEvidence): string {
  const mode = evidence.mode === "add" ? "только добавить" : "полная синхронизация"
  const name = evidence.provider === null ? "аккаунт" : evidence.provider
  const known = RANKS.find((rank) => rank === evidence.rank)
  const rank = known === undefined ? "любой" : `${known} (${RANK_LABELS[known]})`
  return `Аккаунт ${name} · ранг ${rank} · ${mode}`
}

function preview(ids: readonly string[]): string {
  const head = ids.slice(0, PREVIEW).join(", ")
  return ids.length > PREVIEW ? `${head} и ещё ${ids.length - PREVIEW}` : head
}