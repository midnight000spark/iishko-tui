import { Buffer } from "node:buffer"
import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import type { Stats } from "node:fs"
import { lstat, open, realpath, rename, unlink } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import { MAX_CONFIG_BYTES, modelEntries, parseConfig, replaceModels } from "./config-document.js"
import { createFileSecurity } from "./windows-acl.js"

const MAX_AGE = 60 * 60 * 1000
const FIELDS = ["path", "providerID", "beforeHash", "after", "summary", "createdAt", "identity"] as const
// Windows has no O_NOFOLLOW equivalent here; lstat/realpath/node checks remain mandatory.
const READ_FLAGS = constants.O_RDONLY | (process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0))

class ChangedConfigError extends Error {
  constructor() { super("Конфигурация изменилась после предпросмотра. Создайте новый.") }
}

export interface PreparedUpdate {
  readonly path: string
  readonly providerID: string
  readonly beforeHash: string
  readonly after: string
  readonly summary: string
  readonly createdAt: number
  readonly identity: string
}

export interface PrepareUpdateInput {
  path: string
  providerID: string
  before: string
  after: string
  summary: string
  createdAt?: number
}

export interface ApplyUpdateOptions {
  /** Must validate the complete proposed document against the trusted schema. */
  validate: (after: string) => void | Promise<void>
  signal?: AbortSignal
  now?: () => number
}

export interface TransactionDependencies {
  /** Filesystem boundary injection for testing rename failures, not a lifecycle hook. */
  rename: (from: string, to: string) => Promise<void>
  write?: (handle: FileHandle, bytes: string | Buffer) => Promise<void>
  sync?: (handle: FileHandle) => Promise<void>
  security?: typeof createFileSecurity
  unlink?: (path: string) => Promise<void>
}

export interface ApplyUpdateResult {
  backupPath: string
  /** The update committed, but a service file needs manual attention. Never retry blindly. */
  warning?: string
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex")
}

function identity(value: Omit<PreparedUpdate, "identity">): string {
  return digest(JSON.stringify(["iishko-update-v1", value.path, value.providerID, value.beforeHash,
    value.after, value.summary, value.createdAt]))
}

function abort(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const error = new Error("Обновление отменено.")
  error.name = "AbortError"
  throw error
}

function fresh(createdAt: number, now: number): void {
  if (!Number.isSafeInteger(createdAt) || !Number.isSafeInteger(now) || createdAt < 0 ||
      createdAt > now || now - createdAt > MAX_AGE) {
    throw new Error("Предпросмотр устарел или имеет неверное время. Создайте новый.")
  }
}

function fields(value: Omit<PreparedUpdate, "identity">): void {
  if (typeof value.path !== "string" || value.path.length > 32_768 || value.path.includes("\0") ||
      !isAbsolute(value.path) || resolve(value.path) !== value.path ||
      typeof value.providerID !== "string" || !value.providerID || value.providerID.length > 1024 ||
      typeof value.beforeHash !== "string" || !/^[a-f0-9]{64}$/.test(value.beforeHash) ||
      typeof value.after !== "string" || Buffer.byteLength(value.after) > MAX_CONFIG_BYTES ||
      typeof value.summary !== "string" || !value.summary || value.summary.length > 65_536 ||
      !Number.isSafeInteger(value.createdAt) || value.createdAt < 0) {
    throw new Error("Неверные данные предпросмотра. Запись запрещена.")
  }
}

function intended(before: string, after: string, providerID: string): void {
  const models = modelEntries(after, providerID)
  if (!Object.keys(models).length || replaceModels(before, providerID, models) !== after) {
    throw new Error("Предпросмотр изменяет не только выбранные модели. Запись запрещена.")
  }
}

/** Retains only the source digest, never a second copy of the source configuration. */
export function prepareUpdate(input: PrepareUpdateInput): PreparedUpdate {
  try {
    if (typeof input.path !== "string" || !isAbsolute(input.path)) throw new Error("path")
    intended(input.before, input.after, input.providerID)
    const value = { path: resolve(input.path), providerID: input.providerID, beforeHash: digest(input.before),
      after: input.after, summary: input.summary, createdAt: input.createdAt ?? Date.now() }
    fields(value)
    return Object.freeze({ ...value, identity: identity(value) })
  } catch {
    throw new Error("Не удалось подготовить безопасное обновление выбранных моделей.")
  }
}

function snapshot(prepared: PreparedUpdate, expected: string): PreparedUpdate {
  // Data descriptors prevent a mutable/accessor-backed object from changing while inspected.
  const descriptors = Object.getOwnPropertyDescriptors(prepared)
  for (const key of FIELDS) {
    if (!descriptors[key] || !("value" in descriptors[key])) throw new Error("Предпросмотр повреждён.")
  }
  const value = Object.fromEntries(FIELDS.map((key) => [key, descriptors[key]!.value])) as unknown as PreparedUpdate
  fields(value)
  if (typeof expected !== "string" || expected !== value.identity || identity(value) !== expected) {
    throw new Error("Подтверждение не соответствует предпросмотру. Создайте новый.")
  }
  return Object.freeze(value)
}

