import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFile, lstat, mkdir, readFile, rename, rm, writeFile
} from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { assertStarterKitCompatibility } from "./starter-kit-compatibility.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageDirectory = resolve(root, "starter-data", "astraeum");
const projectId = "astraeum-tower";
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const exists = async path => {
  try { await lstat(path); return true; } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};
const within = (parent, path) => {
  const child = relative(parent, path);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`);
};
const sqlString = value => `'${value.replaceAll("'", "''")}'`;

function parseArgs(args) {
  let replaceExisting = false;
  for (const arg of args) {
    if (arg === "--replace-existing") replaceExisting = true;
    else throw new Error("Usage: npm run starter:restore [-- --replace-existing]");
  }
  return { replaceExisting };
}

function activeLevels(db) {
  return db.prepare(`SELECT m.map_id FROM maps m
    WHERE m.project_id = ? AND m.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM world_sections w
        WHERE w.project_id = m.project_id AND w.map_id = m.map_id)
      AND NOT EXISTS (SELECT 1 FROM level_sections s
        WHERE s.project_id = m.project_id AND s.map_id = m.map_id AND s.level_map_id != m.map_id)
      AND NOT EXISTS (SELECT 1 FROM level_section_archives a
        WHERE a.project_id = m.project_id AND a.map_id = m.map_id AND a.level_map_id != m.map_id)
    ORDER BY m.updated_at, m.map_id`).all(projectId).map(row => row.map_id);
}

function canonicalPackageHash(files) {
  const canonical = [...files].sort((a, b) => a.path.localeCompare(b.path))
    .map(file => `${file.path}\0${sha256(file.bytes)}\n`).join("");
  return sha256(canonical);
}

function validateDatabase(path, manifest) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok",
      "Starter SQLite integrity_check failed.");
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), [],
      "Starter SQLite has broken foreign-key references.");
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
      .map(row => row.name);
    const expected = [
      "projects", "maps", "map_backups", "migrations", "project_asset_imports",
      "project_assets", "worlds", "world_sections", "world_save_receipts",
      "level_section_sets", "level_sections", "level_section_archives",
      "level_section_save_receipts", "project_levels"
    ];
    assert.deepEqual([...tables].sort(), [...expected].sort(), "Starter SQLite schema is unexpected.");
    for (const table of tables) {
      const row = db.prepare(`SELECT count(*) AS count FROM ${table} WHERE project_id != ?`).get(projectId);
      assert.equal(row.count, 0, `Starter SQLite contains unrelated rows in ${table}.`);
    }
    const levels = activeLevels(db);
    assert.equal(levels.length, manifest.database.activeLevels, "Starter level count differs from the manifest.");
    const start = db.prepare("SELECT starting_map_id FROM project_levels WHERE project_id=?").get(projectId);
    assert.equal(start?.starting_map_id, manifest.game.startingLevelId, "Starter starting-level metadata differs.");
    const sections = db.prepare("SELECT count(*) AS count FROM level_sections WHERE project_id=?").get(projectId).count;
    const implicit = levels.filter(level => !db.prepare(
      "SELECT 1 FROM level_section_sets WHERE project_id=? AND level_map_id=?"
    ).get(projectId, level)).length;
    assert.equal(sections + implicit, manifest.database.activeSections,
      "Starter section count differs from the manifest.");
    assert.equal(db.prepare("SELECT count(*) AS count FROM projects WHERE project_id=?")
      .get(projectId).count, manifest.database.projectMetadataRows,
    "Starter project metadata count differs from the manifest.");
    assert.equal(db.prepare("SELECT count(*) AS count FROM project_asset_imports WHERE project_id=?")
      .get(projectId).count, manifest.database.assetImports, "Asset-import catalog count differs.");
    assert.equal(db.prepare("SELECT count(*) AS count FROM project_assets WHERE project_id=?")
      .get(projectId).count, manifest.database.catalogAssets, "Asset catalog count differs.");
    for (const table of ["map_backups", "migrations", "worlds", "world_sections",
      "world_save_receipts", "level_section_archives", "level_section_save_receipts"]) {
      assert.equal(db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count, 0,
        `Starter SQLite unexpectedly includes recovery or unrelated data in ${table}.`);
    }
  } finally {
    db.close();
  }
}

