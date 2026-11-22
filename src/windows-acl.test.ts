import { describe, expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import type { spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, win32 } from "node:path"
import { PassThrough } from "node:stream"
import { replaceModels } from "./config-document.js"
import { applyUpdate, prepareUpdate } from "./transaction.js"
import { createAclRunner, createFileSecurityFactory } from "./windows-acl.js"
import type { AclRequest, AclRunner } from "./windows-acl.js"

const descriptors = { source: "O:SYD:AI(A;ID;FA;;;SY)", normalized: "O:SYD:P(A;;FA;;;SY)" }
const root = "C:\\Windows"
const source = "C:\\fixtures\\config [a] ' ; $(ignored).jsonc"

function factory(run: AclRunner) {
  return createFileSecurityFactory({ platform: "win32", systemRoot: root, run })
}

describe("Windows file security", () => {
  test("passes paths as JSON data and executes one fixed script using trusted absolute executable", async () => {
    const requests: AclRequest[] = []
    const create = factory(async (request) => {
      requests.push(request)
      const data = JSON.parse(request.input) as { operation: string }
      return data.operation === "snapshot" ? JSON.stringify(descriptors) : "ok"
    })
    const target = "C:\\fixtures\\temp [*] ' ; $(ignored).tmp"
    const security = await create(source)
    await security.protect(target)
    await security.verify()
    expect(requests).toHaveLength(3)
    expect(new Set(requests.map((request) => JSON.stringify(request.args))).size).toBe(1)
    for (const request of requests) {
      expect(request.executable).toBe(win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"))
      expect(request.args).toContain("-NoProfile")
      expect(request.args).toContain("-NonInteractive")
      expect(request.args.join(" ")).not.toMatch(/ExecutionPolicy|Bypass|config \[a\]/)
      const script = Buffer.from(request.args.at(-1)!, "base64").toString("utf16le")
      expect(script).not.toContain(source)
      expect(script).not.toContain(target)
      expect(script).toContain("-LiteralPath")
      expect(script).toContain("SetAccessRuleProtection($true, $true)")
      expect(script).toContain("AreAccessRulesCanonical")
      expect(script).toContain("null-dacl")
      expect(script).not.toContain("Invoke-Expression")
      expect(request.env["PATH"]).toBeUndefined()
    }
    expect(JSON.parse(requests[1]!.input)).toEqual({ operation: "protect", ...{
      snapshot: descriptors.source, normalized: descriptors.normalized, targetPath: target, sourcePath: source,
    } })
    expect(JSON.parse(requests[2]!.input).targets).toEqual([target])
  })

  test("POSIX relies on mode protection and never invokes PowerShell", async () => {
    const create = createFileSecurityFactory({ platform: "linux", run: async () => { throw new Error("must not run") } })
    const security = await create("/fixture/config")
    await security.protect("/fixture/temp")
    await security.verify()
  })

  test("rejects missing SystemRoot and does not fall back to PATH", async () => {
    let calls = 0
    const create = createFileSecurityFactory({ platform: "win32", systemRoot: "", run: async () => { calls++; return "" } })
    await expect(create(source)).rejects.toThrow("права доступа Windows")
    expect(calls).toBe(0)
  })

  test("fails closed on malformed descriptors, helper/policy errors and oversized output", async () => {
    for (const output of ["", "not json", "{}", '{"source":123,"normalized":"x"}', "x".repeat(1024 * 1024 + 1)]) {
      await expect(factory(async () => output)(source)).rejects.toThrow("права доступа Windows")
    }
    let message = ""
    try { await factory(async () => { throw new Error("private-path-and-diagnostic") })(source) }
    catch (error) { message = String(error) }
    expect(message).not.toContain("private-path-and-diagnostic")
    expect(message).toContain("Запись отменена")
  })

  test("failed protect is not accepted and verify propagates sanitized descriptor-change failure", async () => {
    let operation = ""
    const security = await factory(async (request) => {
      operation = JSON.parse(request.input).operation
      return operation === "snapshot" ? JSON.stringify(descriptors) : "not-ok-private"
    })(source)
    await expect(security.protect("C:\\fixture.tmp")).rejects.toThrow("права доступа Windows")
    expect(operation).toBe("protect")
    await expect(security.verify()).rejects.toThrow("права доступа Windows")
  })

  test("checks cancellation before spawning and after deferred runner completion", async () => {
    let calls = 0
    const controller = new AbortController()
    controller.abort(new Error("private reason"))
    await expect(factory(async () => { calls++; return JSON.stringify(descriptors) })(source, controller.signal)).rejects.toMatchObject({ name: "AbortError" })
    expect(calls).toBe(0)
    const later = new AbortController()
    const create = factory(async () => { later.abort(); return JSON.stringify(descriptors) })
    await expect(create(source, later.signal)).rejects.toMatchObject({ name: "AbortError" })
  })
})

function fakeProcess(onInput: (child: EventEmitter & { stdout: PassThrough; stderr: PassThrough }) => void) {
  let killed = false
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: () => { killed = true; queueMicrotask(() => child.emit("close", null)); return true },
  })
  child.stdin.on("finish", () => onInput(child))
  const launch = (() => child) as unknown as typeof spawn
  return { child, launch, killed: () => killed }
}

