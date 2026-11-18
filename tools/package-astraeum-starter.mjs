import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile
} from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectId = "astraeum-tower";
const model = "astraeum-floor-v2";
const defaultSource = resolve(root, "studio", "data", "studio.sqlite");
const defaultOutput = resolve(root, "starter-data", "astraeum");
const allowedTables = new Set([
  "projects", "maps", "map_backups", "migrations", "project_asset_imports",
  "project_assets", "worlds", "world_sections", "world_save_receipts",
  "level_section_sets", "level_sections", "level_section_archives",
  "level_section_save_receipts", "project_levels"
]);
const sha256 = value => createHash("sha256").update(value).digest("hex");
const exists = async path => {
  try { await lstat(path); return true; } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};
const within = (parent, path) => {
  const child = relative(parent, path);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
};
const sqlString = value => `'${value.replaceAll("'", "''")}'`;
const fileHash = async path => sha256(await readFile(path));

function parseArgs(args) {
  let source = defaultSource;
  let output = defaultOutput;
  let replace = false;
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (option === "--source" && args[index + 1]) source = resolve(root, args[++index]);
    else if (option === "--output" && args[index + 1]) output = resolve(root, args[++index]);
    else if (option === "--replace") replace = true;
    else throw new Error("Usage: npm run starter:package -- [--source <sqlite>] [--output <directory>] [--replace]");
  }
  assert.ok(within(root, output), "Starter package output must be inside this repository.");
  assert.notEqual(resolve(source), resolve(output), "Source database and output directory must differ.");
  return { source, output, replace };
}

function currentLevelRoots(db) {
  return db.prepare(`SELECT m.map_id, m.model, m.document_json, m.updated_at
    FROM maps m
    WHERE m.project_id = ? AND m.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM world_sections w
        WHERE w.project_id = m.project_id AND w.map_id = m.map_id)
      AND NOT EXISTS (SELECT 1 FROM level_sections s
        WHERE s.project_id = m.project_id AND s.map_id = m.map_id AND s.level_map_id != m.map_id)
      AND NOT EXISTS (SELECT 1 FROM level_section_archives a
        WHERE a.project_id = m.project_id AND a.map_id = m.map_id AND a.level_map_id != m.map_id)
    ORDER BY m.updated_at, m.map_id`).all(projectId);
}

function payloadHash(files) {
  const entries = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const canonical = entries.map(file => `${file.path}\0${sha256(file.bytes)}\n`).join("");
  return sha256(canonical);
}

