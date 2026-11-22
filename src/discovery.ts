import { lstat, readFile, realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { parseConfig } from "./config-document.js"

export interface LocalAccount {
  readonly providerID: string
  readonly label: string
  readonly path: string
  readonly models: Readonly<Record<string, unknown>>
}

export interface DiscoveryOptions {
  readonly home?: string
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly platform?: string
  /** Explicit local file, never a server-provided path. */
  readonly configPath?: string
  readonly signal?: AbortSignal
  /** Isolates filesystem discovery in tests. */
  readonly paths?: readonly string[]
}

export function configPaths(options: DiscoveryOptions = {}): readonly string[] {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const roots = [join(env["XDG_CONFIG_HOME"] || join(home, ".config"), "opencode")]
  if (env["OPENCODE_CONFIG_DIR"]) roots.push(env["OPENCODE_CONFIG_DIR"])
  const platform = options.platform ?? process.platform
  if (platform === "win32") {
    if (env["ProgramData"]) roots.push(join(env["ProgramData"], "opencode"))
  } else roots.push(platform === "darwin" ? "/Library/Application Support/opencode" : "/etc/opencode")
  let dir = resolve(options.cwd ?? process.cwd())
  for (;;) {
    roots.push(dir, join(dir, ".opencode"))
    const parent = dirname(dir)
    if (dir === parent) break
    dir = parent
  }
  const paths = roots.flatMap((root) => [join(root, "opencode.json"), join(root, "opencode.jsonc")])
  if (env["OPENCODE_CONFIG"]) paths.push(resolve(env["OPENCODE_CONFIG"]))
  if (options.configPath !== undefined) {
    if (!isAbsolute(options.configPath)) throw new Error("Путь к локальному конфигу должен быть абсолютным.")
    paths.push(options.configPath)
  }
  return [...new Set(paths.map((path) => resolve(path)))]
}

/** Reads local documents only. Never reads credential files or follows config substitutions. */
export async function discoverAccounts(options: DiscoveryOptions = {}): Promise<readonly LocalAccount[]> {
  options.signal?.throwIfAborted()
  const env = options.env ?? process.env
  if (env["OPENCODE_CONFIG_CONTENT"]?.trim()) {
    throw new Error("Настройки заданы через OPENCODE_CONFIG_CONTENT. Автообновление файла неоднозначно; уберите inline-настройки перед обновлением.")
  }
  const found: LocalAccount[] = []
  const owners = new Map<string, number>()
  const home = options.home ?? homedir()
  const globalRoot = join(env["XDG_CONFIG_HOME"] || join(home, ".config"), "opencode")
  const allowedRoots = [globalRoot, ...(env["OPENCODE_CONFIG_DIR"] ? [env["OPENCODE_CONFIG_DIR"]] : [])].map((root) => resolve(root))
  const explicit = options.configPath === undefined ? undefined : resolve(options.configPath)
  for (const path of options.paths ?? configPaths(options)) {
    options.signal?.throwIfAborted()
    const text = await readOptional(path)
    options.signal?.throwIfAborted()
    if (text === undefined) continue
    const value = parseConfig(text).value
    const providers = record(value["providers"])
    if (providers === undefined) continue
    for (const [providerID, raw] of Object.entries(providers)) {
      owners.set(providerID, (owners.get(providerID) ?? 0) + 1)
      const provider = record(raw)
      if (provider === undefined || !isIishko(provider)) continue
      if (explicit !== undefined ? explicit !== resolve(path) : !allowedRoots.includes(resolve(dirname(path)))) continue
      const models = record(provider["models"])
      if (models === undefined || provider["canonical"] !== undefined) {
        throw new Error(`Аккаунт ${safeLabel(providerID)}: нужны явно заданные models без наследования canonical.`)
      }
      const info = await lstat(path)
      options.signal?.throwIfAborted()
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("Нужен обычный локальный файл конфигурации без ссылок.")
      const canonical = await realpath(path)
      options.signal?.throwIfAborted()
      const name = typeof provider["name"] === "string" ? provider["name"] : providerID
      found.push({ providerID, label: safeLabel(name), path: canonical, models })
    }
  }
  for (const account of found) {
    if ((owners.get(account.providerID) ?? 0) !== 1) {
      throw new Error(`Аккаунт ${safeLabel(account.providerID)} задан в нескольких конфигурациях. Автообновление отключено: объедините его настройки в одном файле.`)
    }
  }
  return found
}

function isIishko(provider: Record<string, unknown>): boolean {
  const settings = record(provider["settings"])
  if (typeof settings?.["baseURL"] !== "string") return false
  try {
    const url = new URL(settings["baseURL"])
    return url.protocol === "https:" && !url.username && !url.password &&
      ["api.reformboss.com", "reformboss.com"].includes(url.hostname) &&
      !url.port && !url.search && !url.hash && ["/v1", "/v1/"].includes(url.pathname)
  } catch { return false }
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > 4 * 1024 * 1024) throw new Error("Конфигурация не является обычным файлом допустимого размера.")
    return await readFile(path, "utf8")
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined
    // Do not include arbitrary filesystem/parser error text: configuration may contain secrets.
    throw new Error("Не удалось прочитать локальную конфигурацию. Проверьте права, формат и размер файла.")
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function safeLabel(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, 100)
}
