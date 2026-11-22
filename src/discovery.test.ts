import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { configPaths, discoverAccounts } from "./discovery.js"

async function fixture(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "iishko-discovery-"))
  try { await run(dir) } finally { await rm(dir, { recursive: true, force: true }) }
}

const account = { name: "Личный", settings: { baseURL: "https://api.reformboss.com/v1" }, models: { m: { name: "M" } } }

describe("local configuration discovery", () => {
  test("uses local XDG config roots and explicit overrides, never AppData guessing", () => {
    const paths = configPaths({ home: "/users/me", cwd: "/work/app", platform: "win32", env: { XDG_CONFIG_HOME: "/xdg", ProgramData: "/managed" } })
    expect(paths).toContain(resolve("/xdg/opencode/opencode.json"))
    expect(paths).toContain(resolve("/managed/opencode/opencode.jsonc"))
    expect(paths).toContain(resolve("/work/app/.opencode/opencode.jsonc"))
    expect(() => configPaths({ configPath: "relative.json" })).toThrow("абсолютным")
  })

  test("reads native V2 account without following credential references", async () => fixture(async (dir) => {
    const path = join(dir, "конфиг с пробелом.jsonc")
    await writeFile(path, JSON.stringify({ providers: { personal: { ...account, settings: { ...account.settings, apiKey: "{file:not-read.key}" } } } }))
    const found = await discoverAccounts({ paths: [path], configPath: path, env: {} })
    expect(found).toEqual([{ providerID: "personal", label: "Личный", path, models: account.models }])
  }))

  test("rejects multiple defining documents, including settings-only override", async () => fixture(async (dir) => {
    const paths = [join(dir, "first.json"), join(dir, "second.json")]
    await writeFile(paths[0]!, JSON.stringify({ providers: { personal: account } }))
    await writeFile(paths[1]!, JSON.stringify({ providers: { personal: { name: "Override" } } }))
    await expect(discoverAccounts({ paths, configPath: paths[0], env: {} })).rejects.toThrow("нескольких")
  }))

  test("does not recognize attacker hosts, credential URLs, legacy shape or endpoint substitutions", async () => fixture(async (dir) => {
    const path = join(dir, "config.json")
    for (const baseURL of ["https://api.reformboss.com.evil/v1", "https://name:password@api.reformboss.com/v1", "{env:BASE_URL}", "http://api.reformboss.com/v1"]) {
      await writeFile(path, JSON.stringify({ providers: { personal: { ...account, settings: { baseURL } } } }))
      expect(await discoverAccounts({ paths: [path], env: {} })).toEqual([])
    }
    await writeFile(path, JSON.stringify({ provider: { personal: account } }))
    expect(await discoverAccounts({ paths: [path], env: {} })).toEqual([])
  }))

  test("inline config and inherited models refuse automatic edits", async () => fixture(async (dir) => {
    await expect(discoverAccounts({ env: { OPENCODE_CONFIG_CONTENT: "{}" }, paths: [] })).rejects.toThrow("inline")
    const path = join(dir, "config.json")
    await writeFile(path, JSON.stringify({ providers: { personal: { ...account, canonical: "openai" } } }))
    await expect(discoverAccounts({ paths: [path], configPath: path, env: {} })).rejects.toThrow("canonical")
  }))

  test("missing documents are ignored and pre-abort prevents discovery", async () => fixture(async (dir) => {
    expect(await discoverAccounts({ paths: [join(dir, "absent.json")], env: {} })).toEqual([])
    const signal = AbortSignal.abort()
    await expect(discoverAccounts({ paths: [], env: {}, signal })).rejects.toThrow()
  }))

  test("project or managed files are inspected but never automatically offered as write targets", async () => fixture(async (dir) => {
    const path = join(dir, "opencode.jsonc")
    await writeFile(path, JSON.stringify({ providers: { personal: account } }))
    expect(await discoverAccounts({ paths: [path], home: join(dir, "home"), env: {} })).toEqual([])
    expect(await discoverAccounts({ paths: [path], configPath: path, env: {} })).toHaveLength(1)
  }))

  test("an explicit local target excludes other global accounts but retains conflict detection", async () => fixture(async (dir) => {
    const home = join(dir, "home")
    const root = join(home, ".config", "opencode")
    await mkdir(root, { recursive: true })
    const global = join(root, "opencode.json")
    const explicit = join(dir, "selected.jsonc")
    await writeFile(global, JSON.stringify({ providers: { other: account } }))
    await writeFile(explicit, JSON.stringify({ providers: { selected: account } }))
    const options = { paths: [global, explicit], home, configPath: explicit, env: {} }
    expect((await discoverAccounts(options)).map((entry) => entry.providerID)).toEqual(["selected"])
    await writeFile(global, JSON.stringify({ providers: { selected: { name: "Override" } } }))
    await expect(discoverAccounts(options)).rejects.toThrow("нескольких")
  }))
})
