/** Synthetic CI-only diagnostics. Never prints paths, stdin, descriptors or child errors. */
import { spawn } from "node:child_process"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, win32 } from "node:path"
import { createFileSecurityFactory, type AclRequest } from "../src/windows-acl.js"

if (process.platform === "win32") {
  const root = process.env.SystemRoot!
  const executable = win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  const modules = win32.join(root, "System32", "WindowsPowerShell", "v1.0", "Modules")
  const minimal = { SystemRoot: root, WINDIR: root, PSModulePath: modules }
  const inherited = { ...process.env, PSModulePath: modules } as Record<string, string>
  const script = `[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);[Console]::Error.WriteLine('stage-start');$data=[Console]::In.ReadToEnd();[Console]::Error.WriteLine('stage-input');try {Import-Module Microsoft.PowerShell.Utility -ErrorAction Stop;[Console]::Error.WriteLine('stage-module');$null=ConvertFrom-Json -InputObject $data;[Console]::Error.WriteLine('stage-json');exit 0}catch{exit 1}`
  const args = ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]
  async function execute(label: string, request: AclRequest, native: boolean): Promise<string> {
    let output = "", diagnostics = "", code: number | null, timedOut = false
    if (native) {
      const child = Bun.spawn([request.executable, ...request.args], {
        env: { ...request.env }, stdin: new TextEncoder().encode(request.input), stdout: "pipe", stderr: "pipe",
      })
      const timer = setTimeout(() => { timedOut = true; child.kill() }, 8_000)
      try { [output, diagnostics, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]) }
      finally { clearTimeout(timer) }
    } else {
      code = await new Promise<number | null>((resolve) => {
        const child = spawn(request.executable, [...request.args], { env: { ...request.env }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
        const timer = setTimeout(() => { timedOut = true; child.kill() }, 8_000)
        child.stdout.on("data", (chunk) => { output += chunk })
        child.stderr.on("data", (chunk) => { diagnostics += chunk })
        child.stdin.on("error", () => {})
        child.on("error", () => {})
        child.on("close", (value) => { clearTimeout(timer); resolve(value) })
        child.stdin.end(request.input, "utf8")
      })
    }
    const stages = diagnostics.match(/stage-[a-z]+/g) ?? []
    console.log(JSON.stringify({ label, code, timedOut, stages, outputBytes: Buffer.byteLength(output) }))
    if (code !== 0 || timedOut) throw new Error("synthetic diagnostic failed")
    return output
  }
  for (const [label, env, native] of [["node-minimal", minimal, false], ["node-inherited", inherited, false], ["bun-minimal", minimal, true], ["bun-inherited", inherited, true]] as const) {
    await execute(label, { executable, args, input: "{}", env }, native).catch(() => {})
  }
  const directory = await realpath(await mkdtemp(join(tmpdir(), "iishko-diagnostic-")))
  try {
    const source = join(directory, "fixture.json")
    await writeFile(source, "{}")
    const factory = createFileSecurityFactory({ run: async (request) => {
      const code = Buffer.from(request.args.at(-1)!, "base64").toString("utf16le")
        .replace("$data = Microsoft.PowerShell.Utility", "[Console]::Error.WriteLine('stage-start');$data = Microsoft.PowerShell.Utility")
        .replace("$source = Read-Acl", "[Console]::Error.WriteLine('stage-input');$source = Read-Acl")
        .replace("$item = Microsoft.PowerShell.Management", "[Console]::Error.WriteLine('stage-item');$item = Microsoft.PowerShell.Management")
        .replace("$acl = Microsoft.PowerShell.Security", "[Console]::Error.WriteLine('stage-getacl');$acl = Microsoft.PowerShell.Security")
        .replace("$owner = $source.GetOwner", "[Console]::Error.WriteLine('stage-source-read');$owner = $source.GetOwner")
        .replace("{ throw 'owner' }", "{ [Console]::Error.WriteLine('stage-owner-refused');throw 'owner' }")
        .replace("$normalized = Normalize-Acl $source", "[Console]::Error.WriteLine('stage-source');$normalized = Normalize-Acl $source")
        .replace("} catch { exit 1 }", "} catch { [Console]::Error.WriteLine('stage-refused');exit 1 }")
      const revised = { ...request, args: [...request.args.slice(0, -1), Buffer.from(code, "utf16le").toString("base64")] }
      await execute("acl-snapshot-node", revised, false).catch(() => {})
      return execute("acl-snapshot-bun", revised, true)
    } })
    await factory(source).then(() => console.log("acl-snapshot-success"), () => console.log("acl-snapshot-refused"))
  } finally { await rm(directory, { recursive: true, force: true }) }
}
