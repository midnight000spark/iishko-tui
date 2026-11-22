import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile, lstat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyRelease } from "./verify-release";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, ".tmp", "release");
const plugin = join(output, "iishko-tui");

// Preserve complete upstream copyright/license texts, including transitive deps.
async function notices(): Promise<string> {
  const seen = new Set<string>();
  const sections: string[] = [];
  async function visit(name: string, from: string): Promise<void> {
    const path = createRequire(join(from, "package.json")).resolve(`${name}/package.json`);
    if (seen.has(path)) return;
    seen.add(path);
    const pkg = JSON.parse(await readFile(path, "utf8")) as {
      name: string; version: string; dependencies?: Record<string, string>;
    };
    const directory = dirname(path);
    const licenses = (await readdir(directory)).filter((file) => /^(license|licence|copying)(\.|$)/i.test(file));
    if (!licenses.length) throw new Error(`Missing license text: ${pkg.name}`);
    sections.push(`## ${pkg.name}@${pkg.version}\n\n${(await Promise.all(
      licenses.sort().map((file) => readFile(join(directory, file), "utf8")),
    )).join("\n\n")}`);
    for (const child of Object.keys(pkg.dependencies ?? {}).sort()) await visit(child, directory);
  }
  for (const name of ["ajv", "ajv-formats", "jsonc-parser"]) await visit(name, root);
  const license = await readFile(join(root, "LICENSE"), "utf8");
  return `# Project license and bundled third-party notices\n\n## iishko-tui — MIT\n\n${license}\n\nHost OpenCode/Solid/OpenTUI are not bundled.\n\n${sections.join("\n\n")}\n`;
}

export async function build(): Promise<void> {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { name: string; version: string };
  if (pkg.name !== "iishko-tui" || !/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error("Invalid release identity");
  await mkdir(join(root, ".tmp"), { recursive: true });
  if ((await lstat(join(root, ".tmp"))).isSymbolicLink()) throw new Error("Unsafe temporary output parent");
  const previous = await lstat(output).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (previous?.isSymbolicLink() || (previous && !previous.isDirectory())) throw new Error("Unsafe release output");
  await rm(output, { recursive: true, force: true });
  await mkdir(plugin, { recursive: true });
  const result = await Bun.build({
    entrypoints: [resolve(root, "src/tui.ts")], root, outdir: plugin,
    naming: "tui.js", target: "bun", format: "esm", packages: "bundle",
    external: ["@opencode/plugin", "@opencode/plugin/*", "solid-js", "solid-js/*", "@opentui/*"],
    env: "disable", sourcemap: "none", splitting: false,
    minify: { whitespace: true, syntax: true, identifiers: false },
  });
  if (!result.success) throw new AggregateError(result.logs, "Release build failed");
  await writeFile(join(plugin, "package.json"), JSON.stringify({
    name: pkg.name, version: pkg.version, private: true, type: "module", exports: { "./tui": "./tui.js" },
  }, null, 2) + "\n");
  await writeFile(join(plugin, "THIRD-PARTY-NOTICES.txt"), await notices());
  const files = Object.fromEntries(await Promise.all(
    ["package.json", "tui.js", "THIRD-PARTY-NOTICES.txt"].map(async (file) => [
      file, createHash("sha256").update(await readFile(join(plugin, file))).digest("hex"),
    ]),
  ));
  await writeFile(join(plugin, "release-manifest.json"), JSON.stringify({
    name: pkg.name, version: pkg.version, minimumOpenCode: "2.2.5", files,
  }, null, 2) + "\n");
  for (const [source, destination] of [
    ["README.md", "README.md"], ["docs/windows-smoke.md", "windows-smoke.md"],
    ["install/windows/install.cmd", "install.cmd"], ["install/windows/install.ps1", "install.ps1"],
  ]) {
    if (!source || !destination) throw new Error("Invalid release copy mapping");
    const text = (await readFile(join(root, source), "utf8"))
      .replaceAll("__RELEASE_VERSION__", pkg.version)
      .replaceAll("(docs/windows-smoke.md)", "(windows-smoke.md)");
    await writeFile(join(output, destination), /\.(cmd|ps1)$/.test(destination) ? text.replace(/\r?\n/g, "\r\n") : text);
  }
  await verifyRelease(output);
  console.log("Verified release folder: .tmp/release (Windows CI produces the transferable ZIP)");
}

if (import.meta.main) await build();
