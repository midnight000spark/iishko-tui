/** Test-only owner setup for synthetic files on elevated Windows CI runners. */
import { win32 } from "node:path"
import { spawn } from "node:child_process"

export async function ownWindowsFixture(path: string): Promise<void> {
  if (process.platform !== "win32") return
  const root = globalThis.process.env.SystemRoot!
  const script = `$ErrorActionPreference='Stop';[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);[Console]::Error.WriteLine('fixture-start');try{$raw=[Console]::In.ReadToEnd();[Console]::Error.WriteLine('fixture-input');$data=ConvertFrom-Json -InputObject $raw;[Console]::Error.WriteLine('fixture-json');$acl=Get-Acl -LiteralPath $data.path;[Console]::Error.WriteLine('fixture-read');$acl.SetOwner([Security.Principal.WindowsIdentity]::GetCurrent().User);[Console]::Error.WriteLine('fixture-owner');Set-Acl -LiteralPath $data.path -AclObject $acl;[Console]::Error.WriteLine('fixture-applied');exit 0}catch{[Console]::Error.WriteLine('fixture-refused');exit 1}`
  await new Promise<void>((resolve, reject) => {
    const child = spawn(win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
        env: { SystemRoot: root, WINDIR: root, PSModulePath: win32.join(root, "System32", "WindowsPowerShell", "v1.0", "Modules") },
        stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      })
    let diagnostics = ""
    const timer = setTimeout(() => { child.kill() }, 15_000)
    child.stdout.resume()
    child.stderr.on("data", (chunk) => { if (diagnostics.length < 4096) diagnostics += chunk })
    child.stdin.on("error", () => {})
    child.on("error", () => {})
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`Synthetic Windows fixture owner setup failed (${code}); stages: ${(diagnostics.match(/fixture-[a-z]+/g) ?? []).join(",")}`))
    })
    child.stdin.end(JSON.stringify({ path }), "utf8")
  })
}