async function main() {
  const { source, output, replace } = parseArgs(process.argv.slice(2));
  assert.ok(await exists(source), `Source SQLite database not found: ${source}`);
  assert.ok(within(root, source), "Source database must be inside this repository.");
  if (await exists(output) && !replace) {
    throw new Error(`Starter package already exists at ${output}; review it and pass --replace to preserve/replace it.`);
  }

  const lock = JSON.parse(await readFile(resolve(root, "engine", "developer-kit.lock.json"), "utf8"));
  const kitPath = resolve(root, "engine", "artifacts",
    `multiplayer-game-developer-kit-${lock.version}-${lock.engineRevision.slice(0, 12)}.zip`);
  assert.equal(await fileHash(kitPath), lock.archiveSha256, "The downloadable Engine artifact does not match the selected kit lock.");
  await mkdir(dirname(output), { recursive: true });
  const tables = new Set();
  const stage = await mkdtemp(join(dirname(output), ".astraeum-starter-build-"));
  const stagedPackage = join(stage, "package");
  const rawDatabase = join(stage, "source.sqlite");
  const starterDatabase = join(stagedPackage, "studio.sqlite");
  let sourceDb;
  let db;
  try {
    await mkdir(join(stagedPackage, "assets"), { recursive: true });

    sourceDb = new DatabaseSync(source, { readOnly: true });
    const sourceIntegrity = sourceDb.prepare("PRAGMA integrity_check").get().integrity_check;
    assert.equal(sourceIntegrity, "ok", "Source database failed SQLite integrity_check.");
    sourceDb.exec(`VACUUM INTO ${sqlString(rawDatabase)}`);
    sourceDb.close();
    sourceDb = undefined;

    await rename(rawDatabase, starterDatabase);
    db = new DatabaseSync(starterDatabase);
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA secure_delete = ON");
    for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
      tables.add(row.name);
    }
    for (const table of tables) assert.ok(allowedTables.has(table), `Refusing to package unexpected database table "${table}".`);
    for (const table of allowedTables) assert.ok(tables.has(table), `Database is missing expected table "${table}".`);

    const roots = currentLevelRoots(db);
    assert.ok(roots.length > 0, "No active Astraeum levels were found.");
    assert.ok(roots.every(level => level.model === model), "Astraeum starter contains an incompatible level model.");
    const startingMapId = db.prepare("SELECT starting_map_id FROM project_levels WHERE project_id = ?")
      .get(projectId)?.starting_map_id;
    assert.ok(roots.some(level => level.map_id === startingMapId), "The saved starting level is missing or deleted.");

    const rootIds = new Set(roots.map(level => level.map_id));
    const mapIds = new Set(rootIds);
    const sectionRows = [];
    for (const level of roots) {
      const activeSections = db.prepare(`SELECT section_id, map_id, grid_x, grid_y, revision
        FROM level_sections WHERE project_id = ? AND level_map_id = ? ORDER BY grid_y, grid_x`)
        .all(projectId, level.map_id);
      const archives = db.prepare("SELECT count(*) AS count FROM level_section_archives WHERE project_id=? AND level_map_id=?")
        .get(projectId, level.map_id).count;
      if (!activeSections.length && !archives) {
        sectionRows.push({
          project_id: projectId, level_map_id: level.map_id,
          section_id: `section-${level.map_id}`, map_id: level.map_id,
          grid_x: 0, grid_y: 0, revision: 0, implicit: true
        });
      } else {
        assert.ok(activeSections.length > 0, `Level ${level.map_id} has no active sections.`);
        for (const section of activeSections) {
          const sectionMap = db.prepare(`SELECT model, deleted_at FROM maps WHERE project_id=? AND map_id=?`)
            .get(projectId, section.map_id);
          assert.ok(sectionMap && !sectionMap.deleted_at && sectionMap.model === model,
            `Section ${section.section_id} is missing, deleted, or incompatible.`);
          mapIds.add(section.map_id);
          sectionRows.push({ project_id: projectId, level_map_id: level.map_id, ...section });
        }
      }
    }

    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("DELETE FROM world_save_receipts; DELETE FROM world_sections; DELETE FROM worlds;");
      db.exec("DELETE FROM level_section_save_receipts; DELETE FROM level_section_archives;");
      db.exec("DELETE FROM migrations; DELETE FROM map_backups;");
      db.prepare("DELETE FROM project_assets WHERE project_id != ?").run(projectId);
      db.prepare("DELETE FROM project_asset_imports WHERE project_id != ?").run(projectId);
      db.prepare("DELETE FROM level_sections WHERE project_id != ?").run(projectId);
      db.prepare("DELETE FROM level_sections WHERE project_id = ? AND level_map_id NOT IN (" +
        [...rootIds].map(() => "?").join(",") + ")").run(projectId, ...rootIds);
      db.prepare("DELETE FROM level_section_sets WHERE project_id != ? OR level_map_id NOT IN (" +
        [...rootIds].map(() => "?").join(",") + ")").run(projectId, ...rootIds);
      db.prepare("DELETE FROM project_levels WHERE project_id != ?").run(projectId);
      db.prepare("DELETE FROM maps WHERE project_id != ? OR map_id NOT IN (" +
        [...mapIds].map(() => "?").join(",") + ")").run(projectId, ...mapIds);
      db.prepare("DELETE FROM projects WHERE project_id != ?").run(projectId);
      if (tables.has("sqlite_sequence")) db.exec("DELETE FROM sqlite_sequence");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    db.exec("VACUUM");
    db.exec("PRAGMA journal_mode = DELETE");
    const integrity = db.prepare("PRAGMA integrity_check").get().integrity_check;
    assert.equal(integrity, "ok", "Filtered starter database failed SQLite integrity_check.");
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), [], "Filtered starter database has broken foreign keys.");

    const assetRows = db.prepare(`SELECT a.asset_id, a.import_id, a.sha256, i.created_at
      FROM project_assets a JOIN project_asset_imports i USING (project_id, import_id)
      WHERE a.project_id = ? ORDER BY a.import_id, a.asset_id`).all(projectId);
    const importedAssets = [];
    const payloadFiles = [];
    db.close();
    db = undefined;
    await rm(`${starterDatabase}-wal`, { force: true });
    await rm(`${starterDatabase}-shm`, { force: true });

    const dbBytes = await readFile(starterDatabase);
    payloadFiles.push({ path: "studio.sqlite", bytes: dbBytes });
    for (const asset of assetRows) {
      assert.match(asset.import_id, /^[A-Za-z0-9_-]+$/, "Unsafe project asset import ID.");
      assert.match(asset.asset_id, /^asset-[a-f0-9]{64}$/, "Unsafe project asset ID.");
      const relativeAssetPath = `assets/${asset.import_id}/${asset.asset_id}.png`;
      const sourceAsset = resolve(root, "games", projectId, relativeAssetPath);
      assert.ok(within(resolve(root, "games", projectId, "assets"), sourceAsset), "Asset path escaped the project.");
      const stat = await lstat(sourceAsset);
      assert.ok(stat.isFile() && !stat.isSymbolicLink(), `Imported artwork is not a regular file: ${relativeAssetPath}`);
      const bytes = await readFile(sourceAsset);
      assert.equal(sha256(bytes), asset.sha256, `Imported artwork checksum mismatch: ${relativeAssetPath}`);
      const packagePath = join(stagedPackage, ...relativeAssetPath.split("/"));
      await mkdir(dirname(packagePath), { recursive: true });
      await copyFile(sourceAsset, packagePath);
      payloadFiles.push({ path: relativeAssetPath, bytes });
      importedAssets.push({
        assetId: asset.asset_id, importId: asset.import_id,
        packagePath: relativeAssetPath,
        projectPath: `games/${projectId}/${relativeAssetPath}`,
        sha256: asset.sha256
      });
    }

    const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const sourceBranch = execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim();
    const hasWorkingChanges = Boolean(execFileSync("git", ["status", "--porcelain"], {
      cwd: root, encoding: "utf8"
    }).trim());
    const packageDigest = payloadHash(payloadFiles);
    const count = (table, where = "") => dbCount(starterDatabase, table, where);
    const activeSections = sectionRows.length;
    const manifest = {
      formatVersion: 1,
      game: { projectId, model, startingLevelId: startingMapId },
      source: {
        repository: "scottzastrow/multiplayer-game-studio",
        commit: sourceCommit,
        branch: sourceBranch,
        workingTreeChangesPresent: hasWorkingChanges
      },
      engine: {
        kitVersion: lock.version,
        archiveSha256: lock.archiveSha256,
        engineRevision: lock.engineRevision
      },
      database: {
        file: "studio.sqlite",
        sha256: sha256(dbBytes),
        activeLevels: roots.length,
        activeSections,
        sectionDocuments: mapIds.size,
        projectMetadataRows: await count("projects"),
        assetImports: await count("project_asset_imports"),
        catalogAssets: importedAssets.length,
        excluded: ["other projects", "soft-deleted levels", "removed-section archives",
          "migration backups", "migration diagnostics", "world workspace records", "save receipts"]
      },
      assets: importedAssets,
      starterDataSha256: packageDigest,
      createdAt: new Date().toISOString()
    };
    await writeFile(join(stagedPackage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(join(stagedPackage, "starter-data.sha256"),
      `${packageDigest}  studio.sqlite + assets (canonical manifest payload)\n`);

    const backupPath = `${output}.backup-${new Date().toISOString().replaceAll(":", "").replaceAll(".", "-")}-${randomUUID().slice(0, 8)}`;
    if (await exists(output)) await rename(output, backupPath);
    try {
      await mkdir(dirname(output), { recursive: true });
      await rename(stagedPackage, output);
    } catch (error) {
      if (await exists(backupPath)) await rename(backupPath, output);
      throw error;
    }
    console.log(`Packaged ${roots.length} active levels, ${activeSections} sections, and ${importedAssets.length} imported assets.`);
    console.log(`Starter-data SHA-256: ${packageDigest}`);
    console.log(`SQLite SHA-256: ${manifest.database.sha256}`);
    if (await exists(backupPath)) console.log(`Previous package preserved at ${backupPath}.`);
  } finally {
    sourceDb?.close();
    db?.close();
    await rm(stage, { recursive: true, force: true });
  }
}

function dbCount(path, table) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare(`SELECT count(*) AS count FROM ${table} WHERE project_id = ?`).get(projectId).count; }
  finally { db.close(); }
}

await main();
