import { Buffer } from "node:buffer"
import { spawn } from "node:child_process"
import { win32 } from "node:path"

export interface FileSecurity {
  protect(targetPath: string, signal?: AbortSignal): Promise<void>
  verify(signal?: AbortSignal): Promise<void>
}

export interface AclRequest {
  readonly executable: string
  readonly args: readonly string[]
  readonly input: string
  readonly env: Readonly<Record<string, string>>
}

export type AclRunner = (request: AclRequest, signal?: AbortSignal) => Promise<string>

const MAX_OUTPUT = 1024 * 1024
const FAILURE = "Не удалось сохранить безопасные права доступа Windows. Запись отменена."

// Fixed code only. All paths/descriptors are JSON on stdin, never executable text.
// No policy changes, elevation, external module paths, or PATH-based executable lookup.
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$sections = [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Access
function Read-Acl([string] $path) {
  $item = Microsoft.PowerShell.Management\Get-Item -LiteralPath $path -Force
  if ($item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw 'file' }
  $acl = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $path
  if (-not $acl.AreAccessRulesCanonical) { throw 'canonical' }
  $raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorSddlForm($sections))
  if ($null -eq $raw.DiscretionaryAcl) { throw 'null-dacl' }
  return $acl
}
function Normalize-Acl($acl) {
  $copy = [Security.AccessControl.FileSecurity]::new()
  $copy.SetSecurityDescriptorSddlForm($acl.GetSecurityDescriptorSddlForm($sections), $sections)
  $copy.SetAccessRuleProtection($true, $true)
  if (-not $copy.AreAccessRulesCanonical) { throw 'canonical' }
  $raw = [Security.AccessControl.RawSecurityDescriptor]::new($copy.GetSecurityDescriptorSddlForm($sections))
  $flags = [Security.AccessControl.ControlFlags]::DiscretionaryAclPresent -bor [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected
  $normalized = [Security.AccessControl.RawSecurityDescriptor]::new($flags, $raw.Owner, $null, $null, $raw.DiscretionaryAcl)
  return $normalized.GetSddlForm($sections)
}
function Check-Target([string] $path, [string] $normalized) {
  $acl = Read-Acl $path
  if (-not $acl.AreAccessRulesProtected) { throw 'inheritance' }
  foreach ($rule in $acl.Access) { if ($rule.IsInherited) { throw 'inherited-ace' } }
  if ((Normalize-Acl $acl) -cne $normalized) { throw 'target-changed' }
}
try {
  $data = Microsoft.PowerShell.Utility\ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
  $source = Read-Acl ([string] $data.sourcePath)
  $original = $source.GetSecurityDescriptorSddlForm($sections)
  $owner = $source.GetOwner([Security.Principal.SecurityIdentifier])
  if ($owner.Value -cne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { throw 'owner' }
  $normalized = Normalize-Acl $source
  if ($data.operation -eq 'snapshot') {
    [Console]::Out.Write((Microsoft.PowerShell.Utility\ConvertTo-Json -Compress -InputObject @{ source = $original; normalized = $normalized }))
  } else {
    if ($original -cne [string] $data.snapshot -or $normalized -cne [string] $data.normalized) { throw 'source-changed' }
    if ($data.operation -eq 'protect') {
      $target = Read-Acl ([string] $data.targetPath)
      $protected = [Security.AccessControl.FileSecurity]::new()
      $protected.SetSecurityDescriptorSddlForm($normalized, $sections)
      $protected.SetAccessRuleProtection($true, $true)
      Microsoft.PowerShell.Security\Set-Acl -LiteralPath ([string] $data.targetPath) -AclObject $protected
      Check-Target ([string] $data.targetPath) $normalized
    } elseif ($data.operation -eq 'verify') {
      foreach ($path in $data.targets) { Check-Target ([string] $path) $normalized }
    } else { throw 'operation' }
    [Console]::Out.Write('ok')
  }
  exit 0
} catch { exit 1 }
`

function abort(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const error = new Error("Обновление отменено.")
  error.name = "AbortError"
  throw error
}

/** Injectable process boundary; never exposes child diagnostics or partial output. */
export function createAclRunner(dependencies: { spawn?: typeof spawn; timeoutMs?: number } = {}): AclRunner {
  return async (request, signal) => {
    abort(signal)
    return await new Promise<string>((resolve, reject) => {
      const child = (dependencies.spawn ?? spawn)(request.executable, [...request.args], {
        shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...request.env },
      })
      let output = ""
      let bytes = 0
      let failed = false
      let cancelled = false
      const stop = (): void => {
        failed = true
        // Process termination is best-effort; its close event still owns promise settlement.
        try { child.kill("SIGKILL") } catch { /* Already exited or unavailable; never throw from an event handler. */ }
      }
      const cancel = (): void => { cancelled = true; stop() }
      const timer = setTimeout(stop, dependencies.timeoutMs ?? 15_000)
      const cleanup = (): void => { clearTimeout(timer); signal?.removeEventListener("abort", cancel) }
      const failure = (): Error => {
        const error = new Error(cancelled ? "Обновление отменено." : FAILURE)
        if (cancelled) error.name = "AbortError"
        return error
      }
      signal?.addEventListener("abort", cancel, { once: true })
      if (signal?.aborted) cancel()
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > MAX_OUTPUT) { stop(); return }
        output += chunk.toString("utf8")
      })
      child.stderr.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > MAX_OUTPUT) stop() })
      child.stdin.on("error", stop)
      child.stdout.on("error", stop)
      child.stderr.on("error", stop)
      child.once("error", stop)
      child.once("close", (code) => {
        cleanup()
        if (failed || code !== 0) reject(failure())
        else resolve(output)
      })
      try { child.stdin.end(request.input, "utf8") }
      catch { stop() }
    }).catch(() => {
      abort(signal)
      throw new Error(FAILURE)
    })
  }
}

export function createFileSecurityFactory(dependencies: {
  platform?: string
  systemRoot?: string
  run?: AclRunner
} = {}): (sourcePath: string, signal?: AbortSignal) => Promise<FileSecurity> {
  const run = dependencies.run ?? createAclRunner()
  return async (sourcePath, signal) => {
    abort(signal)
    if ((dependencies.platform ?? process.platform) !== "win32") {
      return { protect: async (_path, nextSignal) => { abort(nextSignal) }, verify: async (nextSignal) => { abort(nextSignal) } }
    }
    try {
      const root = dependencies.systemRoot ?? process.env["SystemRoot"]
      if (!root || !win32.isAbsolute(root) || root.includes("\0") || !win32.isAbsolute(sourcePath)) throw new Error("path")
      const executable = win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(SCRIPT, "utf16le").toString("base64")]
      const env = { SystemRoot: root, WINDIR: root, PSModulePath: win32.join(root, "System32", "WindowsPowerShell", "v1.0", "Modules") }
      const invoke = async (data: Record<string, unknown>, nextSignal?: AbortSignal): Promise<string> => {
        abort(nextSignal)
        try {
          const output = await run({ executable, args, input: JSON.stringify({ ...data, sourcePath }), env }, nextSignal)
          abort(nextSignal)
          if (Buffer.byteLength(output) > MAX_OUTPUT) throw new Error("output")
          return output
        } catch { abort(nextSignal); throw new Error(FAILURE) }
      }
      const raw: unknown = JSON.parse(await invoke({ operation: "snapshot" }, signal))
      abort(signal)
      if (typeof raw !== "object" || raw === null || !("source" in raw) || !("normalized" in raw) ||
          typeof raw.source !== "string" || !raw.source || typeof raw.normalized !== "string" || !raw.normalized) throw new Error("descriptor")
      const snapshot = raw.source
      const normalized = raw.normalized
      const targets: string[] = []
      return {
        protect: async (targetPath, nextSignal) => {
          abort(nextSignal)
          if (!win32.isAbsolute(targetPath) || targetPath.includes("\0")) throw new Error(FAILURE)
          const result = await invoke({ operation: "protect", snapshot, normalized, targetPath }, nextSignal)
          abort(nextSignal)
          if (result !== "ok") throw new Error(FAILURE)
          targets.push(targetPath)
        },
        verify: async (nextSignal) => {
          const result = await invoke({ operation: "verify", snapshot, normalized, targets: [...targets] }, nextSignal)
          abort(nextSignal)
          if (result !== "ok") throw new Error(FAILURE)
        },
      }
    } catch { abort(signal); throw new Error(FAILURE) }
  }
}

/** POSIX relies on the transaction's mode 0600; Windows needs an explicit protected DACL. */
export const createFileSecurity = createFileSecurityFactory()
