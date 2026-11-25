import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, lstat, mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(join(tmpdir(), "studio-kit-upgrade-"));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "Run this test through npm.");
const oldArchive = "engine/artifacts/multiplayer-game-developer-kit-0.4.0-6cd1d52906da.zip";
const newArchive = "engine/artifacts/multiplayer-game-developer-kit-0.5.0-d0f46931f56b.zip";
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

function run(cwd, ...args) {
  return spawnSync(process.execPath, [npmCli, ...args], { cwd, encoding: "utf8", env: process.env });
}
function success(result) {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}
async function checkout(name) {
  const directory = join(temporary, name);
  execFileSync("git", ["clone", "--no-hardlinks", "--no-checkout", root, directory], { stdio: "pipe" });
  execFileSync("git", ["checkout", "--detach", head], { cwd: directory, stdio: "pipe" });
  await cp(join(root, "tools", "setup.mjs"), join(directory, "tools", "setup.mjs"));
  return directory;
}

try {
  const directory = await checkout("existing");
  const selectedFiles = ["engine/developer-kit.lock.json", "games/sample/package.json",
    "games/sample/package-lock.json"];
  const selected = await Promise.all(selectedFiles.map(file => readFile(join(directory, file))));
  success(run(directory, "run", "setup", "--", "--archive", oldArchive, "--upgrade"));
  const oldLink = await readlink(join(directory, "games", "sample", "node_modules"));
  assert.match(oldLink, /dependencies-0\.4\.0-6cd1d52906da/i);
  for (let index = 0; index < selectedFiles.length; index++) {
    await writeFile(join(directory, selectedFiles[index]), selected[index]);
  }
  const database = join(directory, "studio", "data", "studio.sqlite");
  await mkdir(dirname(database), { recursive: true });
  await cp(join(directory, "starter-data", "astraeum", "studio.sqlite"), database);
  const db = new DatabaseSync(database);
  db.prepare("UPDATE maps SET updated_at = ? WHERE project_id = ? AND map_id = ?")
    .run("2001-02-03T04:05:06.000Z", "astraeum-tower", "astraeum-tower-floor-1");
  const maps = db.prepare("SELECT * FROM maps ORDER BY project_id, map_id").all();
  assert.ok(maps.length >= 3);
  db.close();
  const saved = await readFile(database);

  const refused = run(directory, "run", "setup", "--", "--archive", newArchive);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Existing sample dependencies/);
  assert.equal(await readlink(join(directory, "games", "sample", "node_modules")), oldLink);
  success(run(directory, "run", "setup", "--", "--archive", newArchive, "--upgrade"));
  assert.match(await readlink(join(directory, "games", "sample", "node_modules")),
    /dependencies-0\.5\.0-d0f46931f56b/i);
  assert.deepEqual(await readFile(database), saved, "setup must not write the saved database");
  const after = new DatabaseSync(database, { readOnly: true });
  assert.deepEqual(after.prepare("SELECT * FROM maps ORDER BY project_id, map_id").all(), maps);
  after.close();
  assert.ok((await lstat(join(directory, "engine", "kits", "dependencies-0.4.0-6cd1d52906da")))
    .isDirectory(), "prior dependencies are retained");

  const modules = join(directory, "games", "sample", "node_modules");
  const unknown = join(directory, "unknown-modules");
  await mkdir(unknown);
  await writeFile(join(unknown, "sentinel"), "preserve");
  await rm(modules);
  await symlink(unknown, modules, process.platform === "win32" ? "junction" : "dir");
  const unsafe = run(directory, "run", "setup", "--", "--archive", newArchive, "--upgrade");
  assert.notEqual(unsafe.status, 0);
  assert.match(unsafe.stderr, /Existing sample dependencies/);
  assert.equal(await readlink(modules), unknown);
  assert.equal(await readFile(join(unknown, "sentinel"), "utf8"), "preserve");
  assert.deepEqual(await readFile(database), saved);

  const fresh = await checkout("fresh");
  success(run(fresh, "run", "bootstrap", "--", "--archive", newArchive));
  assert.deepEqual(await readFile(join(fresh, "studio", "data", "studio.sqlite")),
    await readFile(join(fresh, "starter-data", "astraeum", "studio.sqlite")));
  success(spawnSync(process.execPath, [join(fresh, "studio", "scripts", "starter-runtime-test.mjs")],
    { cwd: fresh, encoding: "utf8", env: process.env }));
  console.log("Kit upgrade and fresh bootstrap passed: saved rows/bytes and prior dependencies preserved; unsafe links refused.");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
