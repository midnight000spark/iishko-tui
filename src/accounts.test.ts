import { describe, expect, test } from "bun:test"
import { catalogAccounts, readAccounts, readPriority, readStore } from "./accounts.js"

describe("readAccounts", () => {
  test("по умолчанию выключено: один неявный аккаунт", () => {
    expect(readAccounts(undefined)).toEqual([
      { id: "reformbossV2", label: "reformbossV2", providerID: "reformbossV2", rank: null },
    ])
    expect(readAccounts({ catalog: { accounts: { enabled: false } } })).toHaveLength(1)
    expect(readAccounts({}, "reformbossV1")[0]?.id).toBe("reformbossV1")
  })

  test("явно включённый список даёт два ключа с разными рангами", () => {
    const accounts = readAccounts({
      catalog: {
        accounts: {
          enabled: true,
          items: [
            { providerID: "reformbossV2", label: "V2 · основной", rank: "t3" },
            { providerID: "reformbossV1", label: "V1 · резервный", rank: "t1" },
          ],
        },
      },
    })
    expect(accounts).toEqual([
      { id: "reformbossV2", label: "V2 · основной", providerID: "reformbossV2", rank: "t3" },
      { id: "reformbossV1", label: "V1 · резервный", providerID: "reformbossV1", rank: "t1" },
    ])
  })

  test("мусор в items не ломает запуск и не дублирует аккаунты", () => {
    const accounts = readAccounts({
      catalog: {
        accounts: {
          enabled: true,
          items: [
            { id: "reformbossV2" },
            { providerID: "reformbossV2" },
            { label: "без id" },
            { providerID: "reformbossV1", rank: "t9" },
            "мусор",
          ],
        },
      },
    })
    expect(accounts).toEqual([
      { id: "reformbossV2", label: "reformbossV2", providerID: "reformbossV2", rank: null },
      { id: "reformbossV1", label: "reformbossV1", providerID: "reformbossV1", rank: null },
    ])
  })

  test("включено без валидных items — откат к одному аккаунту", () => {
    expect(
      readAccounts({ catalog: { accounts: { enabled: true, items: [] } } }, "reformbossV1"),
    ).toEqual([{ id: "reformbossV1", label: "reformbossV1", providerID: "reformbossV1", rank: null }])
    expect(readAccounts({ catalog: { accounts: { enabled: true, items: "нет" } } })).toHaveLength(1)
  })
})

describe("readPriority", () => {
  test("по умолчанию приоритет сайта", () => {
    expect(readPriority(undefined)).toBe("site")
    expect(readPriority({ catalog: {} })).toBe("site")
    expect(readPriority({ catalog: { priority: "conservative" } })).toBe("conservative")
    expect(readPriority({ catalog: { priority: "другое" } })).toBe("site")
  })
})

describe("local account preferences", () => {
  test("migrates old storage without inventing active account", () => {
    expect(readStore({ ranks: { alpha: "t1", beta: null, invalid: "t9" }, priority: "conservative" }))
      .toEqual({ ranks: { alpha: "t1", beta: null }, priority: "conservative" })
    expect(readStore({ activeAccount: "alpha", ranks: [], priority: "invalid" }))
      .toEqual({ ranks: {}, priority: "site", activeAccount: "alpha" })
  })

  test("catalog routing comes only from discovered local accounts", () => {
    expect(catalogAccounts([{ providerID: "custom", label: "Local", path: "/config.json", models: { one: {} } }]))
      .toEqual([{ id: "custom", providerID: "custom", label: "Local", rank: null }])
    expect(catalogAccounts([])).toEqual([])
  })

  test("malformed persisted preferences do not invent an account or rank", () => {
    for (const value of [undefined, null, [], "invalid", 7]) {
      expect(readStore(value)).toEqual({ ranks: {}, priority: "site" })
    }
    expect(readStore({ activeAccount: "", ranks: { alpha: "t3", beta: 3, gamma: false } }, "conservative"))
      .toEqual({ ranks: { alpha: "t3" }, priority: "conservative" })
  })
})