function sameNode(first: Stats, second: Stats): boolean {
  return first.dev === second.dev && first.ino === second.ino
}

function sameFile(first: Stats, second: Stats): boolean {
  return sameNode(first, second) && first.size === second.size && first.mode === second.mode &&
    first.mtimeMs === second.mtimeMs && first.ctimeMs === second.ctimeMs
}

function regular(info: Stats): void {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_CONFIG_BYTES ||
      (info.mode & 0o222) === 0) throw new Error("Нужен обычный доступный для записи файл без ссылок.")
}

async function read(handle: FileHandle, signal?: AbortSignal): Promise<Buffer> {
  const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1)
  let offset = 0
  for (;;) {
    abort(signal)
    const result = await handle.read(buffer, offset, buffer.length - offset, offset)
    abort(signal)
    offset += result.bytesRead
    if (offset > MAX_CONFIG_BYTES) throw new Error("Конфигурация превышает допустимый размер.")
    if (!result.bytesRead) return buffer.subarray(0, offset)
  }
}

async function current(path: string, signal?: AbortSignal): Promise<{ bytes: Buffer; info: Stats; text: string }> {
  abort(signal)
  const info = await lstat(path)
  abort(signal)
  regular(info)
  const canonical = await realpath(path)
  abort(signal)
  if (canonical !== path) throw new Error("Путь конфигурации изменён или содержит ссылку.")
  const handle = await open(path, READ_FLAGS)
  try {
    abort(signal)
    const opened = await handle.stat()
    abort(signal)
    regular(opened)
    if (!sameFile(info, opened)) throw new Error("Файл конфигурации изменён.")
    const bytes = await read(handle, signal)
    abort(signal)
    const checked = await handle.stat()
    abort(signal)
    if (!sameFile(opened, checked)) throw new Error("Файл конфигурации изменён.")
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
    return { bytes, info, text }
  } finally {
    await handle.close()
  }
}

async function write(handle: FileHandle, bytes: string | Buffer, dependencies: TransactionDependencies,
  signal?: AbortSignal, mode?: number): Promise<void> {
  abort(signal)
  await (dependencies.write ? dependencies.write(handle, bytes) : handle.writeFile(bytes))
  abort(signal)
  if (mode !== undefined) {
    await handle.chmod(mode)
    abort(signal)
  }
  await (dependencies.sync ? dependencies.sync(handle) : handle.sync())
  abort(signal)
}

interface OwnedFile { path: string; handle: FileHandle; info: Stats }

async function checkOwned(file: OwnedFile, signal?: AbortSignal): Promise<void> {
  abort(signal)
  const info = await lstat(file.path)
  abort(signal)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !sameNode(file.info, info)) {
    throw new Error("Служебный файл обновления изменён.")
  }
  const opened = await file.handle.stat()
  abort(signal)
  if (!sameNode(file.info, opened) || opened.nlink !== 1) throw new Error("Служебный файл обновления изменён.")
}

async function checkLock(file: OwnedFile, token: string, signal?: AbortSignal): Promise<void> {
  abort(signal)
  const info = await lstat(file.path)
  abort(signal)
  if (!info.isFile() || !sameNode(file.info, info) || info.size !== Buffer.byteLength(token)) {
    throw new Error("Блокировка обновления изменена.")
  }
  const handle = await open(file.path, READ_FLAGS)
  try {
    abort(signal)
    const opened = await handle.stat()
    abort(signal)
    if (!sameNode(file.info, opened)) throw new Error("Блокировка обновления изменена.")
    const bytes = Buffer.alloc(Buffer.byteLength(token) + 1)
    const result = await handle.read(bytes, 0, bytes.length, 0)
    abort(signal)
    if (bytes.subarray(0, result.bytesRead).toString("utf8") !== token) throw new Error("Блокировка обновления изменена.")
  } finally { await handle.close() }
}

async function removeOwned(file: OwnedFile, remove: (path: string) => Promise<void>, token?: string): Promise<void> {
  try {
    const info = await lstat(file.path)
    if (!info.isFile() || !sameNode(file.info, info)) return
    if (token !== undefined) {
      if (info.size > Buffer.byteLength(token)) return
      const handle = await open(file.path, READ_FLAGS)
      try {
        if (!sameNode(file.info, await handle.stat())) return
        const bytes = Buffer.alloc(Buffer.byteLength(token) + 1)
        const result = await handle.read(bytes, 0, bytes.length, 0)
        const content = bytes.subarray(0, result.bytesRead).toString("utf8")
        // A failed write can leave an empty/partial own token. Foreign contents stay untouched.
        if (!token.startsWith(content)) return
      } finally { await handle.close() }
    }
    await remove(file.path)
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return
    throw new Error("Не удалось убрать служебный файл обновления. Проверьте блокировку перед повтором.")
  }
}

