import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(join(tmpdir(), "astraeum-starter-test-"));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const database = join(temporary, "studio", "data", "studio.sqlite");
const manifest = JSON.parse(await readFile(join(root, "starter-data", "astraeum", "manifest.json"), "utf8"));
const run = (...args) => spawnSync(process.execPath,
  [join(temporary, "tools", "restore-astraeum-starter.mjs"), ...args],
  { cwd: temporary, encoding: "utf8" });
const success = result => assert.equal(result.status, 0, result.stderr || result.stdout);
const failure = (result, message) => {
  assert.notEqual(result.status, 0, "Invalid restore unexpectedly succeeded.");
  assert.match(result.stderr, message);
};

try {
  await mkdir(join(temporary, "tools"), { recursive: true });
  await mkdir(join(temporary, "engine"), { recursive: true });
  for (const file of ["tools/restore-astraeum-starter.mjs", "engine/developer-kit.lock.json"]) {
    await cp(resolve(root, file), resolve(temporary, file));
  }
  await cp(join(root, "starter-data"), join(temporary, "starter-data"), { recursive: true });
  const lockPath = join(temporary, "engine", "developer-kit.lock.json");
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  const mismatchedLock = { ...lock, version: `${manifest.engine.kitVersion}-mismatch` };
  await writeFile(lockPath, JSON.stringify(mismatchedLock));
  failure(run(), /Starter data and selected kit versions differ/);
  for (const [field, value, message] of [
    ["archiveSha256", "incorrect-checksum", /Starter data and selected kit checksums differ/],
    ["engineRevision", "incorrect-revision", /Starter data and selected Engine revisions differ/]
  ]) {
    const compatible = {
      ...lock, version: manifest.engine.kitVersion,
      archiveSha256: manifest.engine.archiveSha256, engineRevision: manifest.engine.engineRevision
    };
    await writeFile(lockPath, JSON.stringify({ ...compatible, [field]: value }));
    failure(run(), message);
  }
  await writeFile(lockPath, JSON.stringify({
    ...lock, version: manifest.engine.kitVersion,
    archiveSha256: manifest.engine.archiveSha256, engineRevision: manifest.engine.engineRevision
  }));
  success(run());
  const installed = await readFile(database);
  assert.equal(sha256(installed), manifest.database.sha256);
  failure(run(), /would overwrite existing data/);
  assert.deepEqual(await readFile(database), installed);

  const prior = new DatabaseSync(database);
  prior.prepare("UPDATE maps SET updated_at=? WHERE project_id=? AND map_id=?")
    .run("2000-01-01T00:00:00.000Z", manifest.game.projectId, manifest.game.startingLevelId);
  prior.close();
  success(run("--replace-existing"));
  const backups = join(temporary, "studio", "data", "starter-restore-backups");
  const directories = await readdir(backups);
  assert.equal(directories.length, 1);
  const preserved = new DatabaseSync(join(backups, directories[0], "studio.sqlite"), { readOnly: true });
  try {
    assert.equal(preserved.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.equal(preserved.prepare("SELECT updated_at FROM maps WHERE project_id=? AND map_id=?")
      .get(manifest.game.projectId, manifest.game.startingLevelId).updated_at, "2000-01-01T00:00:00.000Z");
  } finally {
    preserved.close();
  }
  assert.equal(sha256(await readFile(database)), manifest.database.sha256);

  const payload = join(temporary, "starter-data", "astraeum", "studio.sqlite");
  const bytes = await readFile(payload);
  const corrupted = Buffer.from(bytes);
  corrupted[corrupted.length - 1] ^= 1;
  await writeFile(payload, corrupted);
  failure(run("--replace-existing"), /Starter SQLite checksum mismatch/);
  assert.equal(sha256(await readFile(database)), manifest.database.sha256);
  assert.equal((await readdir(backups)).length, 1);
  await writeFile(payload, bytes);

  await rm(database);
  await writeFile(`${database}-wal`, "unowned sidecar", { flag: "wx" });
  failure(run(), /would overwrite existing data/);
  assert.equal(await readFile(`${database}-wal`, "utf8"), "unowned sidecar");
  failure(run("--unknown"), /Usage:/);
  console.log("Starter data: checksums, fresh restore, overwrite refusal, explicit replacement backup and sidecar safety passed.");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
