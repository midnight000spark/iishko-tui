/** Test-only owner setup for synthetic files on elevated Windows CI runners. */
import { win32 } from "node:path"

export async function ownWindowsFixture(path: string): Promise<void> {
  if (process.platform !== "win32") return
  const root = globalThis.process.env.SystemRoot!
  const script = `$ErrorActionPreference='Stop';[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);try{$data=ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd());$acl=Get-Acl -LiteralPath $data.path;$acl.SetOwner([Security.Principal.WindowsIdentity]::GetCurrent().User);Set-Acl -LiteralPath $data.path -AclObject $acl;exit 0}catch{exit 1}`
  const child = Bun.spawn([win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    env: { SystemRoot: root, WINDIR: root, PSModulePath: win32.join(root, "System32", "WindowsPowerShell", "v1.0", "Modules") },
    stdin: new TextEncoder().encode(JSON.stringify({ path })), stdout: "ignore", stderr: "ignore",
    timeout: 15_000,
  })
  if (await child.exited !== 0) throw new Error("Synthetic Windows fixture owner setup failed")
}
