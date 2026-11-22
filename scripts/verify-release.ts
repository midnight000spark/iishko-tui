import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { builtinModules } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const payload = ["package.json", "tui.js", "THIRD-PARTY-NOTICES.txt"];
export const releaseFiles = [
  "README.md", "windows-smoke.md", "install.cmd", "install.ps1",
  ...[...payload, "release-manifest.json"].map((file) => `iishko-tui/${file}`),
].sort();

export async function inventory(directory: string, prefix = ""): Promise<string[]> {
  const directoryStat = await lstat(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) throw new Error("Release directory must be a plain directory");
  const files: string[] = [];
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error("Release must not contain symlinks");
    if (stat.isDirectory()) {
      const nested = await inventory(path, `${prefix}${name}/`);
      if (!nested.length) throw new Error("Unexpected empty release directory");
      files.push(...nested);
    }
    else if (stat.isFile()) files.push(`${prefix}${name}`);
    else throw new Error("Release contains a non-regular file");
  }
  return files.sort();
}

export async function verifyRelease(directory: string): Promise<void> {
  if (JSON.stringify(await inventory(directory)) !== JSON.stringify(releaseFiles)) throw new Error("Unexpected release contents");
  const plugin = join(directory, "iishko-tui");
  const manifest = JSON.parse(await readFile(join(plugin, "release-manifest.json"), "utf8")) as {
    name: string; version: string; minimumOpenCode: string; files: Record<string, string>;
  };
  if (manifest.name !== "iishko-tui" || !/^\d+\.\d+\.\d+$/.test(manifest.version) || manifest.minimumOpenCode !== "2.2.5") {
    throw new Error("Invalid release manifest identity");
  }
  if (JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify([...payload].sort())) throw new Error("Invalid checksum allowlist");
  for (const file of payload) {
    const hash = createHash("sha256").update(await readFile(join(plugin, file))).digest("hex");
    if (hash !== manifest.files[file]) throw new Error(`Release checksum mismatch: ${file}`);
  }
  const pkg = JSON.parse(await readFile(join(plugin, "package.json"), "utf8"));
  if (JSON.stringify(pkg) !== JSON.stringify({
    name: "iishko-tui", version: manifest.version, private: true, type: "module", exports: { "./tui": "./tui.js" },
  })) throw new Error("Release package must contain only the TUI entrypoint and identity");
  const bundle = await readFile(join(plugin, "tui.js"), "utf8");
  if (/sourceMappingURL|\/home\/|\/Users\/|[A-Za-z]:\\\\Users\\\\|IISHKO_SECRET_SENTINEL_DO_NOT_SHIP/.test(bundle)) throw new Error("Bundle contains source paths, maps or build secret sentinel");
  const imports = new Bun.Transpiler({ loader: "js", target: "bun" }).scan(bundle).imports;
  for (const item of imports) {
    if (item.path === "@opencode/plugin/tui" || /^(solid-js|@opentui\/[^/]+)(\/.*)?$/.test(item.path)) continue;
    if (builtinModules.includes(item.path) || (item.path.startsWith("node:") && builtinModules.includes(item.path.slice(5))) || item.path === "bun") continue;
    throw new Error(`Unbundled dependency in release: ${item.path}`);
  }
  for (const file of ["README.md", "windows-smoke.md", "install.cmd", "install.ps1"]) {
    if (!(await readFile(join(directory, file), "utf8")).trim()) throw new Error(`Missing release instructions: ${file}`);
  }
  const installer = await readFile(join(directory, "install.ps1"), "utf8");
  if (!installer.includes(`$ExpectedVersion = '${manifest.version}'`)) throw new Error("Installer version differs from payload");
}

if (import.meta.main) {
  await verifyRelease(fileURLToPath(new URL("../.tmp/release/", import.meta.url)));
  console.log("Release contents, entrypoint, external imports and SHA-256 checks verified.");
}
