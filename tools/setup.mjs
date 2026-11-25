import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access, cp, lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, symlink, writeFile
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8" }).trim();
assert.equal(resolve(top).toLowerCase(), root.toLowerCase(), "Run setup in the existing Studio Git root.");
const args = process.argv.slice(2);
const upgrade = args.at(-1) === "--upgrade";
const options = upgrade ? args.slice(0, -1) : args;
assert.ok(options.length === 2 && options[0] === "--archive" &&
  !args.slice(0, -1).includes("--upgrade"),
  "Usage: npm run setup -- --archive <kit.zip> (with adjacent .sha256) [--upgrade]");
const archive = resolve(options[1]);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const archiveHash = hash(await readFile(archive));
const checksum = await readFile(`${archive}.sha256`, "utf8");
assert.match(checksum, /^[a-f0-9]{64}  [^\r\n]+\r?\n?$/);
assert.equal(archiveHash, checksum.slice(0, 64), "ZIP checksum mismatch.");
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "Run setup through npm.");
async function exists(path) {
  try { await access(path); return true; } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
async function verifiedPriorKitModules(currentModules, local, reusedTooling) {
  const runtime = dirname(currentModules);
  const name = relative(local, runtime);
  const match = /^dependencies-(\d+\.\d+\.\d+)-([a-f0-9]{12})$/.exec(name);
  if (!match || match[1] !== reusedTooling?.kitVersion ||
      currentModules.toLowerCase() !== join(runtime, "node_modules").toLowerCase()) return false;
  try {
    const runtimeStat = await lstat(runtime);
    if (!runtimeStat.isDirectory() || runtimeStat.isSymbolicLink()) return false;
    const modulesStat = await lstat(currentModules);
    if (!modulesStat.isDirectory() || modulesStat.isSymbolicLink()) return false;
    const priorKit = join(local, `${match[1]}-${match[2]}`);
    const priorStat = await lstat(priorKit);
    if (!priorStat.isDirectory() || priorStat.isSymbolicLink()) return false;
    const manifestBytes = await readFile(join(priorKit, "kit.json"));
    const inventory = await readFile(join(priorKit, "SHA256SUMS"));
    if (hash(manifestBytes) !== reusedTooling.kitManifestSha256 ||
        hash(inventory) !== reusedTooling.inventorySha256) return false;
    const prior = JSON.parse(manifestBytes);
    if (prior.name !== "multiplayer-game-developer-kit" || prior.version !== match[1] ||
        typeof prior.engineRevision !== "string" || !/^[a-f0-9]{40}$/.test(prior.engineRevision) ||
        prior.engineRevision.slice(0, 12) !== match[2] || !Array.isArray(prior.packages)) return false;
    const runtimeManifest = JSON.parse(await readFile(join(runtime, "package.json"), "utf8"));
    return prior.packages.every(dependency =>
      runtimeManifest.dependencies?.[dependency.name] ===
        `file:../${match[1]}-${match[2]}/${dependency.file}`);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
const local = join(root, "engine", "kits");
await mkdir(local, { recursive: true });
assert.equal(execFileSync("git", ["check-ignore", "engine/kits/probe"], {
  cwd: root, encoding: "utf8"
}).trim(), "engine/kits/probe", "Local dependency directory must be ignored.");
const temporary = await mkdtemp(join(local, ".setup-"));
try {
  if (process.platform === "win32") {
    const quote = value => `'${value.replaceAll("'", "''")}'`;
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(temporary)} -ErrorAction Stop`],
      { stdio: "inherit" });
  } else {
    execFileSync("unzip", ["-q", archive, "-d", temporary], { stdio: "inherit" });
  }
  execFileSync(process.execPath, [join(temporary, "tools", "checksums.mjs")], { stdio: "inherit" });
  const kit = JSON.parse(await readFile(join(temporary, "kit.json"), "utf8"));
  assert.equal(kit.name, "multiplayer-game-developer-kit");
  assert.match(kit.version, /^\d+\.\d+\.\d+$/);
  assert.match(kit.engineRevision, /^[a-f0-9]{40}$/);
  const directory = `${kit.version}-${kit.engineRevision.slice(0, 12)}`;
  const installed = join(local, directory);
  const runtime = join(local, `dependencies-${directory}`);
  const receiptPath = join(root, "engine", "developer-kit.lock.json");
  const receipt = {
    version: kit.version, archiveSha256: archiveHash, engineRevision: kit.engineRevision,
    engineSourceState: kit.engineSource.state, packages: kit.packages,
    localDirectory: relative(root, installed).split(sep).join("/"),
    dependencyDirectory: relative(root, runtime).split(sep).join("/"),
    companion: kit.companion, reusedTooling: kit.reusedTooling
  };
  const previousReceipt = await exists(receiptPath)
    ? JSON.parse(await readFile(receiptPath, "utf8"))
    : undefined;
  const selectionChanged = previousReceipt && JSON.stringify(previousReceipt) !== JSON.stringify(receipt);
  assert.ok(!selectionChanged || upgrade,
    "A different kit is selected. Review it and pass --upgrade to change dependencies.");
  const starter = join(root, "games", "sample");
  const modules = join(starter, "node_modules");
  const targetModules = join(runtime, "node_modules");
  let modulesPresent = false;
  let switchFrom;
  let modulesStat;
  try {
    modulesStat = await lstat(modules);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (modulesStat) {
    modulesPresent = true;
    assert.ok(modulesStat.isSymbolicLink(),
      "Refusing to replace a non-junction sample node_modules directory.");
    const currentModules = resolve(dirname(modules), await readlink(modules));
    if (currentModules.toLowerCase() !== targetModules.toLowerCase()) {
      const previousModules = previousReceipt
        ? resolve(root, previousReceipt.dependencyDirectory, "node_modules")
        : undefined;
      const selectedPrevious = previousModules &&
        currentModules.toLowerCase() === previousModules.toLowerCase();
      const verifiedPrior = upgrade && !selectedPrevious &&
        await verifiedPriorKitModules(currentModules, local, kit.reusedTooling);
      assert.ok(upgrade && (selectedPrevious || verifiedPrior),
      "Existing sample dependencies are not the selected kit's junction; preserve and review them.");
      switchFrom = modules;
    }
  }
  if (await exists(installed)) {
    assert.equal(hash(await readFile(join(installed, "SHA256SUMS"))),
      hash(await readFile(join(temporary, "SHA256SUMS"))), "Installed kit differs.");
    execFileSync(process.execPath, [join(installed, "tools", "checksums.mjs")], { stdio: "inherit" });
  } else {
    await rename(temporary, installed);
  }
  if (!(await exists(starter))) {
    await cp(join(installed, "sample"), starter, { recursive: true, errorOnExist: true, force: false });
  }
  const manifestPath = join(starter, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.ok(manifest.dependencies && typeof manifest.dependencies === "object",
    "Editable sample package.json must declare dependencies.");
  for (const dependency of kit.packages) {
    manifest.dependencies[dependency.name] = `file:../../engine/kits/${directory}/${dependency.file}`;
  }
  const lockTemporary = await mkdtemp(join(starter, ".kit-lock-"));
  try {
    const lockManifest = structuredClone(manifest);
    for (const dependency of kit.packages) {
      lockManifest.dependencies[dependency.name] =
        `file:../../../engine/kits/${directory}/${dependency.file}`;
    }
    await writeFile(join(lockTemporary, "package.json"), `${JSON.stringify(lockManifest, null, 2)}\n`);
    const lockPath = join(starter, "package-lock.json");
    if (await exists(lockPath)) {
      await writeFile(join(lockTemporary, "package-lock.json"), await readFile(lockPath));
    }
    execFileSync(process.execPath, [npmCli, "install", "--package-lock-only", "--ignore-scripts",
      "--no-audit", "--no-fund"], { cwd: lockTemporary, stdio: "inherit" });
    const lock = (await readFile(join(lockTemporary, "package-lock.json"), "utf8"))
      .replaceAll("file:../../../engine/kits/", "file:../../engine/kits/");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(lockPath, lock);
  } finally {
    await rm(lockTemporary, { recursive: true, force: true });
  }
  await mkdir(runtime, { recursive: true });
  for (const file of ["package.json", "package-lock.json"]) {
    const source = await readFile(join(starter, file), "utf8");
    const rebased = source.replaceAll(`../../engine/kits/${directory}/`, `../${directory}/`);
    await writeFile(join(runtime, file), rebased);
  }
  execFileSync(process.execPath, [npmCli, "ci", "--no-audit", "--no-fund"],
    { cwd: runtime, stdio: "inherit" });
  if (switchFrom) await rm(switchFrom);
  if (!modulesPresent || switchFrom) await symlink(targetModules, modules, process.platform === "win32" ? "junction" : "dir");
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`Installed kit ${kit.version}; editable sample preserved at ${starter}.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
