import { describe, expect, test } from "bun:test"
import { summarize, type Plan } from "./plan.js"

const full: Plan = {
  models: ["a", "b", "c", "d"],
  add: ["c", "d"],
  remove: ["e", "f", "g"],
  keptUncertain: ["a"],
  rankUnknown: [],
  removed: { failed: ["e"], unlisted: ["f", "g"], forced: [] },
  evidence: { source: "site", mode: "full", rank: "t3", provider: "reformbossV2", pruneUnlisted: true },
}

describe("summarize", () => {
  test("полная синхронизация: добавления, категории удалений, неопределённые", () => {
    const message = summarize(full)
    expect(message).toContain("Аккаунт reformbossV2 · ранг t3 (Профи) · полная синхронизация")
    expect(message).toContain("Будет добавлено: 2")
    expect(message).toContain("c, d")
    expect(message).toContain("Будет удалено: 3")
    expect(message).toContain("1 — не отвечают на пробах сайта")
    expect(message).toContain("2 — отсутствуют в каталоге сайта")
    expect(message).toContain("Оставим, хотя данных мало: 1")
    expect(message).toContain("Всего моделей после обновления: 4")
    expect(message).toContain("Записать конфиг?")
  })

  test("режим без удалений не пугает словом «удалено»", () => {
    const message = summarize({ ...full, remove: [], removed: { failed: [], unlisted: [], forced: [] } })
    expect(message).toContain("Удалять ничего не будем.")
    expect(message).not.toContain("Будет удалено")
  })

  test("сводка всегда называет аккаунт, ранг и режим", () => {
    const add = summarize({
      ...full,
      evidence: { source: "site", mode: "add", rank: null, provider: "reformbossV1", pruneUnlisted: true },
    })
    expect(add).toContain("Аккаунт reformbossV1 · ранг любой · только добавить")
    const legacy = summarize({ ...full, evidence: undefined })
    expect(legacy).not.toContain("Аккаунт")
  })

  test("показывает модели без данных о ранге", () => {
    const message = summarize({ ...full, rankUnknown: ["x", "y"] })
    expect(message).toContain("Без данных о ранге: 2 — не добавляем")
    expect(message).toContain("x, y")
  })

  test("длинные списки сокращаются", () => {
    const many = ["a", "b", "c", "d", "e", "f", "g"]
    const message = summarize({ ...full, add: many })
    expect(message).toContain("a, b, c, d, e и ещё 2")
  })

  test("старый план без категорий показывает общий список", () => {
    const message = summarize({
      models: ["a"],
      add: [],
      remove: ["x"],
      keptUncertain: [],
      rankUnknown: [],
      removed: { failed: [], unlisted: [], forced: [] },
    })
    expect(message).toContain("Будет удалено: 1")
    expect(message).toContain("x")
    expect(message).toContain("Новых моделей нет.")
  })
})