async function main() {
  const { replaceExisting } = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(await readFile(join(packageDirectory, "manifest.json"), "utf8"));
  const lock = JSON.parse(await readFile(resolve(root, "engine", "developer-kit.lock.json"), "utf8"));
  assert.equal(manifest.formatVersion, 1, "Unsupported Astraeum starter format.");
  assert.equal(manifest.game.projectId, projectId, "Starter package is not Astraeum data.");
  assertStarterKitCompatibility(manifest, lock);

  const databasePath = resolve(root, "studio", "data", "studio.sqlite");
  const databaseFile = join(packageDirectory, manifest.database.file);
  const databaseBytes = await readFile(databaseFile);
  assert.equal(sha256(databaseBytes), manifest.database.sha256, "Starter SQLite checksum mismatch.");
  const payloadFiles = [{ path: "studio.sqlite", bytes: databaseBytes }];
  const assets = [];
  for (const asset of manifest.assets) {
    assert.match(asset.importId, /^[A-Za-z0-9_-]+$/, "Unsafe starter import ID.");
    assert.match(asset.assetId, /^asset-[a-f0-9]{64}$/, "Unsafe starter asset ID.");
    const expectedPackagePath = `assets/${asset.importId}/${asset.assetId}.png`;
    assert.equal(asset.packagePath, expectedPackagePath, "Starter asset package path is invalid.");
    assert.equal(asset.projectPath, `games/${projectId}/${expectedPackagePath}`, "Starter asset destination is invalid.");
    const assetPath = resolve(packageDirectory, ...expectedPackagePath.split("/"));
    assert.ok(within(packageDirectory, assetPath), "Starter asset path escaped its package.");
    const stat = await lstat(assetPath);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), "Starter asset is not a regular file.");
    const bytes = await readFile(assetPath);
    assert.equal(sha256(bytes), asset.sha256, `Starter asset checksum mismatch: ${asset.assetId}`);
    payloadFiles.push({ path: expectedPackagePath, bytes });
    assets.push({ manifest: asset, bytes });
  }
  const digest = canonicalPackageHash(payloadFiles);
  assert.equal(digest, manifest.starterDataSha256, "Starter-data checksum mismatch.");
  assert.equal((await readFile(join(packageDirectory, "starter-data.sha256"), "utf8")).slice(0, 64),
    digest, "Starter-data checksum sidecar mismatch.");
  validateDatabase(databaseFile, manifest);

  const destinations = assets.map(({ manifest: asset }) =>
    resolve(root, ...asset.projectPath.split("/")));
  for (const destination of destinations) {
    assert.ok(within(root, destination), "Starter asset destination escaped the checkout.");
  }
  const databaseSidecars = [`${databasePath}-wal`, `${databasePath}-shm`];
  const conflicts = [];
  if (await exists(databasePath)) conflicts.push(databasePath);
  for (const sidecar of databaseSidecars) if (await exists(sidecar)) conflicts.push(sidecar);
  for (const destination of destinations) if (await exists(destination)) conflicts.push(destination);
  if (conflicts.length && !replaceExisting) {
    throw new Error(`Starter restore would overwrite existing data. Stop Studio, back it up, review ${conflicts.length} conflict(s), then explicitly run with --replace-existing.`);
  }

  let backupDirectory;
  const priorAssetDestinations = new Set();
  if (conflicts.length) {
    const stamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "-");
    backupDirectory = resolve(root, "studio", "data", "starter-restore-backups", `${stamp}-${randomUUID().slice(0, 8)}`);
    await mkdir(backupDirectory, { recursive: true });
    if (await exists(databasePath)) {
      const backupDbPath = join(backupDirectory, "studio.sqlite");
      const live = new DatabaseSync(databasePath, { readOnly: true });
      try {
        live.exec(`VACUUM INTO ${sqlString(backupDbPath)}`);
      } finally {
        live.close();
      }
      const backup = new DatabaseSync(backupDbPath, { readOnly: true });
      try {
        assert.equal(backup.prepare("PRAGMA integrity_check").get().integrity_check, "ok",
          "Pre-restore SQLite backup failed integrity_check.");
      } finally {
        backup.close();
      }
    }
    for (const destination of destinations) {
      if (!await exists(destination)) continue;
      priorAssetDestinations.add(destination);
      const relativeDestination = relative(root, destination);
      const copyPath = resolve(backupDirectory, ...relativeDestination.split(sep));
      await mkdir(dirname(copyPath), { recursive: true });
      await copyFile(destination, copyPath);
    }
    for (const sidecar of databaseSidecars) {
      if (await exists(sidecar)) await copyFile(sidecar, join(backupDirectory, sidecar.endsWith("-wal") ? "studio.sqlite-wal" : "studio.sqlite-shm"));
    }
    if (await exists(databasePath)) await copyFile(databasePath, join(backupDirectory, "studio.sqlite.original"));
  }

  await mkdir(dirname(databasePath), { recursive: true });
  const stagedDatabase = `${databasePath}.restore-${randomUUID()}`;
  const stagedAssets = [];
  const installedAssets = [];
  try {
    await writeFile(stagedDatabase, databaseBytes, { flag: "wx" });
    for (const [index, asset] of assets.entries()) {
      const destination = destinations[index];
      await mkdir(dirname(destination), { recursive: true });
      const stagedPath = `${destination}.restore-${randomUUID()}`;
      await writeFile(stagedPath, asset.bytes, { flag: "wx" });
      stagedAssets.push({ destination, stagedPath });
    }
    if (backupDirectory && await exists(databasePath)) {
      await rename(databasePath, join(backupDirectory, "studio.sqlite.previous"));
    }
    for (const sidecar of databaseSidecars) {
      if (backupDirectory && await exists(sidecar)) {
        await rename(sidecar, join(backupDirectory, sidecar.endsWith("-wal") ? "studio.sqlite-wal.previous" : "studio.sqlite-shm.previous"));
      } else if (await exists(sidecar)) {
        throw new Error(`Refusing to leave an SQLite sidecar beside the restored database: ${sidecar}`);
      }
    }
    await rename(stagedDatabase, databasePath);
    for (const asset of stagedAssets) {
      if (backupDirectory && await exists(asset.destination)) {
        await rm(asset.destination);
      }
      await rename(asset.stagedPath, asset.destination);
      installedAssets.push(asset.destination);
    }
    validateDatabase(databasePath, manifest);
    for (let index = 0; index < assets.length; index++) {
      assert.equal(await readFile(destinations[index]).then(sha256), assets[index].manifest.sha256,
        `Restored asset checksum mismatch: ${assets[index].manifest.assetId}`);
    }
  } catch (error) {
    await rm(stagedDatabase, { force: true });
    for (const asset of stagedAssets) await rm(asset.stagedPath, { force: true });
    if (backupDirectory) {
      for (const destination of installedAssets) {
        if (priorAssetDestinations.has(destination)) {
          const relativeDestination = relative(root, destination);
          const backupAsset = resolve(backupDirectory, ...relativeDestination.split(sep));
          if (await exists(backupAsset)) await copyFile(backupAsset, destination);
        } else {
          await rm(destination, { force: true });
        }
      }
      for (const [sourceName, targetName] of [
        ["studio.sqlite.previous", databasePath],
        ["studio.sqlite-wal.previous", `${databasePath}-wal`],
        ["studio.sqlite-shm.previous", `${databasePath}-shm`]
      ]) {
        const previous = join(backupDirectory, sourceName);
        if (await exists(previous)) {
          await rm(targetName, { force: true });
          await rename(previous, targetName);
        }
      }
    }
    throw error;
  }

  console.log(`Restored Astraeum (${manifest.database.activeLevels} active levels, ${manifest.database.activeSections} sections, ${manifest.database.catalogAssets} imported assets).`);
  console.log(`Starter-data SHA-256: ${digest}`);
  if (backupDirectory) console.log(`Existing data was backed up to ${backupDirectory}.`);
  else console.log("No existing database or imported asset bytes were overwritten.");
}

await main();
