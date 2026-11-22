/** Execute the actual release with a mock host in a separate process, not the test suite. */
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { builtinModules } from "node:module"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const HOST = "@opencode/plugin/tui"
const MARKER = "bundle-smoke: OK"
const expected = [
  { id: "iishko-tui.menu", slash: "iishko-tui", bind: "<leader>ir" },
  { id: "iishko-tui.refresh", slash: "iishko-update", bind: "<leader>iu" },
  { id: "iishko-tui.catalog", slash: "iishko-catalog", bind: "<leader>ic" },
]

// Official Bun module mocks; confined to this disposable child, never shared with bun test.
const helper = `
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { mock, test } from "bun:test";
test("actual release registration and cancellation without external effects", async () => {
let definition;
let layer;
const calls = { select: 0, unexpected: 0, store: 0 };
const forbidden = () => { calls.unexpected++; throw new Error("unexpected external effect"); };
globalThis.fetch = forbidden;
mock.module("${HOST}", () => ({ Plugin: { define(value) { definition = value; return value; } } }));
const filesystem = Object.fromEntries(["lstat", "open", "readFile", "realpath", "rename", "stat", "unlink"].map(name => [name, forbidden]));
mock.module("node:fs/promises", () => filesystem);
mock.module("fs/promises", () => filesystem);
const fsGuard = await import("fs/promises");
assert.equal(fsGuard.stat, forbidden, "filesystem guard must actually replace the builtin");
const loaded = await import(pathToFileURL(process.env.IISHKO_SMOKE_BUNDLE).href);
assert.ok(definition, "Plugin.define not called");
assert.equal(loaded.default, definition);
assert.equal(definition.id, "iishko-tui");
const initial = { ranks: {}, priority: "site" };
const cleanup = await definition.setup({
  options: {}, app: { version: "2.2.5", channel: "stable" },
  storage: { store(key, options) {
    calls.store++;
    assert.equal(key, "iishko-tui");
    assert.deepEqual(options.initial, initial);
    return [structuredClone(initial), forbidden];
  } },
  keymap: { layer(factory) { assert.equal(layer, undefined); layer = factory; } },
  ui: {
    dialog: { set: forbidden, clear: forbidden, alert: forbidden, confirm: forbidden,
      async select(input) { calls.select++; assert.match(input.title, /ИИШКО/); return undefined; } },
    toast: { show: forbidden },
  },
});
assert.equal(typeof cleanup, "function");
assert.equal(calls.store, 1);
const value = layer();
assert.equal(value.mode, "global");
assert.equal(value.priority, 10);
assert.deepEqual(value.commands.map(command => ({ id: command.id, slash: command.slash.name, bind: command.bind })), ${JSON.stringify(expected)});
assert.deepEqual(value.bindings, ${JSON.stringify(expected.map((command) => command.id))});
await value.commands[0].run();
assert.equal(calls.select, 1);
assert.equal(calls.unexpected, 0);
cleanup();
const before = JSON.stringify(calls);
for (const command of value.commands) await command.run();
assert.equal(JSON.stringify(calls), before, "disposed commands must be inert");
console.log("${MARKER}: 3 commands, cancelled menu, cleanup, no late effects or unbundled dependencies");
});
`

export async function smoke(release: string): Promise<void> {
  const plugin = join(release, "iishko-tui")
  const source = await readFile(join(plugin, "tui.js"), "utf8")
  const imports = new Bun.Transpiler({ loader: "js", target: "bun" }).scan(source).imports
  if (!imports.some((item) => item.path === HOST)) throw new Error("Missing host SDK import")
  for (const item of imports) {
    const builtin = item.path.startsWith("node:") ? item.path.slice(5) : item.path
    if (item.path !== HOST && !builtinModules.includes(builtin) && builtin !== "bun") {
      throw new Error("Unexpected unbundled dependency")
    }
  }
  const parent = join(root, ".tmp", "bundle-smoke")
  await mkdir(parent, { recursive: true })
  for (const path of [join(root, ".tmp"), parent]) {
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe smoke directory")
  }
  const fixture = await mkdtemp(join(parent, "run-"))
  try {
    await copyFile(join(plugin, "tui.js"), join(fixture, "tui.mjs"))
    await writeFile(join(fixture, "smoke.test.mjs"), helper, { mode: 0o600 })
    const env: Record<string, string> = {
      HOME: fixture, USERPROFILE: fixture, XDG_CONFIG_HOME: join(fixture, "xdg"),
      ProgramData: join(fixture, "managed"), NO_COLOR: "1",
      IISHKO_SMOKE_BUNDLE: join(fixture, "tui.mjs"),
    }
    for (const key of ["SystemRoot", "WINDIR", "PATH", "TEMP", "TMP"]) {
      if (process.env[key]) env[key] = process.env[key]!
    }
    const child = Bun.spawn([process.execPath, "test", join(fixture, "smoke.test.mjs")], {
      cwd: fixture, env, stdout: "pipe", stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ])
    if (code !== 0 || !stdout.includes(MARKER)) {
      throw new Error(`Isolated bundle smoke failed (${code}): ${stderr.slice(0, 1500)}`)
    }
    console.log(stdout.trim())
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
}

if (import.meta.main) await smoke(resolve(process.argv[2] ?? join(root, ".tmp", "release")))