async function owned(path: string): Promise<OwnedFile> {
  const handle = await open(path, "wx", 0o600)
  try { return { path, handle, info: await handle.stat() } }
  catch (error) { await handle.close(); throw error }
}

async function execute(prepared: PreparedUpdate, expected: string, options: ApplyUpdateOptions,
  dependencies: TransactionDependencies): Promise<ApplyUpdateResult> {
  const signal = options?.signal
  abort(signal)
  if (typeof options?.validate !== "function") throw new Error("Проверка схемы обязательна. Запись запрещена.")
  const { validate, now = Date.now } = options
  const preview = snapshot(prepared, expected)
  fresh(preview.createdAt, now())
  const token = randomUUID()
  let lock: OwnedFile | undefined
  let temp: OwnedFile | undefined
  let backup: OwnedFile | undefined
  let backupComplete = false
  let committed = false
  let result: ApplyUpdateResult | undefined
  const remove = dependencies.unlink ?? unlink
  try {
    const initial = await current(preview.path, signal)
    abort(signal)
    lock = await owned(`${preview.path}.iishko.lock`)
    abort(signal)
    // Track the bytes we own even if sync or cancellation subsequently fails.
    await (dependencies.write ? dependencies.write(lock.handle, token) : lock.handle.writeFile(token))
    abort(signal)
    await (dependencies.sync ? dependencies.sync(lock.handle) : lock.handle.sync())
    abort(signal)
    const source = await current(preview.path, signal)
    abort(signal)
    if (!sameFile(initial.info, source.info) || digest(source.bytes) !== preview.beforeHash) {
      throw new ChangedConfigError()
    }
    intended(source.text, preview.after, preview.providerID)
    parseConfig(preview.after)
    await validate(preview.after)
    abort(signal)
    const security = await (dependencies.security ?? createFileSecurity)(preview.path, signal)
    abort(signal)
    const backupPath = `${preview.path}.iishko-${randomUUID()}.bak`
    backup = await owned(backupPath)
    abort(signal)
    await security.protect(backup.path, signal)
    abort(signal)
    await checkOwned(backup, signal)
    abort(signal)
    await write(backup.handle, source.bytes, dependencies, signal)
    abort(signal)
    await backup.handle.close()
    backupComplete = true
    abort(signal)
    temp = await owned(`${preview.path}.iishko-${randomUUID()}.tmp`)
    abort(signal)
    await security.protect(temp.path, signal)
    abort(signal)
    await checkOwned(temp, signal)
    abort(signal)
    await write(temp.handle, preview.after, dependencies, signal, process.platform === "win32" ? undefined : source.info.mode & 0o777)
    abort(signal)
    await temp.handle.close()
    abort(signal)
    await checkLock(lock, token, signal)
    abort(signal)
    await security.verify(signal)
    abort(signal)
    const checked = await current(preview.path, signal)
    abort(signal)
    if (!sameFile(source.info, checked.info) || digest(checked.bytes) !== preview.beforeHash) {
      throw new ChangedConfigError()
    }
    snapshot(prepared, expected)
    fresh(preview.createdAt, now())
    abort(signal)
    // Locks exclude cooperating writers only. A noncooperating editor can still race this rename.
    await dependencies.rename(temp.path, preview.path)
    committed = true
    result = { backupPath }
    return result
  } catch (error) {
    abort(signal)
    if (error instanceof ChangedConfigError) throw error
    throw new Error("Безопасное обновление не выполнено. Проверьте права, блокировку и схему; создайте новый предпросмотр.")
  } finally {
    // Cleanup must run even after cancellation; never unlink the destination or a foreign lock.
    let cleanupFailed = false
    for (const file of [temp, backup, lock]) {
      if (!file) continue
      try {
        await file.handle.close()
      } catch { /* Handles normally already closed before commit. Removal is still attempted. */ }
      const needsRemoval = file === lock || (file === temp && !committed) || (file === backup && !backupComplete)
      if (!needsRemoval) continue
      try { await removeOwned(file, remove, file === lock ? token : undefined) }
      catch { cleanupFailed = true }
    }
    if (cleanupFailed) {
      const warning = "Не удалось убрать служебный файл обновления. Проверьте блокировку перед повтором."
      if (committed && result) result.warning = `Конфигурация обновлена. ${warning}`
      else throw new Error(warning)
    }
  }
}

export function applyUpdate(prepared: PreparedUpdate, expectedIdentity: string,
  options: ApplyUpdateOptions): Promise<ApplyUpdateResult> {
  return execute(prepared, expectedIdentity, options, { rename })
}

export function createTransaction(dependencies: TransactionDependencies): { applyUpdate: typeof applyUpdate } {
  return { applyUpdate: (prepared, expected, options) => execute(prepared, expected, options, dependencies) }
}
