import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inventory, verifyRelease } from "./verify-release";

const root = fileURLToPath(new URL("../", import.meta.url));
const version = "0.1.0";
const powershellRoot = join(Bun.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0");

async function fixture() {
  const base = join(root, ".tmp", "installer-tests");
  await mkdir(base, { recursive: true });
  const temp = await mkdtemp(join(base, "fixture-"));
  const release = join(temp, "release folder");
  const plugin = join(release, "iishko-tui");
  const config = join(temp, "user config");
  const bin = join(temp, "bin");
  await mkdir(plugin, { recursive: true });
  await mkdir(config);
  await mkdir(bin);
  const contents: Record<string, string> = {
    "package.json": JSON.stringify({ name: "iishko-tui", version, private: true, type: "module", exports: { "./tui": "./tui.js" } }),
    "tui.js": "export default { id: 'fixture-only' };\n",
    "THIRD-PARTY-NOTICES.txt": "Test fixture, not production notices.\n",
  };
  const files = Object.fromEntries(Object.entries(contents).map(([file, text]) => [file, createHash("sha256").update(text).digest("hex")]));
  for (const [file, text] of Object.entries(contents)) await writeFile(join(plugin, file), text);
  await writeFile(join(plugin, "release-manifest.json"), JSON.stringify({ name: "iishko-tui", version, minimumOpenCode: "2.2.5", files }));
  for (const file of ["README.md", "windows-smoke.md"]) await writeFile(join(release, file), "Fixture instructions\n");
  for (const file of ["install.cmd", "install.ps1"]) {
    await writeFile(join(release, file), (await readFile(join(root, "install/windows", file), "utf8")).replaceAll("__RELEASE_VERSION__", version));
  }
  await writeFile(join(bin, "opencode.cmd"), "@echo off\r\necho 2.2.5\r\n");
  const destination = join(config, "opencode", "plugins", "iishko-tui");
  const run = async (args: string[] = []) => {
    const process = Bun.spawn([
      join(powershellRoot, "powershell.exe"),
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(release, "install.ps1"),
      "-ConfigHome", config, "-NonInteractive", ...args,
    ], {
      env: { ...Bun.env, PATH: bin, PATHEXT: ".COM;.EXE;.BAT;.CMD", XDG_CONFIG_HOME: config, PSModulePath: join(powershellRoot, "Modules") },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      process.exited, new Response(process.stdout).text(), new Response(process.stderr).text(),
    ]);
    return { code, text: stdout + stderr };
  };
  return { temp, release, plugin, config, destination, bin, run, cleanup: () => rm(temp, { recursive: true, force: true }) };
}

describe("release verifier", () => {
  test("accepts a minimal portable payload without node_modules", async () => {
    const f = await fixture();
    try { await verifyRelease(f.release); } finally { await f.cleanup(); }
  });
  test("rejects modified payload bytes", async () => {
    const f = await fixture();
    try {
      await writeFile(join(f.plugin, "tui.js"), "modified");
      await expect(verifyRelease(f.release)).rejects.toThrow("checksum");
    } finally { await f.cleanup(); }
  });
  test("rejects unexpected files, including source maps", async () => {
    const f = await fixture();
    try {
      await writeFile(join(f.plugin, "tui.js.map"), "{}");
      await expect(verifyRelease(f.release)).rejects.toThrow("contents");
    } finally { await f.cleanup(); }
  });
  test("rejects checksum path traversal instead of reading outside payload", async () => {
    const f = await fixture();
    try {
      const path = join(f.plugin, "release-manifest.json");
      const manifest = JSON.parse(await readFile(path, "utf8"));
      manifest.files["../outside"] = "0".repeat(64);
      await writeFile(path, JSON.stringify(manifest));
      await expect(verifyRelease(f.release)).rejects.toThrow("allowlist");
    } finally { await f.cleanup(); }
  });
  test("source installer is ASCII for Windows PowerShell 5.1", async () => {
    expect(await readFile(join(root, "install/windows/install.ps1"), "utf8")).toMatch(/^[\x00-\x7f]+$/);
  });
});

describe.skipIf(process.platform !== "win32")("Windows PowerShell 5.1 installer (temporary fixtures only)", () => {
  test("installs, refuses implicit replacement, then backs up outside discovery", async () => {
    const f = await fixture();
    try {
      await mkdir(join(f.config, "opencode"));
      const configPath = join(f.config, "opencode", "opencode.jsonc");
      const original = "// unrelated fixture\r\n{}\r\n";
      await writeFile(configPath, original);
      const fresh = await f.run();
      expect(fresh.code, fresh.text).toBe(0);
      expect(await inventory(f.destination)).toEqual(["THIRD-PARTY-NOTICES.txt", "package.json", "release-manifest.json", "tui.js"].sort());
      const implicit = await f.run();
      expect(implicit.code).not.toBe(0);
      const replace = await f.run(["-Replace"]);
      expect(replace.code, replace.text).toBe(0);
      expect(await readdir(join(f.config, "opencode", "plugins"))).toEqual(["iishko-tui"]);
      expect((await readdir(join(f.config, "opencode", "iishko-plugin-backups"))).length).toBe(1);
      expect(await readFile(configPath, "utf8")).toBe(original);
    } finally { await f.cleanup(); }
  }, 30000);

  test("refuses tampered source and leaves prior installation untouched", async () => {
    const f = await fixture();
    try {
      const first = await f.run();
      expect(first.code, first.text).toBe(0);
      const original = await readFile(join(f.destination, "tui.js"), "utf8");
      await writeFile(join(f.plugin, "tui.js"), "corrupt");
      expect((await f.run(["-Replace"])).code).not.toBe(0);
      expect(await readFile(join(f.destination, "tui.js"), "utf8")).toBe(original);
    } finally { await f.cleanup(); }
  }, 30000);

  test("refuses unknown existing files without deleting them", async () => {
    const f = await fixture();
    try {
      await mkdir(f.destination, { recursive: true });
      await writeFile(join(f.destination, "personal.txt"), "keep");
      expect((await f.run(["-Replace"])).code).not.toBe(0);
      expect(await readFile(join(f.destination, "personal.txt"), "utf8")).toBe("keep");
    } finally { await f.cleanup(); }
  }, 30000);

  test("refuses junction destination and leaves linked directory untouched", async () => {
    const f = await fixture();
    try {
      const linked = join(f.temp, "linked");
      await mkdir(linked);
      await writeFile(join(linked, "keep.txt"), "keep");
      await mkdir(join(f.config, "opencode", "plugins"), { recursive: true });
      await symlink(linked, f.destination, "junction");
      expect((await f.run()).code).not.toBe(0);
      expect(await readFile(join(linked, "keep.txt"), "utf8")).toBe("keep");
    } finally { await f.cleanup(); }
  }, 30000);

  test("refuses incompatible and unparseable OpenCode versions", async () => {
    const f = await fixture();
    try {
      for (const value of ["1.9.0", "2.2.4", "unknown", "3.0.0"]) {
        await writeFile(join(f.bin, "opencode.cmd"), `@echo off\r\necho ${value}\r\n`);
        const result = await f.run();
        expect(result.code, `version ${value}: ${result.text}`).not.toBe(0);
      }
    } finally { await f.cleanup(); }
  }, 30000);

  test("missing OpenCode warns but permits explicitly requested folder copy", async () => {
    const f = await fixture();
    try {
      await rm(join(f.bin, "opencode.cmd"));
      const result = await f.run();
      expect(result.code, result.text).toBe(0);
      expect(result.text).toContain('OpenCode was not found');
    } finally { await f.cleanup(); }
  }, 30000);

  test("unknown release file is refused before creating a destination", async () => {
    const f = await fixture();
    try {
      await writeFile(join(f.plugin, "unexpected.ps1"), "throw 'must not run'");
      const result = await f.run();
      expect(result.code).not.toBe(0);
      expect(await readdir(f.config)).toEqual([]);
    } finally { await f.cleanup(); }
  }, 30000);

  test("uses the actual built payload when CI requests release smoke", async () => {
    if (Bun.env.IISHKO_TEST_RELEASE !== "1") return;
    const f = await fixture();
    try {
      await rm(f.release, { recursive: true });
      await cp(join(root, ".tmp/release"), f.release, { recursive: true });
      const result = await f.run();
      expect(result.code, result.text).toBe(0);
      expect(await readFile(join(f.destination, "tui.js"))).toEqual(await readFile(join(root, ".tmp/release/iishko-tui/tui.js")));
    } finally { await f.cleanup(); }
  }, 30000);
});
