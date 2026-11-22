import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmod, link, lstat, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { modelEntries, parseConfig, replaceModels } from "./config-document.js"
import { createSchemaValidator } from "./schema.js"
import { applyUpdate, createTransaction, prepareUpdate } from "./transaction.js"
import type { ApplyUpdateOptions, PreparedUpdate } from "./transaction.js"

const before = '\uFEFF{\r\n// fixture comment\r\n"providers":{"account":{"settings":{"apiKey":"fixture-only"},"models":{"old":{}}},"other":{"models":{"keep":{}}}},\r\n"theme":"keep",\r\n}\r\n'
const after = replaceModels(before, "account", { next: { limit: { context: 100 } } })
const validateSchema = createSchemaValidator({ type: "object", required: ["providers"], properties: { providers: { type: "object" } } })
const options: ApplyUpdateOptions = { validate: (text) => validateSchema(parseConfig(text).value) }

async function fixture(run: (path: string, directory: string) => Promise<void>): Promise<void> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "iishko-transaction-")))
  const path = join(directory, "local config.jsonc")
  try { await writeFile(path, before, { mode: 0o640 }); await run(path, directory) }
  finally { await rm(directory, { recursive: true, force: true }) }
}

function prepare(path: string, createdAt?: number): PreparedUpdate {
  return prepareUpdate({ path, providerID: "account", before, after, summary: "Тестовое обновление", createdAt })
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe("transaction preparation", () => {
  test("freezes primitive preview fields and retains only source digest", async () => fixture(async (path) => {
    const preview = prepare(path)
    expect(Object.isFrozen(preview)).toBe(true)
    expect(preview.beforeHash).toBe(createHash("sha256").update(before).digest("hex"))
    expect(Object.keys(preview).sort()).toEqual(["after", "beforeHash", "createdAt", "identity", "path", "providerID", "summary"])
    expect(preview.identity).toMatch(/^[a-f0-9]{64}$/)
  }))

  test("refuses unrelated bytes, foreign provider edits, empty models and relative paths", async () => fixture(async (path) => {
    const input = { path, providerID: "account", before, after, summary: "preview" }
    expect(() => prepareUpdate({ ...input, after: after.replace('"theme":"keep"', '"theme":"changed"') })).toThrow()
    expect(() => prepareUpdate({ ...input, after: `${after} ` })).toThrow()
    expect(() => prepareUpdate({ ...input, after: replaceModels(before, "other", { changed: {} }) })).toThrow()
    expect(() => prepareUpdate({ ...input, after: replaceModels(before, "account", {}) })).toThrow()
    expect(() => prepareUpdate({ ...input, providerID: "missing" })).toThrow()
    expect(() => prepareUpdate({ ...input, path: "relative.jsonc" })).toThrow()
  }))
})

describe("transaction apply", () => {
  test("writes exact approved BOM/CRLF document, syncs backup and preserves mode", async () => fixture(async (path, directory) => {
    const preview = prepare(path)
    const originalMode = (await lstat(path)).mode & 0o777
    const result = await applyUpdate(preview, preview.identity, options)
    expect(await readFile(path, "utf8")).toBe(after)
    expect(await readFile(result.backupPath, "utf8")).toBe(before)
    expect(modelEntries(await readFile(path, "utf8"), "other")).toEqual({ keep: {} })
    if (process.platform !== "win32") {
      expect((await lstat(path)).mode & 0o777).toBe(originalMode)
      expect((await lstat(result.backupPath)).mode & 0o777).toBe(0o600)
    }
    expect((await readdir(directory)).sort()).toEqual([result.backupPath.slice(directory.length + 1), "local config.jsonc"].sort())
  }))

  test("rejects every tampered identity-covered field and wrong approval", async () => fixture(async (path, directory) => {
    const preview = prepare(path)
    const modifications: Partial<PreparedUpdate>[] = [
      { path: join(directory, "other.jsonc") }, { providerID: "other" }, { beforeHash: "0".repeat(64) },
      { after: after + " " }, { summary: "different" }, { createdAt: preview.createdAt - 1 }, { identity: "0".repeat(64) },
    ]
    for (const change of modifications) await expect(applyUpdate({ ...preview, ...change }, preview.identity, options)).rejects.toThrow()
    const forged = { ...preview, summary: "forged" }
    forged.identity = createHash("sha256").update(JSON.stringify(["iishko-update-v1", forged.path,
      forged.providerID, forged.beforeHash, forged.after, forged.summary, forged.createdAt])).digest("hex")
    await expect(applyUpdate(forged, preview.identity, options)).rejects.toThrow()
    await expect(applyUpdate(preview, "wrong", options)).rejects.toThrow()
    expect(await readFile(path, "utf8")).toBe(before)
    expect(await readdir(directory)).toEqual(["local config.jsonc"])
  }))

  test("rejects stale and future timestamps without effects", async () => fixture(async (path, directory) => {
    for (const createdAt of [1000, 3_601_002]) {
      const preview = prepare(path, createdAt)
      await expect(applyUpdate(preview, preview.identity, { ...options, now: () => 3_601_001 })).rejects.toThrow("время")
    }
    expect(await readdir(directory)).toEqual(["local config.jsonc"])
  }))

  test("schema validation is mandatory even for callers bypassing types", async () => fixture(async (path, directory) => {
    const preview = prepare(path)
    await expect(applyUpdate(preview, preview.identity, {} as ApplyUpdateOptions)).rejects.toThrow("обязательна")
    expect(await readdir(directory)).toEqual(["local config.jsonc"])
  }))

  test("refuses changed source digest and leaves user's new bytes intact", async () => fixture(async (path) => {
    const preview = prepare(path)
    await writeFile(path, before + " ")
    await expect(applyUpdate(preview, preview.identity, options)).rejects.toThrow("изменилась")
    expect(await readFile(path, "utf8")).toBe(before + " ")
  }))

  test("never steals an existing competing lock", async () => fixture(async (path) => {
    const preview = prepare(path)
    await writeFile(`${path}.iishko.lock`, "foreign-owner")
    await expect(applyUpdate(preview, preview.identity, options)).rejects.toThrow("блокировку")
    expect(await readFile(`${path}.iishko.lock`, "utf8")).toBe("foreign-owner")
    expect(await readFile(path, "utf8")).toBe(before)
  }))

  test("concurrent operations cannot both enter validation under the exclusive lock", async () => fixture(async (path) => {
    const preview = prepare(path)
    const entered = deferred()
    const release = deferred()
    const first = applyUpdate(preview, preview.identity, { validate: async (text) => {
      options.validate(text); entered.resolve(); await release.promise
    } })
    await entered.promise
    try { await expect(applyUpdate(preview, preview.identity, options)).rejects.toThrow() }
    finally { release.resolve() }
    await first
    expect(await readFile(path, "utf8")).toBe(after)
  }))

  test("schema failure exposes no callback secrets and creates no backup/temp", async () => fixture(async (path, directory) => {
    const preview = prepare(path)
    await expect(applyUpdate(preview, preview.identity, { validate: () => { throw new Error("fixture-private-secret") } })).rejects.toThrow("схему")
    expect(await readFile(path, "utf8")).toBe(before)
    expect(await readdir(directory)).toEqual(["local config.jsonc"])
  }))

  test("already cancelled operation creates no files and sanitizes abort reason", async () => fixture(async (path, directory) => {
    const preview = prepare(path)
    const controller = new AbortController()
    controller.abort(new Error("fixture-private-abort"))
    await expect(applyUpdate(preview, preview.identity, { ...options, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError", message: "Обновление отменено." })
    expect(await readdir(directory)).toEqual(["local config.jsonc"])
  }))

  test("cancellation during deferred validation leaves config unchanged and removes owned lock", async () => fixture(async (path, directory) => {
    const preview = prepare(path)
    const controller = new AbortController()
    const entered = deferred()
    const release = deferred()
    const operation = applyUpdate(preview, preview.identity, { signal: controller.signal, validate: async () => {
      entered.resolve(); await release.promise
    } })
    await entered.promise
    controller.abort()
    release.resolve()
    await expect(operation).rejects.toMatchObject({ name: "AbortError" })
    expect(await readFile(path, "utf8")).toBe(before)
    expect(await readdir(directory)).toEqual(["local config.jsonc"])
  }))

  test("rechecks source contents and file node after validation", async () => fixture(async (path) => {
    const preview = prepare(path)
    await expect(applyUpdate(preview, preview.identity, { validate: async () => {
      const replacement = `${path}.editor`
      await writeFile(replacement, before)
      await rename(replacement, path)
    } })).rejects.toThrow("изменилась")
    expect(await readFile(path, "utf8")).toBe(before)
  }))

  test("rechecks source digest after an in-place edit during validation", async () => fixture(async (path) => {
    const preview = prepare(path)
    await expect(applyUpdate(preview, preview.identity, { validate: async () => {
      await writeFile(path, before + " ")
    } })).rejects.toThrow("изменилась")
    expect(await readFile(path, "utf8")).toBe(before + " ")
  }))

  test("rechecks mutable preview identity immediately before commit", async () => fixture(async (path) => {
    const original = prepare(path)
    const mutable = { ...original }
    await expect(applyUpdate(mutable, original.identity, { validate: () => { mutable.summary = "tampered" } })).rejects.toThrow()
    expect(await readFile(path, "utf8")).toBe(before)
  }))

  test("never deletes a foreign replacement lock during cleanup", async () => fixture(async (path) => {
    const preview = prepare(path)
    await expect(applyUpdate(preview, preview.identity, { validate: async () => {
      await unlink(`${path}.iishko.lock`)
      await writeFile(`${path}.iishko.lock`, "replacement-owner")
      throw new Error("stop")
    } })).rejects.toThrow()
    expect(await readFile(`${path}.iishko.lock`, "utf8")).toBe("replacement-owner")
  }))

  test("refuses commit after losing lock ownership even when validation succeeds", async () => fixture(async (path) => {
    const preview = prepare(path)
    await expect(applyUpdate(preview, preview.identity, { validate: async () => {
      await unlink(`${path}.iishko.lock`)
      await writeFile(`${path}.iishko.lock`, "replacement-owner")
    } })).rejects.toThrow()
    expect(await readFile(path, "utf8")).toBe(before)
    expect(await readFile(`${path}.iishko.lock`, "utf8")).toBe("replacement-owner")
  }))

  test("rechecks preview age after asynchronous schema validation", async () => fixture(async (path) => {
    const preview = prepare(path, 1000)
    let now = 1000
    await expect(applyUpdate(preview, preview.identity, { now: () => now, validate: () => { now += 3_600_001 } })).rejects.toThrow()
    expect(await readFile(path, "utf8")).toBe(before)
  }))

  test("rename failure preserves destination and backup, cleans only owned temp/lock", async () => fixture(async (path, directory) => {
    const preview = prepare(path)
    const transaction = createTransaction({ rename: async () => { throw new Error("injected EPERM fixture-private-secret") } })
    await expect(transaction.applyUpdate(preview, preview.identity, options)).rejects.toThrow("Безопасное обновление")
    expect(await readFile(path, "utf8")).toBe(before)
    const files = await readdir(directory)
    expect(files.filter((name) => name.endsWith(".tmp") || name.endsWith(".lock"))).toEqual([])
    const backups = files.filter((name) => name.endsWith(".bak"))
    expect(backups).toHaveLength(1)
    expect(await readFile(join(directory, backups[0]!), "utf8")).toBe(before)
  }))

  test("refuses hardlinked targets", async () => fixture(async (path) => {
    const preview = prepare(path)
    await link(path, `${path}.linked`)
    await expect(applyUpdate(preview, preview.identity, options)).rejects.toThrow()
    expect(await readFile(path, "utf8")).toBe(before)
  }))

  test("protects empty backup/temp before secret writes and verifies security before rename", async () => fixture(async (path) => {
    const preview = prepare(path)
    const protectedPaths: string[] = []
    let verified = false
    const transaction = createTransaction({
      rename: async (from, to) => { expect(verified).toBe(true); await rename(from, to) },
      security: async (sourcePath) => {
        expect(sourcePath).toBe(path)
        return {
          protect: async (target) => {
            expect((await readFile(target)).length).toBe(0)
            protectedPaths.push(target)
          },
          verify: async () => { expect(protectedPaths).toHaveLength(2); verified = true },
        }
      },
      write: async (handle, bytes) => {
        if (typeof bytes !== "string" || bytes === after) {
          const target = protectedPaths.find((target) => target.endsWith(bytes === after ? ".tmp" : ".bak"))
          expect(target).toBeDefined()
        }
        await handle.writeFile(bytes)
      },
    })
    await transaction.applyUpdate(preview, preview.identity, options)
    expect(await readFile(path, "utf8")).toBe(after)
  }))

  test("ACL failure leaves no secret backup/temp bytes or partial files", async () => fixture(async (path, directory) => {
    const preview = prepare(path)
    let secretWrites = 0
    const transaction = createTransaction({ rename,
      security: async () => ({ protect: async () => { throw new Error("private ACL failure") }, verify: async () => undefined }),
      write: async (handle, bytes) => {
        if (Buffer.isBuffer(bytes) || bytes === after) secretWrites++
        await handle.writeFile(bytes)
      },
    })
    await expect(transaction.applyUpdate(preview, preview.identity, options)).rejects.toThrow()
    expect(secretWrites).toBe(0)
    expect(await readdir(directory)).toEqual(["local config.jsonc"])
    expect(await readFile(path, "utf8")).toBe(before)
  }))

  test("checks cancellation after asynchronous permission protection before writing secret bytes", async () => fixture(async (path, directory) => {
    const preview = prepare(path)
    const controller = new AbortController()
    let secretWrites = 0
    const transaction = createTransaction({ rename,
      security: async () => ({
        protect: async () => { controller.abort(new Error("private abort")) }, verify: async () => undefined,
      }),
      write: async (handle, bytes) => {
        if (Buffer.isBuffer(bytes) || bytes === after) secretWrites++
        await handle.writeFile(bytes)
      },
    })
    await expect(transaction.applyUpdate(preview, preview.identity, { ...options, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" })
    expect(secretWrites).toBe(0)
    expect(await readdir(directory)).toEqual(["local config.jsonc"])
  }))

  test("permission snapshot failure prevents commit and retains completed safe backup", async () => fixture(async (path, directory) => {
    const preview = prepare(path)
    const transaction = createTransaction({ rename,
      security: async () => ({ protect: async () => undefined, verify: async () => { throw new Error("changed ACL") } }),
    })
    await expect(transaction.applyUpdate(preview, preview.identity, options)).rejects.toThrow()
    expect(await readFile(path, "utf8")).toBe(before)
    const files = await readdir(directory)
    expect(files.filter((name) => name.endsWith(".tmp") || name.endsWith(".lock"))).toEqual([])
    expect(files.filter((name) => name.endsWith(".bak"))).toHaveLength(1)
  }))

  test("cleans empty/partial own lock tokens after failed write", async () => fixture(async (path, directory) => {
    const preview = prepare(path)
    for (const partial of [false, true]) {
      const transaction = createTransaction({ rename, write: async (handle, bytes) => {
        if (partial && typeof bytes === "string") await handle.writeFile(bytes.slice(0, 8))
        throw new Error("partial token write")
      } })
      await expect(transaction.applyUpdate(preview, preview.identity, options)).rejects.toThrow()
      expect(await readdir(directory)).toEqual(["local config.jsonc"])
    }
  }))

  test("removes incomplete backup after partial write and failed sync", async () => fixture(async (path, directory) => {
    const preview = prepare(path)
    const partial = createTransaction({ rename, write: async (handle, bytes) => {
      if (Buffer.isBuffer(bytes)) {
        await handle.writeFile(bytes.subarray(0, 30))
        throw new Error("partial backup")
      }
      await handle.writeFile(bytes)
    } })
    await expect(partial.applyUpdate(preview, preview.identity, options)).rejects.toThrow()
    expect(await readdir(directory)).toEqual(["local config.jsonc"])
    let calls = 0
    const syncFailure = createTransaction({ rename, sync: async (handle) => {
      if (++calls === 2) throw new Error("backup sync")
      await handle.sync()
    } })
    await expect(syncFailure.applyUpdate(preview, preview.identity, options)).rejects.toThrow()
    expect(await readdir(directory)).toEqual(["local config.jsonc"])
    expect(await readFile(path, "utf8")).toBe(before)
  }))

  test("preserves foreign same-inode lock content after failed own token write", async () => fixture(async (path) => {
    const preview = prepare(path)
    const transaction = createTransaction({ rename, write: async (handle) => {
      await handle.writeFile("foreign-content")
      throw new Error("write interrupted")
    } })
    await expect(transaction.applyUpdate(preview, preview.identity, options)).rejects.toThrow()
    expect(await readFile(`${path}.iishko.lock`, "utf8")).toBe("foreign-content")
  }))

  test("reports committed cleanup failure as successful result with warning, never false not-applied", async () => fixture(async (path) => {
    const preview = prepare(path)
    const transaction = createTransaction({ rename, unlink: async () => { throw new Error("cleanup denied") } })
    const result = await transaction.applyUpdate(preview, preview.identity, options)
    expect(result.warning).toContain("Конфигурация обновлена")
    expect(await readFile(path, "utf8")).toBe(after)
    expect(await readFile(result.backupPath, "utf8")).toBe(before)
  }))

  test.skipIf(process.platform === "win32")("refuses symlink targets and read-only files", async () => fixture(async (path, directory) => {
    const alias = join(directory, "alias.jsonc")
    await symlink(path, alias)
    const linked = prepare(alias)
    await expect(applyUpdate(linked, linked.identity, options)).rejects.toThrow()
    const preview = prepare(path)
    await chmod(path, 0o400)
    try { await expect(applyUpdate(preview, preview.identity, options)).rejects.toThrow() }
    finally { await chmod(path, 0o640) }
    expect(await readFile(path, "utf8")).toBe(before)
  }))
})