const request: AclRequest = { executable: "C:\\Windows\\powershell.exe", args: [], input: "{}", env: {} }

describe("ACL subprocess boundary", () => {
  test("uses piped stdin, no shell and hidden noninteractive window", async () => {
    const fake = fakeProcess((child) => { child.stdout.write("ok"); child.emit("close", 0) })
    let captured: unknown[] = []
    const launch = ((...args: unknown[]) => { captured = args; return fake.child }) as unknown as typeof spawn
    expect(await createAclRunner({ spawn: launch })(request)).toBe("ok")
    expect(captured[2]).toMatchObject({ shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
  })

  test("kills and waits for exit on cancellation without exposing child output", async () => {
    const controller = new AbortController()
    const fake = fakeProcess((child) => { child.stderr.write("private stderr"); controller.abort() })
    await expect(createAclRunner({ spawn: fake.launch })(request, controller.signal)).rejects.toMatchObject({ name: "AbortError" })
    expect(fake.killed()).toBe(true)
  })

  test("kills timed out or oversized-output child and rejects nonzero exit safely", async () => {
    const slow = fakeProcess(() => undefined)
    await expect(createAclRunner({ spawn: slow.launch, timeoutMs: 1 })(request)).rejects.toThrow("права доступа Windows")
    expect(slow.killed()).toBe(true)
    const big = fakeProcess((child) => { child.stdout.write(Buffer.alloc(1024 * 1024 + 1, 120)) })
    await expect(createAclRunner({ spawn: big.launch })(request)).rejects.toThrow("права доступа Windows")
    expect(big.killed()).toBe(true)
    const failed = fakeProcess((child) => { child.stderr.write("private diagnostic"); child.emit("close", 1) })
    await expect(createAclRunner({ spawn: failed.launch })(request)).rejects.toThrow("Запись отменена")
  })

  test("handles stdin/stdout/stderr and process error events without uncaught diagnostics", async () => {
    for (const stream of ["stdin", "stdout", "stderr", "process"] as const) {
      const fake = fakeProcess(() => undefined)
      const launch = (() => {
        queueMicrotask(() => {
          if (stream === "process") fake.child.emit("error", new Error("private pipe failure"))
          else fake.child[stream].emit("error", new Error("private pipe failure"))
        })
        return fake.child
      }) as unknown as typeof spawn
      await expect(createAclRunner({ spawn: launch })(request)).rejects.toThrow("права доступа Windows")
      expect(fake.killed()).toBe(true)
    }
    const fake = fakeProcess(() => undefined)
    fake.child.stdin.end = (() => { throw new Error("private synchronous stdin failure") }) as typeof fake.child.stdin.end
    await expect(createAclRunner({ spawn: fake.launch })(request)).rejects.toThrow("права доступа Windows")
    expect(fake.killed()).toBe(true)
  })

  test("sanitizes synchronous process creation failure", async () => {
    const launch = (() => { throw new Error("private unavailable executable") }) as unknown as typeof spawn
    await expect(createAclRunner({ spawn: launch })(request)).rejects.toThrow("Запись отменена")
  })
})

// Windows-only fixture: deliberately broad parent, restricted source, no live config/admin changes.
const FIXTURE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
  $data = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $sections = [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Access
  if ($data.operation -eq 'setup') {
    $parent = Get-Acl -LiteralPath $data.directory
    $everyone = [Security.Principal.SecurityIdentifier]::new('S-1-1-0')
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($everyone, [Security.AccessControl.FileSystemRights]::ReadAndExecute, [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit', [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
    $parent.AddAccessRule($rule)
    Set-Acl -LiteralPath $data.directory -AclObject $parent
    $source = [Security.AccessControl.FileSecurity]::new()
    $source.SetOwner($sid)
    $source.SetAccessRuleProtection($true, $false)
    $source.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow))
    Set-Acl -LiteralPath $data.path -AclObject $source
  } else {
    $source = Get-Acl -LiteralPath $data.path
    if (-not $source.AreAccessRulesProtected -or -not $source.AreAccessRulesCanonical) { throw 'protection' }
    $source.SetAccessRuleProtection($true, $true)
    $sourceRaw = [Security.AccessControl.RawSecurityDescriptor]::new($source.GetSecurityDescriptorSddlForm($sections))
    $flags = [Security.AccessControl.ControlFlags]::DiscretionaryAclPresent -bor [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected
    $sourceNormalized = [Security.AccessControl.RawSecurityDescriptor]::new($flags, $sourceRaw.Owner, $null, $null, $sourceRaw.DiscretionaryAcl)
    foreach ($targetPath in @($data.path, $data.backup)) {
      $target = Get-Acl -LiteralPath $targetPath
      if (-not $target.AreAccessRulesProtected) { throw 'inheritance' }
      if ($target.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $sid.Value) { throw 'owner' }
      foreach ($ace in $target.Access) {
        if ($ace.IsInherited -or $ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -cne $sid.Value) { throw 'broader' }
      }
      $target.SetAccessRuleProtection($true, $true)
      $targetRaw = [Security.AccessControl.RawSecurityDescriptor]::new($target.GetSecurityDescriptorSddlForm($sections))
      $targetNormalized = [Security.AccessControl.RawSecurityDescriptor]::new($flags, $targetRaw.Owner, $null, $null, $targetRaw.DiscretionaryAcl)
      if ($targetNormalized.GetSddlForm($sections) -cne $sourceNormalized.GetSddlForm($sections)) { throw 'different' }
    }
  }
  [Console]::Out.Write('ok')
  exit 0
} catch { exit 1 }
`

test.skipIf(process.platform !== "win32")("Windows apply preserves restricted effective ACLs despite broad directory inheritance", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "iishko-acl-")))
  const path = join(directory, "config [literal] ' тест.jsonc")
  const root = process.env["SystemRoot"]!
  const run = createAclRunner()
  const execute = (data: Record<string, unknown>) => run({
    executable: win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(FIXTURE_SCRIPT, "utf16le").toString("base64")],
    input: JSON.stringify(data), env: { SystemRoot: root, WINDIR: root },
  })
  try {
    const before = '{"providers":{"account":{"models":{"old":{}}}}}'
    await writeFile(path, before)
    expect(await execute({ operation: "setup", directory, path })).toBe("ok")
    const after = replaceModels(before, "account", { next: {} })
    const preview = prepareUpdate({ path, providerID: "account", before, after, summary: "ACL fixture" })
    const result = await applyUpdate(preview, preview.identity, { validate: () => undefined })
    expect(await execute({ operation: "assert", path, backup: result.backupPath })).toBe("ok")
    expect(await readFile(path, "utf8")).toBe(after)
    expect(await readFile(result.backupPath, "utf8")).toBe(before)
  } finally { await rm(directory, { recursive: true, force: true }) }
}, 60_000)
