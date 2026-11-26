import { createServer } from "node:http";
import { register } from "node:module";
import { mkdirSync, writeFileSync, readFileSync, rmSync, renameSync, lstatSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  DESIGN_FORMAT_VERSION,
  createBlankDocument,
  createEmptyLevelDocument,
  migrateFloorDocumentV1,
  validateFloorDocument
} from "../games/astraeum-tower/src/project.js";
import { ASSET_CATALOG } from "../games/astraeum-tower/src/catalog.js";
import { ASTRAEUM_PROJECT_ID, ASTRAEUM_FLOOR_1_MAP_ID, ASTRAEUM_MODEL, isProjectMapId } from "./project-identity.js";
import * as generic from "../games/generic-grid-v1/src/project.js";
import { parseAssetUpload, sha256, validateImportFields } from "./asset-import.js";
import { importedAssetDefinition } from "./project-assets.js";
import { sectionOrigin } from "./world-coordinates.js";
import { validatePlayableBoundaryForSections } from "./playable-boundaries.js";
import {
  ASTRAEUM_ARTWORK_PROVENANCE,
  ASTRAEUM_PACKAGE_VERSION,
  ASTRAEUM_PROJECT_CREDIT,
  createAstraeumCampaign,
  createAstraeumPackageTheme,
  orderAstraeumCampaignLevels
} from "../games/astraeum-tower/src/package-adapter.js";

register("./scripts/public-runtime-loader.mjs", import.meta.url);
const { buildGamePackage, packageAssetProvenance } = await import("./extensions/game-package.mjs");
const { GamePackageManifestSchema } = await import("@multiplayer-game/theme-sdk/package");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataDirectory = resolve(root, "studio", "data");
const databasePath = resolve(root, process.env.STUDIO_DATABASE_PATH ?? "studio/data/studio.sqlite");
const relativeDatabase = relative(dataDirectory, databasePath);
const gamesDirectory = process.env.STUDIO_GAMES_PATH
  ? resolve(root, process.env.STUDIO_GAMES_PATH) : resolve(root, "games");
if (process.env.STUDIO_GAMES_PATH) {
  const path = relative(dataDirectory, gamesDirectory);
  if (!path || isAbsolute(path) || path === ".." || path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("Disposable STUDIO_GAMES_PATH must be a subdirectory of studio/data/.");
  }
}
if (isAbsolute(relativeDatabase) || relativeDatabase === ".." ||
    relativeDatabase.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
  throw new Error("STUDIO_DATABASE_PATH must stay inside studio/data/.");
}
const port = Number(process.env.STUDIO_API_PORT ?? 4179);
const MAX_LEVEL_SECTIONS = 16;
const MAX_ARCHIVED_LEVEL_SECTIONS = 16;
const MAX_LEVEL_SECTION_SAVE_BYTES = 64_100_000;
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError("STUDIO_API_PORT is invalid.");

mkdirSync(dataDirectory, { recursive: true });
const database = new DatabaseSync(databasePath);
database.exec(`
  PRAGMA journal_mode = WAL;
`);

function initializeStorage() {
  database.exec("BEGIN IMMEDIATE");
  try {
    const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
      .map(row => row.name));
    if (!tables.has("maps") && (tables.has("map_backups") || tables.has("migrations"))) {
      throw new Error("Cannot determine the identity of orphaned legacy storage tables.");
    }
    const columns = tables.has("maps")
      ? database.prepare("PRAGMA table_info(maps)").all().map(row => row.name) : [];
    const legacy = columns.includes("id") && !columns.includes("project_id");
    if (tables.has("maps") && !legacy && !(columns.includes("project_id") && columns.includes("map_id"))) {
      throw new Error("Unrecognized maps schema; database was not changed.");
    }
    if (legacy) {
      for (const [table, column] of [["maps", "id"], ["map_backups", "map_id"], ["migrations", "map_id"]]) {
        if (tables.has(table) && database.prepare(`SELECT 1 FROM ${table} WHERE ${column} != ? OR ${column} IS NULL LIMIT 1`)
          .get(ASTRAEUM_FLOOR_1_MAP_ID)) {
          throw new Error(`Cannot assign unknown legacy ${table} records to a project; database was not changed.`);
        }
      }
      for (const table of ["maps", "map_backups", "migrations"]) {
        if (tables.has(table)) database.exec(`ALTER TABLE ${table} RENAME TO legacy_${table}`);
      }
    }
    database.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        project_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        name_key TEXT NOT NULL UNIQUE,
        author TEXT NOT NULL,
        model TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS maps (
        project_id TEXT NOT NULL,
        map_id TEXT NOT NULL,
        document_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        model TEXT,
        PRIMARY KEY (project_id, map_id)
      );
      CREATE TABLE IF NOT EXISTS map_backups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        map_id TEXT NOT NULL,
        format_version INTEGER,
        document_json TEXT NOT NULL,
        original_updated_at TEXT,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        map_id TEXT NOT NULL,
        from_version INTEGER,
        to_version INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('migrated', 'failed')),
        backup_id INTEGER REFERENCES map_backups(id),
        report_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_asset_imports (
        project_id TEXT NOT NULL,
        import_id TEXT NOT NULL,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        author TEXT NOT NULL,
        source TEXT NOT NULL,
        source_filename TEXT NOT NULL,
        source_metadata BLOB NOT NULL,
        metadata_sha256 TEXT NOT NULL,
        archive_sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (project_id, import_id)
      );
      CREATE TABLE IF NOT EXISTS project_assets (
        project_id TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        import_id TEXT NOT NULL,
        source_path TEXT NOT NULL,
        direction TEXT,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        PRIMARY KEY (project_id, asset_id),
        UNIQUE (project_id, sha256),
        FOREIGN KEY (project_id, import_id) REFERENCES project_asset_imports(project_id, import_id)
      );
    `);
    if (legacy) {
      database.prepare(`INSERT INTO maps (project_id, map_id, document_json, updated_at)
        SELECT ?, id, document_json, updated_at FROM legacy_maps`)
        .run(ASTRAEUM_PROJECT_ID);
      if (tables.has("map_backups")) {
        database.prepare(`INSERT INTO map_backups
          SELECT id, ?, map_id, format_version, document_json, original_updated_at, reason, created_at
          FROM legacy_map_backups`).run(ASTRAEUM_PROJECT_ID);
      }
      if (tables.has("migrations")) {
        database.prepare(`INSERT INTO migrations
          SELECT id, ?, map_id, from_version, to_version, status, backup_id, report_json, created_at
          FROM legacy_migrations`).run(ASTRAEUM_PROJECT_ID);
      }
      for (const table of ["map_backups", "migrations"]) {
        if (tables.has(table)) {
          const previous = database.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?").get(`legacy_${table}`);
          if (previous) {
            database.prepare("INSERT INTO sqlite_sequence (name, seq) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = ?)")
              .run(table, previous.seq, table);
            database.prepare("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = ?").run(previous.seq, table);
          }
        }
      }
      for (const table of ["migrations", "map_backups", "maps"]) {
        if (tables.has(table)) database.exec(`DROP TABLE legacy_${table}`);
      }
    }
    if (!database.prepare("PRAGMA table_info(maps)").all().some(column => column.name === "model")) {
      database.exec("ALTER TABLE maps ADD COLUMN model TEXT");
    }
    if (!database.prepare("PRAGMA table_info(maps)").all().some(column => column.name === "deleted_at")) {
      database.exec("ALTER TABLE maps ADD COLUMN deleted_at TEXT");
    }
    database.exec(`
      CREATE TABLE IF NOT EXISTS worlds (
        project_id TEXT NOT NULL, world_id TEXT NOT NULL, name TEXT NOT NULL,
        model TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (project_id, world_id)
      );
      CREATE TABLE IF NOT EXISTS world_sections (
        project_id TEXT NOT NULL, world_id TEXT NOT NULL, section_id TEXT NOT NULL,
        map_id TEXT NOT NULL, grid_x INTEGER NOT NULL, grid_y INTEGER NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (project_id, world_id, section_id),
        UNIQUE (project_id, world_id, grid_x, grid_y),
        UNIQUE (project_id, map_id),
        FOREIGN KEY (project_id, world_id) REFERENCES worlds(project_id, world_id),
        FOREIGN KEY (project_id, map_id) REFERENCES maps(project_id, map_id)
      );
      CREATE TABLE IF NOT EXISTS world_save_receipts (
        project_id TEXT NOT NULL, world_id TEXT NOT NULL, operation_id TEXT NOT NULL,
        request_hash TEXT NOT NULL, result_json TEXT NOT NULL,
        PRIMARY KEY (project_id, world_id, operation_id),
        FOREIGN KEY (project_id, world_id) REFERENCES worlds(project_id, world_id)
      );
      CREATE TABLE IF NOT EXISTS level_section_sets (
        project_id TEXT NOT NULL, level_map_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (project_id, level_map_id),
        FOREIGN KEY (project_id, level_map_id) REFERENCES maps(project_id, map_id)
      );
      CREATE TABLE IF NOT EXISTS level_sections (
        project_id TEXT NOT NULL, level_map_id TEXT NOT NULL, section_id TEXT NOT NULL,
        map_id TEXT NOT NULL, grid_x INTEGER NOT NULL, grid_y INTEGER NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (project_id, level_map_id, section_id),
        UNIQUE (project_id, level_map_id, grid_x, grid_y),
        UNIQUE (project_id, map_id),
        FOREIGN KEY (project_id, level_map_id) REFERENCES level_section_sets(project_id, level_map_id),
        FOREIGN KEY (project_id, map_id) REFERENCES maps(project_id, map_id)
      );
      CREATE TABLE IF NOT EXISTS level_section_archives (
        project_id TEXT NOT NULL, level_map_id TEXT NOT NULL, section_id TEXT NOT NULL,
        map_id TEXT NOT NULL, grid_x INTEGER NOT NULL, grid_y INTEGER NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (project_id, level_map_id, section_id),
        UNIQUE (project_id, map_id),
        FOREIGN KEY (project_id, level_map_id) REFERENCES level_section_sets(project_id, level_map_id),
        FOREIGN KEY (project_id, map_id) REFERENCES maps(project_id, map_id)
      );
      CREATE TABLE IF NOT EXISTS level_section_save_receipts (
        project_id TEXT NOT NULL, level_map_id TEXT NOT NULL, operation_id TEXT NOT NULL,
        request_hash TEXT NOT NULL, result_json TEXT NOT NULL,
        PRIMARY KEY (project_id, level_map_id, operation_id),
        FOREIGN KEY (project_id, level_map_id) REFERENCES level_section_sets(project_id, level_map_id)
      );
      CREATE TABLE IF NOT EXISTS project_levels (
        project_id TEXT PRIMARY KEY,
        starting_map_id TEXT NOT NULL,
        FOREIGN KEY (project_id, starting_map_id) REFERENCES maps(project_id, map_id)
      );
      INSERT INTO project_levels (project_id, starting_map_id)
        SELECT project_id, COALESCE(MAX(CASE WHEN project_id = 'astraeum-tower'
          AND map_id = 'astraeum-tower-floor-1' THEN map_id END), MIN(map_id))
        FROM maps WHERE deleted_at IS NULL
        GROUP BY project_id ON CONFLICT(project_id) DO NOTHING;
    `);
    database.prepare("UPDATE maps SET model = ? WHERE project_id = ? AND map_id = ? AND model IS NULL")
      .run(ASTRAEUM_MODEL, ASTRAEUM_PROJECT_ID, ASTRAEUM_FLOOR_1_MAP_ID);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
initializeStorage();
database.exec("PRAGMA foreign_keys = ON");

const getMap = database.prepare("SELECT document_json, updated_at, model, deleted_at FROM maps WHERE project_id = ? AND map_id = ?");
const listMaps = database.prepare("SELECT project_id, map_id, document_json, updated_at, model FROM maps WHERE deleted_at IS NULL ORDER BY project_id, map_id");
const saveMap = database.prepare(`
  INSERT INTO maps (project_id, map_id, document_json, updated_at, model) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(project_id, map_id) DO UPDATE SET document_json = excluded.document_json, updated_at = excluded.updated_at,
    model = excluded.model
`);
const insertBackup = database.prepare(`
  INSERT INTO map_backups (project_id, map_id, format_version, document_json, original_updated_at, reason, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const insertMigration = database.prepare(`
  INSERT INTO migrations (project_id, map_id, from_version, to_version, status, backup_id, report_json, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const listMigrations = database.prepare(`
  SELECT id, from_version, to_version, status, backup_id, report_json, created_at
  FROM migrations WHERE project_id = ? AND map_id = ? ORDER BY id DESC LIMIT 5
`);
const lastFailure = database.prepare(`
  SELECT report_json FROM migrations WHERE project_id = ? AND map_id = ? AND status = 'failed' ORDER BY id DESC LIMIT 1
`);
const projectAssetRows = database.prepare(`
  SELECT a.project_id, a.asset_id, a.import_id, a.source_path, a.direction, a.width, a.height, a.sha256,
    i.name AS import_name, i.category, i.author, i.source, i.source_filename,
    i.metadata_sha256, i.archive_sha256, i.created_at
  FROM project_assets a JOIN project_asset_imports i USING (project_id, import_id)
  WHERE a.project_id = ? ORDER BY i.created_at, a.source_path
`);

function storedFormat(json) {
  try {
    const value = JSON.parse(json);
    return Number.isInteger(value?.formatVersion) ? value.formatVersion : null;
  } catch {
    return null;
  }
}

// Explicit, transactional upgrade of saved designs. The exact stored JSON is copied
// into map_backups before the row changes. A row that cannot be migrated is left
// untouched and the failure is recorded; the editor then refuses to overwrite it.
function migrateStoredMaps() {
  database.exec("BEGIN IMMEDIATE");
  try {
    const rows = database.prepare("SELECT project_id, map_id, document_json, updated_at FROM maps WHERE project_id = ? AND map_id = ?")
      .all(ASTRAEUM_PROJECT_ID, ASTRAEUM_FLOOR_1_MAP_ID);
    for (const row of rows) {
      const version = storedFormat(row.document_json);
      if (version === DESIGN_FORMAT_VERSION) continue;
      const now = new Date().toISOString();
      let document;
      let report;
      try {
        if (version !== 1) throw new TypeError(`No migration exists from format ${String(version)}.`);
        ({ document, report } = migrateFloorDocumentV1(JSON.parse(row.document_json)));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failure = JSON.stringify({ error: message });
        if (lastFailure.get(row.project_id, row.map_id)?.report_json !== failure) {
          insertMigration.run(row.project_id, row.map_id, version, DESIGN_FORMAT_VERSION, "failed", null, failure, now);
        }
        console.error(`Could not migrate ${row.project_id}/${row.map_id}: ${message} The stored design was left untouched.`);
        continue;
      }
      const backup = insertBackup.run(row.project_id, row.map_id, version, row.document_json, row.updated_at,
        `before migration to format ${DESIGN_FORMAT_VERSION}`, now);
      insertMigration.run(row.project_id, row.map_id, version, DESIGN_FORMAT_VERSION, "migrated",
        backup.lastInsertRowid, JSON.stringify(report), now);
      saveMap.run(row.project_id, row.map_id, JSON.stringify(document), now, ASTRAEUM_MODEL);
      console.log(`Migrated ${row.project_id}/${row.map_id} from format ${version} to ${DESIGN_FORMAT_VERSION}; ` +
        `original kept in map_backups.`);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
migrateStoredMaps();

function documentProblem(row, projectId, mapId) {
  if (!isProjectMapId(projectId) || !isProjectMapId(mapId)) return "Invalid project or map ID.";
  try {
    const document = JSON.parse(row.document_json);
    if (document.id !== mapId) return "The saved document ID does not match the map ID.";
    const catalog = assetCatalogFor(projectId, row.model);
    (row.model === generic.MODEL ? generic.validateFloorDocument : validateFloorDocument)(document, catalog);
    return null;
  } catch (error) {
    return `Unsupported ${row.model === generic.MODEL ? "Generic Grid" : "Astraeum"} document format: ${error.message}`;
  }
}

function unsupportedReason(row, projectId, mapId) {
  if (row.model === null) {
    return documentProblem(row, projectId, mapId) ?? "Unsupported or unknown game model; no runtime has been assigned.";
  }
  if (![ASTRAEUM_MODEL, generic.MODEL].includes(row.model)) return "Unsupported game model; no runtime has been assigned.";
  return documentProblem(row, projectId, mapId);
}

function migrationsFor(projectId, mapId) {
  return listMigrations.all(projectId, mapId).map(row => ({
    id: row.id,
    fromVersion: row.from_version,
    toVersion: row.to_version,
    status: row.status,
    backupId: row.backup_id,
    report: JSON.parse(row.report_json),
    createdAt: row.created_at
  }));
}

function send(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(body);
}

function isLoopback(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

async function readJson(request, maximum = 2_000_000) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maximum) throw new RangeError(`Request exceeds the ${Math.round(maximum / 1_000_000)} MB limit.`);
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function projectExists(projectId) {
  return projectId === ASTRAEUM_PROJECT_ID ||
    Boolean(database.prepare("SELECT 1 FROM projects WHERE project_id = ?").get(projectId) ||
    database.prepare("SELECT 1 FROM maps WHERE project_id = ? LIMIT 1").get(projectId));
}

function assetCatalogFor(projectId, model) {
  const catalog = model === generic.MODEL ? { ...generic.ASSET_CATALOG } : { ...ASSET_CATALOG };
  for (const row of projectAssetRows.all(projectId)) {
    const record = {
      ...row,
      name: row.direction ? `${row.import_name} · ${row.direction}` : row.import_name
    };
    catalog[row.asset_id] = importedAssetDefinition(record, model);
  }
  return catalog;
}

function rowsForProjectAssets(projectId) {
  return projectAssetRows.all(projectId).map(row => ({
    projectId: row.project_id,
    assetId: row.asset_id,
    importId: row.import_id,
    name: row.direction ? `${row.import_name} · ${row.direction}` : row.import_name,
    category: row.category,
    author: row.author,
    source: row.source,
    sourceFilename: row.source_filename,
    sourcePath: row.source_path,
    direction: row.direction,
    width: row.width,
    height: row.height,
    sha256: row.sha256,
    metadataSha256: row.metadata_sha256,
    archiveSha256: row.archive_sha256,
    createdAt: row.created_at
  }));
}

function decodeUpload(data) {
  if (typeof data !== "string" || data.length > 23_000_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
    throw new TypeError("Upload data must be valid base64 within the size limit.");
  }
  const bytes = Buffer.from(data, "base64");
  if (bytes.toString("base64") !== data) throw new TypeError("Upload data must be canonical base64.");
  return bytes;
}

function sendPng(response, bytes) {
  response.writeHead(200, {
    "content-type": "image/png",
    "content-length": bytes.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(bytes);
}

function requiredExportCredit(value, label, field) {
  const message = `${label} (${field}) is required and must be a nonblank string.`;
  if (typeof value !== "string" || !value.trim()) throw new TypeError(message);
  return value.trim();
}

function realDirectory(path, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") throw new TypeError(`${label} is missing.`);
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TypeError(`${label} is not a real directory.`);
}

function verifiedPackageMedia(projectId, descriptor, importedById) {
  let file;
  let expectedHash;
  if (descriptor.kind === "builtin") {
    const source = ASTRAEUM_ARTWORK_PROVENANCE[descriptor.file];
    if (!source) throw new TypeError(`Built-in package artwork ${descriptor.file} has no provenance record.`);
    const assetsDirectory = resolve(root, "games", "astraeum-tower", "assets");
    realDirectory(resolve(root, "games"), "Built-in games directory");
    realDirectory(resolve(root, "games", "astraeum-tower"), "Astraeum source directory");
    realDirectory(assetsDirectory, "Astraeum artwork directory");
    file = resolve(assetsDirectory, descriptor.file);
    if (relative(assetsDirectory, file).startsWith("..")) {
      throw new TypeError(`Built-in artwork path escaped its source directory: ${descriptor.file}.`);
    }
    expectedHash = source.sha256;
  } else if (descriptor.kind === "imported") {
    const row = importedById.get(descriptor.assetId);
    if (!row) throw new TypeError(`Imported package artwork ${descriptor.assetId} is missing from the saved project.`);
    if (descriptor.provenance.author !== row.author || descriptor.provenance.source !== row.source ||
        descriptor.provenance.sourceFilename !== row.source_filename) {
      throw new TypeError(`Imported package artwork ${descriptor.assetId} has inconsistent saved attribution.`);
    }
    const projectDirectory = resolve(gamesDirectory, projectId);
    const assetsDirectory = resolve(projectDirectory, "assets");
    realDirectory(gamesDirectory, "Project games directory");
    realDirectory(projectDirectory, "Project directory");
    realDirectory(assetsDirectory, "Project assets directory");
    const importDirectory = resolve(assetsDirectory, row.import_id);
    realDirectory(importDirectory, `Imported artwork directory ${row.import_id}`);
    file = resolve(importDirectory, `${row.asset_id}.png`);
    if (relative(assetsDirectory, file).startsWith("..") || relative(importDirectory, file) !== `${row.asset_id}.png`) {
      throw new TypeError(`Imported artwork path escaped its saved project: ${row.asset_id}.`);
    }
    expectedHash = row.sha256;
  } else {
    throw new TypeError(`Unsupported package artwork source "${descriptor.kind}".`);
  }

  let stat;
  try {
    stat = lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new TypeError(`Required package artwork ${descriptor.mediaId} is missing (${descriptor.file}).`);
    }
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new TypeError(`Required package artwork ${descriptor.mediaId} is not a regular file.`);
  }
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    throw new Error(`Could not read required package artwork ${descriptor.mediaId}: ${error.message}`, { cause: error });
  }
  if (sha256(bytes) !== expectedHash) {
    throw new TypeError(`Required package artwork ${descriptor.mediaId} no longer matches its saved SHA-256 hash.`);
  }
  return bytes;
}

function createSavedAstraeumPackage(projectId, input) {
  const project = requiredExportCredit(input?.project, "Project", "project");
  const author = requiredExportCredit(input?.author, "Author", "author");
  if (project.length > 64) throw new TypeError("Game Name must be at most 64 characters.");
  const version = input?.version === undefined ? ASTRAEUM_PACKAGE_VERSION : input.version;
  if (typeof version !== "string" || !GamePackageManifestSchema.shape.version.safeParse(version.trim()).success) {
    throw new TypeError("Version must use the format 1.0.0 or 1.0.0-prerelease.");
  }
  if (input.course !== undefined && typeof input.course !== "string") {
    throw new TypeError("Course (course) must be a string when provided.");
  }
  const course = typeof input.course === "string" && input.course.trim() ? input.course.trim() : undefined;
  let transaction = false;
  database.exec("BEGIN");
  transaction = true;
  try {
    if (!projectExists(projectId)) levelError("Game not found.", 404);
    const listing = levelList(projectId);
    const active = listing.levels.filter(level => !level.deletedAt);
    if (!active.length) throw new TypeError("The saved campaign has no active levels to export.");
    for (const level of active) {
      if (!level.supported) {
        throw new TypeError(`Level ${level.mapId} cannot be exported: ${level.reason}`);
      }
      if (level.model !== ASTRAEUM_MODEL) {
        throw new TypeError(`Level ${level.mapId} uses ${level.model ?? "an unassigned model"}; all active campaign levels must use Astraeum Floor.`);
      }
    }
    const start = active.find(level => level.mapId === listing.startingMapId);
    if (!start) throw new TypeError("The designated starting level is missing, deleted, or unsupported.");
    const levels = active.map(level => {
      const saved = levelSectionPayload(projectId, level.mapId);
      return {
        mapId: level.mapId,
        model: saved.model,
        sections: saved.sections,
        archivedSections: saved.archivedSections
      };
    });
    const snapshot = {
      model: ASTRAEUM_MODEL,
      startingMapId: start.mapId,
      levels: orderAstraeumCampaignLevels({ model: ASTRAEUM_MODEL, startingMapId: start.mapId, levels })
    };
    const importedRows = projectAssetRows.all(projectId);
    const { campaign, media: mediaSources } = createAstraeumCampaign(
      snapshot, assetCatalogFor(projectId, ASTRAEUM_MODEL), importedRows
    );
    const importedById = new Map(importedRows.map(row => [row.asset_id, row]));
    const media = new Map();
    const required = {};
    for (const descriptor of mediaSources.values()) {
      const bytes = verifiedPackageMedia(projectId, descriptor, importedById);
      const path = `art/${descriptor.mediaId}.png`;
      if (media.has(path)) throw new TypeError(`Package artwork path ${path} is declared more than once.`);
      media.set(path, bytes);
      required[descriptor.mediaId] = {
        path,
        sha256: sha256(bytes)
      };
    }
    const theme = createAstraeumPackageTheme({
      project, author, course, version: version.trim(),
      assets: { required, optional: {} },
      assetProvenance: packageAssetProvenance(mediaSources.values())
    });
    let result;
    try {
      result = buildGamePackage({ model: ASTRAEUM_MODEL, theme, campaign, media });
    } catch (error) {
      if (error?.name === "ZodError") {
        throw new TypeError(`The saved Astraeum campaign is not valid for the Engine package contract: ${error.message}`);
      }
      throw error;
    }
    database.exec("COMMIT");
    transaction = false;
    return result;
  } catch (error) {
    if (transaction) database.exec("ROLLBACK");
    throw error;
  }
}

function projectAssetsDirectory(projectId) {
  const projectDirectory = resolve(gamesDirectory, projectId);
  const relativeProject = relative(gamesDirectory, projectDirectory);
  if (!relativeProject || relativeProject === ".." || relativeProject.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("Project asset path escaped the games directory.");
  }
  const projectStat = lstatSync(projectDirectory);
  if (!projectStat.isDirectory() || projectStat.isSymbolicLink()) throw new Error("Project directory is not a real directory.");
  const assetsDirectory = resolve(projectDirectory, "assets");
  if (relative(projectDirectory, assetsDirectory) !== `assets`) throw new Error("Project asset directory is invalid.");
  mkdirSync(assetsDirectory, { recursive: true });
  const assetsStat = lstatSync(assetsDirectory);
  if (!assetsStat.isDirectory() || assetsStat.isSymbolicLink()) throw new Error("Project assets path is not a real directory.");
  return assetsDirectory;
}

function importAssets(projectId, input) {
  const fields = validateImportFields(input);
  const bytes = decodeUpload(input.data);
  const upload = parseAssetUpload(input.filename, bytes);
  const hashes = upload.images.map(image => sha256(image.bytes));
  if (new Set(hashes).size !== hashes.length) {
    const error = new Error("The upload contains duplicate image bytes; no assets were imported.");
    error.status = 409;
    throw error;
  }
  for (const hash of hashes) {
    if (database.prepare("SELECT 1 FROM project_assets WHERE project_id = ? AND sha256 = ?").get(projectId, hash)) {
      const error = new Error("This project already contains one or more identical images; no assets were imported.");
      error.status = 409;
      throw error;
    }
  }
  const assetsDirectory = projectAssetsDirectory(projectId);
  const importId = randomUUID();
  const temporaryDirectory = resolve(assetsDirectory, `.import-${importId}`);
  const finalDirectory = resolve(assetsDirectory, importId);
  const imageRecords = upload.images.map((image, index) => ({
    ...image,
    assetId: `asset-${hashes[index]}`,
    sha256: hashes[index]
  }));
  let transaction = false;
  let published = false;
  mkdirSync(temporaryDirectory);
  try {
    for (const image of imageRecords) {
      writeFileSync(resolve(temporaryDirectory, `${image.assetId}.png`), image.bytes, { flag: "wx" });
    }
    writeFileSync(resolve(temporaryDirectory, "source-metadata.json"), upload.metadataBytes, { flag: "wx" });
    database.exec("BEGIN IMMEDIATE");
    transaction = true;
    if (!projectExists(projectId)) throw new Error("Project no longer exists.");
    for (const hash of hashes) {
      if (database.prepare("SELECT 1 FROM project_assets WHERE project_id = ? AND sha256 = ?").get(projectId, hash)) {
        const error = new Error("This project already contains one or more identical images; no assets were imported.");
        error.status = 409;
        throw error;
      }
    }
    const createdAt = new Date().toISOString();
    database.prepare(`INSERT INTO project_asset_imports
      (project_id, import_id, name, category, author, source, source_filename, source_metadata,
       metadata_sha256, archive_sha256, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(projectId, importId, fields.name, fields.category, fields.author, fields.source,
        upload.filename, upload.metadataBytes, sha256(upload.metadataBytes), upload.archiveHash, createdAt);
    const insertAsset = database.prepare(`INSERT INTO project_assets
      (project_id, asset_id, import_id, source_path, direction, width, height, sha256)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const image of imageRecords) {
      insertAsset.run(projectId, image.assetId, importId, image.path, image.direction,
        image.width, image.height, image.sha256);
    }
    renameSync(temporaryDirectory, finalDirectory);
    published = true;
    database.exec("COMMIT");
    transaction = false;
    return { importId, assets: rowsForProjectAssets(projectId).filter(row => row.importId === importId),
      metadata: upload.metadata, animations: upload.animations };
  } catch (error) {
    if (transaction) database.exec("ROLLBACK");
    if (published) rmSync(finalDirectory, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function createProject(input) {
  const values = generic.validateCreation(input);
  let directory;
  let transaction = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    transaction = true;
    const nameKey = values.name.normalize("NFKC").toLowerCase();
    if (database.prepare("SELECT 1 FROM projects WHERE name_key = ?").get(nameKey) ||
        database.prepare("SELECT 1 FROM maps WHERE project_id = ?").get(values.name.toLowerCase()) ||
        ["astraeum tower", "astraeum-tower", "sample", generic.MODEL].includes(nameKey)) {
      const error = new Error("A game with this name already exists. Choose a different name.");
      error.status = 409;
      throw error;
    }
    const slug = values.name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "game";
    let projectId;
    mkdirSync(gamesDirectory, { recursive: true });
    for (let attempt = 0; attempt < 5; attempt++) {
      projectId = `${slug}-${randomUUID()}`;
      if (database.prepare("SELECT 1 FROM maps WHERE project_id = ?").get(projectId) ||
          database.prepare("SELECT 1 FROM projects WHERE project_id = ?").get(projectId)) continue;
      const candidate = resolve(gamesDirectory, projectId);
      try {
        mkdirSync(candidate);
        directory = candidate;
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    }
    if (!directory) throw new Error("Could not allocate a unique project directory.");
    const mapId = `map-${randomUUID()}`;
    const document = generic.createDocument(mapId, values.name, { width: values.width, height: values.height });
    const createdAt = new Date().toISOString();
    const metadata = { formatVersion: 1, projectId, name: values.name, author: values.author,
      model: generic.MODEL, runtimeAdapter: "generic-runtime-v1", mapIds: [mapId], createdAt };
    writeFileSync(resolve(directory, "project.json"), JSON.stringify(metadata, null, 2) + "\n", { flag: "wx" });
    mkdirSync(resolve(directory, "src"));
    mkdirSync(resolve(directory, "assets"));
    const adapter = relative(resolve(directory, "src"), resolve(root, "games", "generic-grid-v1", "src", "runtime.js")).replaceAll("\\", "/");
    writeFileSync(resolve(directory, "src", "runtime.js"),
      `export { genericPreview, genericSkin } from ${JSON.stringify(adapter.startsWith(".") ? adapter : `./${adapter}`)};\n`, { flag: "wx" });
    database.prepare("INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?)")
      .run(projectId, values.name, nameKey, values.author, generic.MODEL, createdAt);
    database.prepare("INSERT INTO maps (project_id, map_id, document_json, updated_at, model) VALUES (?, ?, ?, ?, ?)")
      .run(projectId, mapId, JSON.stringify(document), createdAt, generic.MODEL);
    ensureStartingLevel(projectId, mapId);
    database.exec("COMMIT");
    transaction = false;
    return { projectId, mapId, model: generic.MODEL, project: metadata, document, updatedAt: createdAt, migrations: [] };
  } catch (error) {
    try {
      if (directory) rmSync(directory, { recursive: true });
    } finally {
      if (transaction) database.exec("ROLLBACK");
    }
    throw error;
  }
}

function ensureStartingLevel(projectId, mapId) {
  database.prepare("INSERT INTO project_levels VALUES (?, ?) ON CONFLICT(project_id) DO NOTHING")
    .run(projectId, mapId);
}

function levelList(projectId) {
  const startingMapId = database.prepare("SELECT starting_map_id FROM project_levels WHERE project_id = ?")
    .get(projectId)?.starting_map_id ?? null;
  const levels = database.prepare(`SELECT * FROM maps WHERE project_id = ? AND NOT EXISTS
    (SELECT 1 FROM world_sections s WHERE s.project_id = maps.project_id AND s.map_id = maps.map_id)
    AND NOT EXISTS (SELECT 1 FROM level_sections s WHERE s.project_id = maps.project_id
      AND s.map_id = maps.map_id AND s.level_map_id != maps.map_id)
    AND NOT EXISTS (SELECT 1 FROM level_section_archives s WHERE s.project_id = maps.project_id
      AND s.map_id = maps.map_id AND s.level_map_id != maps.map_id)
    ORDER BY updated_at, map_id`).all(projectId)
    .map(row => {
      const reason = unsupportedReason(row, projectId, row.map_id);
      const name = reason === null ? JSON.parse(row.document_json).name : row.map_id;
      return { mapId: row.map_id, name, model: row.model, deletedAt: row.deleted_at,
        starting: startingMapId === row.map_id, supported: reason === null, reason };
    });
  return { projectId, startingMapId, levels };
}

function levelError(message, status = 409) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function levelSectionPayload(projectId, levelMapId) {
  const level = getMap.get(projectId, levelMapId);
  if (!level || level.deleted_at) levelError("Active level not found.", 404);
  if (database.prepare("SELECT 1 FROM world_sections WHERE project_id = ? AND map_id = ?").get(projectId, levelMapId) ||
      database.prepare("SELECT 1 FROM level_sections WHERE project_id = ? AND map_id = ? AND level_map_id != ?")
        .get(projectId, levelMapId, levelMapId) ||
      database.prepare("SELECT 1 FROM level_section_archives WHERE project_id = ? AND map_id = ? AND level_map_id != ?")
        .get(projectId, levelMapId, levelMapId)) levelError("This map is not an independent level.");
  const problem = unsupportedReason(level, projectId, levelMapId);
  if (problem) levelError(problem);
  const model = level.model;
  const set = database.prepare("SELECT revision FROM level_section_sets WHERE project_id = ? AND level_map_id = ?")
    .get(projectId, levelMapId);
  const rows = database.prepare(`SELECT s.*, m.document_json, m.model AS map_model, m.deleted_at
    FROM level_sections s LEFT JOIN maps m ON m.project_id = s.project_id AND m.map_id = s.map_id
    WHERE s.project_id = ? AND s.level_map_id = ? ORDER BY s.grid_y, s.grid_x`).all(projectId, levelMapId);
  const archivedRows = database.prepare(`SELECT s.*, m.document_json, m.model AS map_model, m.deleted_at
    FROM level_section_archives s LEFT JOIN maps m ON m.project_id = s.project_id AND m.map_id = s.map_id
    WHERE s.project_id = ? AND s.level_map_id = ? ORDER BY s.grid_y, s.grid_x, s.section_id`)
    .all(projectId, levelMapId);
  const legacyRoot = rows.length === 0 && archivedRows.length === 0;
  const sectionRows = rows.length || archivedRows.length ? rows : [{
    section_id: `section-${levelMapId}`, map_id: levelMapId, grid_x: 0, grid_y: 0,
    revision: 0, document_json: level.document_json, map_model: model, deleted_at: null
  }];
  const deserialize = row => {
    if (!row.document_json || row.deleted_at || row.map_model !== model) {
      levelError(`Section ${row.section_id} is missing, deleted, or incompatible.`);
    }
    sectionOrigin(row.grid_x, row.grid_y);
    const document = JSON.parse(row.document_json);
    if (row.map_id !== levelMapId &&
        (document.bounds.width !== 2048 || document.bounds.height !== 2048)) {
      levelError(`Section ${row.section_id} must be 2048 × 2048.`);
    }
    return { sectionId: row.section_id, mapId: row.map_id, gridX: row.grid_x, gridY: row.grid_y,
      revision: row.revision, document };
  };
  const sections = rows.map(deserialize);
  const archivedSections = archivedRows.map(deserialize);
  if (legacyRoot) sections.push(deserialize(sectionRows[0]));
  if (!sections.length) levelError("A level must keep at least one active section.");
  if (sections.length > MAX_LEVEL_SECTIONS || archivedSections.length > MAX_ARCHIVED_LEVEL_SECTIONS) {
    levelError("Level section membership exceeds its storage limits.");
  }
  const allSections = [...sections, ...archivedSections];
  if (new Set(allSections.map(section => section.sectionId)).size !== allSections.length ||
      new Set(allSections.map(section => section.mapId)).size !== allSections.length) {
    levelError("Level section membership contains duplicate section or map IDs.");
  }
  const roots = allSections.filter(section => section.mapId === levelMapId);
  if (roots.length !== 1) levelError("Level section membership is incomplete; the root document is missing.");
  const root = roots[0];
  if (root.document.playableBoundary) {
    validatePlayableBoundaryForSections(root.document.playableBoundary, sections);
  }
  return { projectId, levelMapId, model, revision: set?.revision ?? 0, sections, archivedSections,
    rootDocument: root.document };
}

function addLevelSection(projectId, levelMapId, input) {
  if (!input || !Number.isSafeInteger(input.gridX) || !Number.isSafeInteger(input.gridY) ||
      !Number.isSafeInteger(input.revision)) {
    throw new TypeError("Choose an integer grid position for the new section.");
  }
  sectionOrigin(input.gridX, input.gridY);
  database.exec("BEGIN IMMEDIATE");
  try {
    const current = levelSectionPayload(projectId, levelMapId);
    if (input.revision !== current.revision) levelError("Level sections changed since they were opened. Reopen before adding a section.");
    if (current.sections.length >= MAX_LEVEL_SECTIONS) {
      levelError(`A level can contain at most ${MAX_LEVEL_SECTIONS} sections.`, 400);
    }
    if (current.archivedSections.length > MAX_ARCHIVED_LEVEL_SECTIONS) {
      levelError(`A level can archive at most ${MAX_ARCHIVED_LEVEL_SECTIONS} sections.`, 400);
    }
    if (current.model == null) levelError("The level model is not assigned.");
    if (!current.sections.some(section => Math.abs(section.gridX - input.gridX) +
        Math.abs(section.gridY - input.gridY) === 1)) {
      levelError("A section must be adjacent to an existing section.", 400);
    }
    if (current.sections.some(section => section.gridX === input.gridX && section.gridY === input.gridY)) {
      levelError("That section position is already occupied.", 409);
    }
    if (!database.prepare(`SELECT 1 FROM level_sections WHERE project_id = ? AND level_map_id = ?
        UNION ALL SELECT 1 FROM level_section_archives WHERE project_id = ? AND level_map_id = ? LIMIT 1`)
        .get(projectId, levelMapId, projectId, levelMapId)) {
      database.prepare("INSERT INTO level_section_sets (project_id, level_map_id, revision) VALUES (?, ?, 0) " +
        "ON CONFLICT(project_id, level_map_id) DO NOTHING").run(projectId, levelMapId);
      const root = current.sections.find(section => section.mapId === levelMapId);
      database.prepare(`INSERT INTO level_sections
        (project_id, level_map_id, section_id, map_id, grid_x, grid_y) VALUES (?, ?, ?, ?, 0, 0)`)
        .run(projectId, levelMapId, root.sectionId, levelMapId);
    }
    const mapId = `map-${randomUUID()}`;
    const sectionId = `section-${randomUUID()}`;
    const name = `${current.sections[0].document.name} section`;
    const starter = current.model === generic.MODEL
      ? generic.createEmptyLevelDocument(mapId, name) : createEmptyLevelDocument(mapId, name);
    const validate = current.model === generic.MODEL ? generic.validateFloorDocument : validateFloorDocument;
    const document = validate(starter);
    const now = new Date().toISOString();
    database.prepare("INSERT INTO maps (project_id, map_id, document_json, updated_at, model) VALUES (?, ?, ?, ?, ?)")
      .run(projectId, mapId, JSON.stringify(document), now, current.model);
    database.prepare(`INSERT INTO level_sections
      (project_id, level_map_id, section_id, map_id, grid_x, grid_y) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(projectId, levelMapId, sectionId, mapId, input.gridX, input.gridY);
    database.prepare("UPDATE level_section_sets SET revision = revision + 1 WHERE project_id = ? AND level_map_id = ?")
      .run(projectId, levelMapId);
    const result = levelSectionPayload(projectId, levelMapId);
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function saveLevelSections(projectId, levelMapId, input) {
  if (!input || !isProjectMapId(input.operationId) || !Number.isSafeInteger(input.revision) ||
      !Array.isArray(input.sections) || !input.sections.length || input.sections.length > MAX_LEVEL_SECTIONS ||
      (Object.hasOwn(input, "archivedSections") &&
        (!Array.isArray(input.archivedSections) || input.archivedSections.length > MAX_ARCHIVED_LEVEL_SECTIONS))) {
    throw new TypeError(`Invalid level section save (maximum ${MAX_LEVEL_SECTIONS} active and ${MAX_ARCHIVED_LEVEL_SECTIONS} archived sections).`);
  }
  const hash = sha256(Buffer.from(JSON.stringify(input)));
  database.exec("BEGIN IMMEDIATE");
  try {
    const receipt = database.prepare(`SELECT request_hash, result_json FROM level_section_save_receipts
      WHERE project_id = ? AND level_map_id = ? AND operation_id = ?`)
      .get(projectId, levelMapId, input.operationId);
    if (receipt) {
      if (receipt.request_hash !== hash) levelError("Save operation ID was reused with different content.");
      database.exec("COMMIT");
      return JSON.parse(receipt.result_json);
    }
    const current = levelSectionPayload(projectId, levelMapId);
    const archivedInput = input.archivedSections ?? [];
    if (current.revision !== input.revision ||
        (current.archivedSections.length > 0 && !Object.hasOwn(input, "archivedSections"))) {
      levelError("Level sections changed since they were opened. Reopen before saving.");
    }
    const catalog = assetCatalogFor(projectId, current.model);
    if (!database.prepare(`SELECT 1 FROM level_sections WHERE project_id = ? AND level_map_id = ?
        UNION ALL SELECT 1 FROM level_section_archives WHERE project_id = ? AND level_map_id = ? LIMIT 1`)
        .get(projectId, levelMapId, projectId, levelMapId)) {
      database.prepare("INSERT INTO level_section_sets (project_id, level_map_id, revision) VALUES (?, ?, 0) " +
        "ON CONFLICT(project_id, level_map_id) DO NOTHING").run(projectId, levelMapId);
      const root = current.sections.find(section => section.mapId === levelMapId);
      database.prepare(`INSERT INTO level_sections
        (project_id, level_map_id, section_id, map_id, grid_x, grid_y) VALUES (?, ?, ?, ?, 0, 0)`)
        .run(projectId, levelMapId, root.sectionId, levelMapId);
    }
    const allExisting = [...current.sections, ...current.archivedSections];
    const seen = new Set();
    const seenMapIds = new Set(allExisting.map(section => section.mapId));
    const newSections = [];
    const normalize = (entries, isArchived = false) => entries.map(section => {
      const existing = allExisting.find(item => item.sectionId === section.sectionId);
      if (seen.has(section.sectionId)) levelError("Section membership or revision changed; no sections were saved.");
      seen.add(section.sectionId);
      if (!existing) {
        if (isArchived || !isProjectMapId(section.sectionId) || !isProjectMapId(section.mapId) ||
            section.mapId === levelMapId || section.revision !== 0 ||
            !Number.isSafeInteger(section.gridX) || !Number.isSafeInteger(section.gridY) ||
            section.document?.id !== section.mapId) {
          levelError("Section membership or revision changed; no sections were saved.");
        }
        sectionOrigin(section.gridX, section.gridY);
        if (seenMapIds.has(section.mapId)) levelError("Section membership or revision changed; no sections were saved.");
        seenMapIds.add(section.mapId);
        if (database.prepare("SELECT 1 FROM maps WHERE project_id = ? AND map_id = ?")
          .get(projectId, section.mapId)) {
          levelError("A new section map ID is already in use.", 409);
        }
        if (Buffer.byteLength(JSON.stringify(section.document)) > 2_000_000) {
          throw new RangeError("Section exceeds the 2 MB limit.");
        }
        const document = (current.model === generic.MODEL ? generic.validateFloorDocument : validateFloorDocument)
          (section.document, catalog);
        if (document.bounds.width !== 2048 || document.bounds.height !== 2048) {
          throw new TypeError("Section dimensions must remain 2048 × 2048.");
        }
        const addition = { sectionId: section.sectionId, mapId: section.mapId,
          gridX: section.gridX, gridY: section.gridY, revision: 0 };
        newSections.push(addition);
        return { existing: addition, document, isNew: true };
      }
      if (section.revision !== existing.revision || section.document?.id !== existing.mapId) {
        levelError("Section membership or revision changed; no sections were saved.");
      }
      if (Buffer.byteLength(JSON.stringify(section.document)) > 2_000_000) throw new RangeError("Section exceeds the 2 MB limit.");
      const document = (current.model === generic.MODEL ? generic.validateFloorDocument : validateFloorDocument)
        (section.document, catalog);
      if (existing.mapId !== levelMapId &&
          (document.bounds.width !== 2048 || document.bounds.height !== 2048)) {
        throw new TypeError("Section dimensions must remain 2048 × 2048.");
      }
      return { existing, document, isNew: false };
    });
    const activeUpdates = normalize(input.sections);
    const archivedUpdates = normalize(archivedInput, true);
    if (allExisting.some(section => !seen.has(section.sectionId))) {
      levelError("Section membership or revision changed; no sections were saved.");
    }
    if (!activeUpdates.length) levelError("A level must keep at least one active section.", 400);
    if (activeUpdates.length > MAX_LEVEL_SECTIONS) {
      levelError(`A level can contain at most ${MAX_LEVEL_SECTIONS} active sections.`, 400);
    }
    if (archivedUpdates.length > MAX_ARCHIVED_LEVEL_SECTIONS) {
      levelError(`A level can archive at most ${MAX_ARCHIVED_LEVEL_SECTIONS} sections.`, 400);
    }
    const activePositions = new Set();
    for (const { existing } of activeUpdates) {
      const position = `${existing.gridX},${existing.gridY}`;
      if (activePositions.has(position)) levelError("Active sections cannot occupy the same position.", 409);
      activePositions.add(position);
    }
    const activeMap = new Map(activeUpdates.map(update =>
      [`${update.existing.gridX},${update.existing.gridY}`, update]));
    const connected = new Set(allExisting.map(section => `${section.gridX},${section.gridY}`));
    const frontier = [...connected];
    while (frontier.length) {
      const [gridX, gridY] = frontier.pop().split(",").map(Number);
      for (const [x, y] of [[gridX - 1, gridY], [gridX + 1, gridY], [gridX, gridY - 1], [gridX, gridY + 1]]) {
        const key = `${x},${y}`;
        if (activeMap.has(key) && !connected.has(key)) {
          connected.add(key);
          frontier.push(key);
        }
      }
    }
    if (newSections.some(section => !connected.has(`${section.gridX},${section.gridY}`))) {
      levelError("New sections must connect to an existing section.", 400);
    }
    const updatedActiveSections = activeUpdates.map(update => ({ ...update.existing, document: update.document }));
    const updatedRoot = [...updatedActiveSections, ...archivedUpdates.map(update => ({
      ...update.existing, document: update.document
    }))].find(section => section.mapId === levelMapId);
    if (!updatedRoot) levelError("The root document must remain in the active or archived sections.");
    if (updatedRoot.document.playableBoundary) {
      validatePlayableBoundaryForSections(updatedRoot.document.playableBoundary, updatedActiveSections);
    }
    const now = new Date().toISOString();
    const activeIds = new Set(activeUpdates.map(update => update.existing.sectionId));
    for (const { existing } of archivedUpdates) {
      if (current.sections.some(section => section.sectionId === existing.sectionId)) {
        database.prepare("DELETE FROM level_sections WHERE project_id = ? AND level_map_id = ? AND section_id = ?")
          .run(projectId, levelMapId, existing.sectionId);
      }
    }
    for (const update of [...activeUpdates, ...archivedUpdates]) {
      const { existing, document } = update;
      saveMap.run(projectId, existing.mapId, JSON.stringify(document), now, current.model);
      const nextRevision = existing.revision + 1;
      const isActive = activeIds.has(existing.sectionId);
      if (update.isNew) {
        database.prepare(`INSERT INTO level_sections
          (project_id, level_map_id, section_id, map_id, grid_x, grid_y, revision)
          VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(projectId, levelMapId, existing.sectionId, existing.mapId, existing.gridX,
            existing.gridY, nextRevision);
      } else if (current.sections.some(section => section.sectionId === existing.sectionId)) {
        if (isActive) {
          database.prepare(`UPDATE level_sections SET revision = ?
            WHERE project_id = ? AND level_map_id = ? AND section_id = ?`)
            .run(nextRevision, projectId, levelMapId, existing.sectionId);
        } else {
          database.prepare(`INSERT INTO level_section_archives
            (project_id, level_map_id, section_id, map_id, grid_x, grid_y, revision) VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(projectId, levelMapId, existing.sectionId, existing.mapId, existing.gridX,
              existing.gridY, nextRevision);
        }
      } else if (isActive) {
        database.prepare(`INSERT INTO level_sections
          (project_id, level_map_id, section_id, map_id, grid_x, grid_y, revision) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(projectId, levelMapId, existing.sectionId, existing.mapId, existing.gridX,
            existing.gridY, nextRevision);
        database.prepare("DELETE FROM level_section_archives WHERE project_id = ? AND level_map_id = ? AND section_id = ?")
          .run(projectId, levelMapId, existing.sectionId);
      } else {
        database.prepare(`UPDATE level_section_archives SET revision = ?
          WHERE project_id = ? AND level_map_id = ? AND section_id = ?`)
          .run(nextRevision, projectId, levelMapId, existing.sectionId);
      }
    }
    database.prepare(`INSERT INTO level_section_sets (project_id, level_map_id, revision) VALUES (?, ?, 1)
      ON CONFLICT(project_id, level_map_id) DO UPDATE SET revision = revision + 1`).run(projectId, levelMapId);
    const result = levelSectionPayload(projectId, levelMapId);
    database.prepare("INSERT INTO level_section_save_receipts VALUES (?, ?, ?, ?, ?)")
      .run(projectId, levelMapId, input.operationId, hash, JSON.stringify(result));
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function advanceLevelRevision(projectId, mapId) {
  database.prepare(`INSERT INTO level_section_sets (project_id, level_map_id, revision) VALUES (?, ?, 1)
    ON CONFLICT(project_id, level_map_id) DO UPDATE SET revision = revision + 1`).run(projectId, mapId);
  for (const table of ["level_sections", "level_section_archives"]) {
    database.prepare(`UPDATE ${table} SET revision = revision + 1
      WHERE project_id = ? AND level_map_id = ? AND map_id = ?`).run(projectId, mapId, mapId);
  }
}

function changeLevels(projectId, input) {
  if (!input || !isProjectMapId(input.mapId)) levelError("A valid level ID is required.", 400);
  if (input.action === "add" && (Object.hasOwn(input, "width") || Object.hasOwn(input, "height")) &&
      (input.width !== generic.DEFAULT_DIMENSIONS.width || input.height !== generic.DEFAULT_DIMENSIONS.height)) {
    levelError(`New levels use a fixed map size of ${generic.DEFAULT_DIMENSIONS.width} × ${generic.DEFAULT_DIMENSIONS.height} pixels.`, 400);
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    const source = getMap.get(projectId, input.mapId);
    if (!source) levelError("Level not found in this game.", 404);
    if (database.prepare("SELECT 1 FROM world_sections WHERE project_id = ? AND map_id = ?").get(projectId, input.mapId)) {
      levelError("This legacy world section is not an independent level.");
    }
    if (database.prepare(`SELECT 1 FROM level_sections WHERE project_id = ? AND map_id = ? AND level_map_id != ?
        UNION ALL SELECT 1 FROM level_section_archives WHERE project_id = ? AND map_id = ? AND level_map_id != ? LIMIT 1`)
        .get(projectId, input.mapId, input.mapId, projectId, input.mapId, input.mapId)) {
      levelError("A section is part of its owning level, not an independent level.");
    }
    const problem = unsupportedReason(source, projectId, input.mapId);
    if (problem) levelError(problem);
    const project = database.prepare("SELECT model FROM projects WHERE project_id = ?").get(projectId);
    if (project && source.model !== project.model) levelError("The level model does not match this game.");
    if (source.deleted_at && input.action !== "recover") levelError("Recover this level before changing it.");
    if (input.action === "duplicate" &&
        database.prepare(`SELECT 1 FROM level_sections WHERE project_id = ? AND level_map_id = ? AND map_id != ?
          UNION ALL SELECT 1 FROM level_section_archives WHERE project_id = ? AND level_map_id = ? AND map_id != ? LIMIT 1`)
          .get(projectId, input.mapId, input.mapId, projectId, input.mapId, input.mapId)) {
      levelError("Duplicating a multi-section level is not supported; create a blank level instead.");
    }
    const now = new Date().toISOString();
    let mapId = input.mapId;
    if (["add", "duplicate", "rename"].includes(input.action)) {
      if (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 64 ||
          /[\u0000-\u001f\u007f]/.test(input.name)) levelError("Level name must be nonblank, at most 64 characters, without control characters.", 400);
      const name = input.name.trim();
      const original = JSON.parse(source.document_json);
      if (input.action === "rename") {
        saveMap.run(projectId, mapId, JSON.stringify({ ...original, name }), now, source.model);
        advanceLevelRevision(projectId, mapId);
      } else {
        mapId = `map-${randomUUID()}`;
        const document = input.action === "duplicate" ? { ...original, id: mapId, name }
          : source.model === generic.MODEL ? generic.createEmptyLevelDocument(mapId, name)
          : createEmptyLevelDocument(mapId, name);
        saveMap.run(projectId, mapId, JSON.stringify(document), now, source.model);
      }
    } else if (input.action === "start") {
      database.prepare("UPDATE project_levels SET starting_map_id = ? WHERE project_id = ?").run(mapId, projectId);
    } else if (input.action === "delete") {
      const active = database.prepare(`SELECT map_id FROM maps WHERE project_id = ? AND deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM world_sections s WHERE s.project_id = maps.project_id AND s.map_id = maps.map_id)
        AND NOT EXISTS (SELECT 1 FROM level_sections s WHERE s.project_id = maps.project_id
          AND s.map_id = maps.map_id AND s.level_map_id != maps.map_id)
        AND NOT EXISTS (SELECT 1 FROM level_section_archives s WHERE s.project_id = maps.project_id
          AND s.map_id = maps.map_id AND s.level_map_id != maps.map_id)`).all(projectId);
      if (active.length <= 1) levelError("A game must keep at least one active level.");
      const starting = database.prepare("SELECT starting_map_id FROM project_levels WHERE project_id = ?").get(projectId);
      if (starting?.starting_map_id === mapId) {
        const replacement = getMap.get(projectId, input.replacementMapId ?? "");
        if (!replacement || replacement.deleted_at || input.replacementMapId === mapId ||
            database.prepare("SELECT 1 FROM world_sections WHERE project_id = ? AND map_id = ?").get(projectId, input.replacementMapId) ||
            database.prepare(`SELECT 1 FROM level_sections WHERE project_id = ? AND map_id = ? AND level_map_id != ?
              UNION ALL SELECT 1 FROM level_section_archives WHERE project_id = ? AND map_id = ? AND level_map_id != ? LIMIT 1`)
              .get(projectId, input.replacementMapId, input.replacementMapId, projectId, input.replacementMapId,
                input.replacementMapId) ||
            unsupportedReason(replacement, projectId, input.replacementMapId)) {
          levelError("Choose a valid active replacement starting level in this game.");
        }
        database.prepare("UPDATE project_levels SET starting_map_id = ? WHERE project_id = ?")
          .run(input.replacementMapId, projectId);
      }
      database.prepare("UPDATE maps SET deleted_at = ? WHERE project_id = ? AND map_id = ?").run(now, projectId, mapId);
    } else if (input.action === "recover") {
      if (!source.deleted_at) levelError("This level is already active.");
      database.prepare("UPDATE maps SET deleted_at = NULL WHERE project_id = ? AND map_id = ?").run(projectId, mapId);
    } else levelError("Unknown level action.", 400);
    const result = { ...levelList(projectId), mapId };
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function worldPayload(projectId, worldId) {
  const world = database.prepare("SELECT * FROM worlds WHERE project_id = ? AND world_id = ?").get(projectId, worldId);
  if (!world) levelError("World not found.", 404);
  const sections = database.prepare(`SELECT s.*, m.document_json, m.model AS map_model, m.deleted_at
    FROM world_sections s LEFT JOIN maps m ON m.project_id = s.project_id AND m.map_id = s.map_id
    WHERE s.project_id = ? AND s.world_id = ? ORDER BY s.grid_y, s.grid_x`).all(projectId, worldId);
  if (sections.length !== 2) levelError("World membership is incomplete; no sections were changed.");
  return { projectId, worldId, name: world.name, model: world.model, revision: world.revision,
    sections: sections.map(row => {
      if (!row.document_json || row.deleted_at || row.map_model !== world.model) {
        levelError(`Section ${row.section_id} is missing, deleted, or incompatible.`);
      }
      sectionOrigin(row.grid_x, row.grid_y);
      const problem = unsupportedReason({ document_json: row.document_json, model: row.map_model }, projectId, row.map_id);
      if (problem) levelError(`Section ${row.section_id}: ${problem}`);
      const document = JSON.parse(row.document_json);
      if (document.bounds.width !== 2048 || document.bounds.height !== 2048) levelError(`Section ${row.section_id} has invalid bounds.`);
      return { sectionId: row.section_id, mapId: row.map_id, gridX: row.grid_x, gridY: row.grid_y,
        revision: row.revision, document };
    }) };
}

function createWorld(projectId, input) {
  if (!input || typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 64 ||
      /[\u0000-\u001f\u007f]/.test(input.name)) throw new TypeError("World name must be nonblank and at most 64 characters.");
  if (!isProjectMapId(input.sourceMapId) || !Array.isArray(input.positions) || input.positions.length !== 2) {
    throw new TypeError("A source level and exactly two section positions are required.");
  }
  for (const point of input.positions) sectionOrigin(point?.gridX, point?.gridY);
  const [a, b] = input.positions;
  if (Math.abs(a.gridX - b.gridX) + Math.abs(a.gridY - b.gridY) !== 1) {
    throw new TypeError("Section positions must be distinct and adjacent.");
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    const source = getMap.get(projectId, input.sourceMapId);
    if (!source || source.deleted_at || unsupportedReason(source, projectId, input.sourceMapId)) levelError("Choose an active supported source level.");
    if (database.prepare("SELECT 1 FROM world_sections WHERE project_id = ? AND map_id = ?").get(projectId, input.sourceMapId)) {
      levelError("Choose an independent source level.");
    }
    if (database.prepare(`SELECT 1 FROM level_sections WHERE project_id = ? AND map_id = ? AND level_map_id != ?
        UNION ALL SELECT 1 FROM level_section_archives WHERE project_id = ? AND map_id = ? AND level_map_id != ? LIMIT 1`)
        .get(projectId, input.sourceMapId, input.sourceMapId, projectId, input.sourceMapId, input.sourceMapId)) {
      levelError("Choose an independent source level.");
    }
    const worldId = `world-${randomUUID()}`;
    const name = input.name.trim();
    database.prepare("INSERT INTO worlds (project_id, world_id, name, model) VALUES (?, ?, ?, ?)")
      .run(projectId, worldId, name, source.model);
    const now = new Date().toISOString();
    for (const [index, position] of input.positions.entries()) {
      const sectionId = `section-${randomUUID()}`;
      const mapId = `map-${randomUUID()}`;
      const sectionName = `${name.slice(0, 52)} ${index + 1}`;
      const document = source.model === generic.MODEL ? generic.createDocument(mapId, sectionName)
        : createBlankDocument(mapId, sectionName);
      database.prepare("INSERT INTO maps (project_id, map_id, document_json, updated_at, model) VALUES (?, ?, ?, ?, ?)")
        .run(projectId, mapId, JSON.stringify(document), now, source.model);
      database.prepare(`INSERT INTO world_sections (project_id, world_id, section_id, map_id, grid_x, grid_y)
        VALUES (?, ?, ?, ?, ?, ?)`).run(projectId, worldId, sectionId, mapId, position.gridX, position.gridY);
    }
    const result = worldPayload(projectId, worldId);
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function saveWorld(projectId, worldId, input) {
  if (!input || !isProjectMapId(input.operationId) || !Number.isSafeInteger(input.revision) ||
      !Array.isArray(input.sections) || input.sections.length !== 2) throw new TypeError("Invalid workspace save.");
  const hash = sha256(Buffer.from(JSON.stringify(input)));
  database.exec("BEGIN IMMEDIATE");
  try {
    const receipt = database.prepare(`SELECT request_hash, result_json FROM world_save_receipts
      WHERE project_id = ? AND world_id = ? AND operation_id = ?`).get(projectId, worldId, input.operationId);
    if (receipt) {
      if (receipt.request_hash !== hash) levelError("Save operation ID was reused with different content.");
      database.exec("COMMIT");
      return JSON.parse(receipt.result_json);
    }
    const current = worldPayload(projectId, worldId);
    if (current.revision !== input.revision) levelError("World changed since it was opened. Reopen or reconcile before saving.");
    const seen = new Set();
    const catalog = assetCatalogFor(projectId, current.model);
    const updates = input.sections.map(section => {
      const existing = current.sections.find(item => item.sectionId === section.sectionId);
      if (!existing || seen.has(section.sectionId) || section.revision !== existing.revision ||
          section.document?.id !== existing.mapId) levelError("Section membership or revision changed; no sections were saved.");
      seen.add(section.sectionId);
      if (Buffer.byteLength(JSON.stringify(section.document)) > 2_000_000) throw new RangeError("Section exceeds the 2 MB limit.");
      const document = (current.model === generic.MODEL ? generic.validateFloorDocument : validateFloorDocument)(section.document, catalog);
      if (document.bounds.width !== 2048 || document.bounds.height !== 2048) throw new TypeError("Section dimensions must remain 2048 x 2048.");
      return { existing, document };
    });
    const now = new Date().toISOString();
    for (const { existing, document } of updates) {
      saveMap.run(projectId, existing.mapId, JSON.stringify(document), now, current.model);
      database.prepare(`UPDATE world_sections SET revision = revision + 1
        WHERE project_id = ? AND world_id = ? AND section_id = ?`).run(projectId, worldId, existing.sectionId);
    }
    database.prepare("UPDATE worlds SET revision = revision + 1 WHERE project_id = ? AND world_id = ?").run(projectId, worldId);
    const result = worldPayload(projectId, worldId);
    database.prepare("INSERT INTO world_save_receipts VALUES (?, ?, ?, ?, ?)").run(projectId, worldId, input.operationId, hash, JSON.stringify(result));
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

const server = createServer(async (request, response) => {
  if (!isLoopback(request.socket.remoteAddress)) {
    send(response, 403, { error: "Studio service accepts loopback connections only." });
    return;
  }
  if (request.method === "OPTIONS") {
    response.writeHead(204, { allow: "GET, PUT, POST, OPTIONS" });
    response.end();
    return;
  }
  const path = new URL(request.url, "http://127.0.0.1").pathname;
  const packageCreditsMatch = /^\/api\/projects\/([^/]+)\/export-credits$/.exec(path);
  const gamePackageMatch = /^\/api\/projects\/([^/]+)\/export-game$/.exec(path);
  if (packageCreditsMatch || gamePackageMatch) {
    const projectId = (packageCreditsMatch ?? gamePackageMatch)[1];
    try {
      if (!isProjectMapId(projectId)) throw new TypeError("Invalid project ID.");
      if (!projectExists(projectId)) levelError("Game not found.", 404);
      if (packageCreditsMatch) {
        if (request.method !== "GET") {
          send(response, 405, { error: "Method not allowed." });
          return;
        }
        const saved = database.prepare("SELECT name, author FROM projects WHERE project_id = ?").get(projectId);
        const suggestions = (values) => [...new Set(values.filter(value =>
          typeof value === "string" && value.trim()).map(value => value.trim()))];
        send(response, 200, {
          projectId,
          suggestions: {
            project: suggestions([saved?.name, ASTRAEUM_PROJECT_CREDIT]),
            author: suggestions([saved?.author])
          }
        });
        return;
      }
      if (request.method !== "POST") {
        send(response, 405, { error: "Method not allowed." });
        return;
      }
      const { bytes } = createSavedAstraeumPackage(projectId, await readJson(request, 1_000_000));
      response.writeHead(200, {
        "content-type": "application/zip",
        "content-length": bytes.length,
        "content-disposition": 'attachment; filename="astraeum-game.zip"',
        "cache-control": "no-store",
        "x-content-type-options": "nosniff"
      });
      response.end(bytes);
    } catch (error) {
      console.error(`Game package export failed for ${projectId}:`, error);
      send(response, error.status ?? (error instanceof TypeError || error instanceof SyntaxError ||
        error instanceof RangeError || error?.name === "ZodError" ? 400 : 500), { error: error.message });
    }
    return;
  }
  const levelSectionsMatch = /^\/api\/projects\/([^/]+)\/levels\/([^/]+)\/sections$/.exec(path);
  if (levelSectionsMatch) {
    const [, projectId, levelMapId] = levelSectionsMatch;
    try {
      if (!isProjectMapId(projectId) || !isProjectMapId(levelMapId)) throw new TypeError("Invalid project or level ID.");
      if (!projectExists(projectId)) levelError("Game not found.", 404);
      if (request.method === "GET") send(response, 200, levelSectionPayload(projectId, levelMapId));
      else if (request.method === "POST") send(response, 201, addLevelSection(projectId, levelMapId, await readJson(request)));
      else if (request.method === "PUT") send(response, 200,
        saveLevelSections(projectId, levelMapId, await readJson(request, MAX_LEVEL_SECTION_SAVE_BYTES)));
      else send(response, 405, { error: "Method not allowed." });
    } catch (error) {
      console.error(`Level section request failed for ${projectId}/${levelMapId}:`, error);
      send(response, error.status ?? (error instanceof TypeError || error instanceof SyntaxError || error instanceof RangeError ? 400 : 500),
        { error: error.message });
    }
    return;
  }
  const worldMatch = /^\/api\/projects\/([^/]+)\/worlds(?:\/([^/]+))?$/.exec(path);
  if (worldMatch) {
    const [, projectId, worldId] = worldMatch;
    try {
      if (!isProjectMapId(projectId) || (worldId && !isProjectMapId(worldId))) throw new TypeError("Invalid project or world ID.");
      if (!projectExists(projectId)) levelError("Game not found.", 404);
      if (!worldId && request.method === "GET") {
        send(response, 200, { worlds: database.prepare("SELECT world_id AS worldId, name, model FROM worlds WHERE project_id = ? ORDER BY name, world_id").all(projectId) });
      } else if (!worldId && request.method === "POST") {
        send(response, 201, createWorld(projectId, await readJson(request)));
      } else if (worldId && request.method === "GET") {
        send(response, 200, worldPayload(projectId, worldId));
      } else if (worldId && request.method === "PUT") {
        send(response, 200, saveWorld(projectId, worldId, await readJson(request, 4_100_000)));
      } else send(response, 405, { error: "Method not allowed." });
    } catch (error) {
      console.error(`World request failed for ${projectId}:`, error);
      send(response, error.status ?? (error instanceof TypeError || error instanceof SyntaxError || error instanceof RangeError ? 400 : 500), { error: error.message });
    }
    return;
  }
  const levelsMatch = /^\/api\/projects\/([^/]+)\/levels$/.exec(path);
  if (levelsMatch) {
    const projectId = levelsMatch[1];
    if (!isProjectMapId(projectId)) {
      send(response, 400, { error: "Invalid project ID." });
      return;
    }
    try {
      if (!projectExists(projectId)) levelError("Game not found.", 404);
      if (request.method === "GET") send(response, 200, levelList(projectId));
      else if (request.method === "POST") send(response, 200, changeLevels(projectId, await readJson(request)));
      else send(response, 405, { error: "Method not allowed." });
    } catch (error) {
      console.error(`Level request failed for ${projectId}:`, error);
      send(response, error.status ?? (error instanceof SyntaxError || error instanceof TypeError ? 400 : 500),
        { error: error.message });
    }
    return;
  }
  if (path === "/api/projects") {
    if (request.method === "POST") {
      try {
        send(response, 201, createProject(await readJson(request)));
      } catch (error) {
        console.error("Could not create game:", error);
        send(response, error.status ?? (error instanceof TypeError || error instanceof SyntaxError || error instanceof RangeError ? 400 : 500),
          { error: error.message });
      }
      return;
    }
    if (request.method !== "GET") {
      send(response, 405, { error: "Method not allowed." });
      return;
    }
    try {
      const maps = listMaps.all().filter(row =>
        !database.prepare("SELECT 1 FROM world_sections WHERE project_id = ? AND map_id = ?").get(row.project_id, row.map_id) &&
        !database.prepare(`SELECT 1 FROM level_sections WHERE project_id = ? AND map_id = ? AND level_map_id != ?
          UNION ALL SELECT 1 FROM level_section_archives WHERE project_id = ? AND map_id = ? AND level_map_id != ? LIMIT 1`)
          .get(row.project_id, row.map_id, row.map_id, row.project_id, row.map_id, row.map_id)).map(row => {
        const reason = unsupportedReason(row, row.project_id, row.map_id);
        const canAdopt = row.model === null && documentProblem(row, row.project_id, row.map_id) === null;
        return { projectId: row.project_id, mapId: row.map_id, model: row.model,
          name: reason === null ? JSON.parse(row.document_json).name : row.map_id,
          starting: database.prepare("SELECT starting_map_id FROM project_levels WHERE project_id = ?").get(row.project_id)?.starting_map_id === row.map_id,
          project: database.prepare("SELECT name, author FROM projects WHERE project_id = ?").get(row.project_id) ?? null,
          updatedAt: row.updated_at, supported: reason === null, canAdopt, reason };
      });
      send(response, 200, { maps });
    } catch (error) {
      console.error("Could not list saved designs:", error);
      send(response, 500, { error: "Could not list saved designs from SQLite." });
    }
    return;
  }
  const assetMatch = /^\/api\/projects\/([^/]+)\/assets(?:\/(preview|asset-[a-f0-9]{64}))?$/.exec(path);
  if (assetMatch) {
    const projectId = assetMatch[1];
    const action = assetMatch[2];
    if (!isProjectMapId(projectId)) {
      send(response, 400, { error: "Invalid project ID." });
      return;
    }
    if (!projectExists(projectId)) {
      send(response, 404, { error: "Project not found." });
      return;
    }
    try {
      if (request.method === "GET" && !action) {
        send(response, 200, { assets: rowsForProjectAssets(projectId) });
        return;
      }
      if (request.method === "GET" && action?.startsWith("asset-")) {
        const row = database.prepare("SELECT import_id, sha256 FROM project_assets WHERE project_id = ? AND asset_id = ?")
          .get(projectId, action);
        if (!row) {
          send(response, 404, { error: "Imported image not found in this project." });
          return;
        }
        const assetsDirectory = projectAssetsDirectory(projectId);
        const file = resolve(assetsDirectory, row.import_id, `${action}.png`);
        if (relative(assetsDirectory, file).startsWith("..")) throw new Error("Imported image path escaped the project.");
        const bytes = readFileSync(file);
        if (sha256(bytes) !== row.sha256) throw new Error("Imported image bytes no longer match their recorded SHA-256 hash.");
        sendPng(response, bytes);
        return;
      }
      if (request.method !== "POST" || !["preview", undefined].includes(action)) {
        send(response, 405, { error: "Method not allowed." });
        return;
      }
      const input = await readJson(request, 24_000_000);
      if (action === "preview") {
        const upload = parseAssetUpload(input.filename, decodeUpload(input.data));
        const states = upload.archive ? upload.metadata.states.map(state => ({
          name: state.character.name,
          width: state.character.size.width,
          height: state.character.size.height,
          directions: Object.keys(state.frames.rotations),
          animations: Object.keys(state.frames.animations)
        })) : [];
        send(response, 200, {
          filename: upload.filename,
          archive: upload.archive,
          archiveHash: upload.archiveHash,
          animations: upload.animations,
          states,
          images: upload.images.map(image => ({
            path: image.path,
            stateName: image.stateName,
            direction: image.direction,
            width: image.width,
            height: image.height,
            data: image.bytes.toString("base64")
          }))
        });
        return;
      }
      const result = importAssets(projectId, input);
      send(response, 201, result);
    } catch (error) {
      console.error(`Asset import request failed for ${projectId}:`, error);
      send(response, error.status ?? (error instanceof TypeError || error instanceof SyntaxError ? 400 : 500),
        { error: error.message });
    }
    return;
  }
  const match = /^\/api\/projects\/([^/]+)\/maps\/([^/]+)(\/model\/astraeum-floor-v2)?$/.exec(path);
  if (!match) {
    send(response, 404, { error: "Map not found." });
    return;
  }
  const [, projectId, mapId] = match;
  if (!isProjectMapId(projectId) || !isProjectMapId(mapId)) {
    send(response, 400, { error: "Invalid project or map ID." });
    return;
  }
  if (database.prepare("SELECT 1 FROM world_sections WHERE project_id = ? AND map_id = ?").get(projectId, mapId)) {
    send(response, 409, { error: "This map belongs to a preserved legacy world workspace, not an independent level." });
    return;
  }
  if (database.prepare(`SELECT 1 FROM level_sections WHERE project_id = ? AND map_id = ? AND level_map_id != ?
      UNION ALL SELECT 1 FROM level_section_archives WHERE project_id = ? AND map_id = ? AND level_map_id != ? LIMIT 1`)
      .get(projectId, mapId, mapId, projectId, mapId, mapId)) {
    send(response, 409, { error: "This map is a level section; edit and save it through its owning level." });
    return;
  }
  if (match[3]) {
    if (request.method !== "POST") {
      send(response, 405, { error: "Method not allowed." });
      return;
    }
    let active = false;
    try {
      database.exec("BEGIN IMMEDIATE");
      active = true;
      const row = getMap.get(projectId, mapId);
      if (row?.deleted_at) {
        database.exec("ROLLBACK");
        send(response, 409, { error: "This level is deleted. Recover it from the Levels panel." });
        return;
      }
      if (!row || (row.model !== null && row.model !== ASTRAEUM_MODEL)) {
        database.exec("ROLLBACK");
        send(response, 409, { error: "Only an untyped saved Astraeum-compatible map can be assigned this model." });
        return;
      }
      const problem = documentProblem(row, projectId, mapId);
      if (problem) {
        database.exec("ROLLBACK");
        send(response, 409, { error: `${problem} The saved design was left untouched.` });
        return;
      }
      database.prepare("UPDATE maps SET model = ? WHERE project_id = ? AND map_id = ?")
        .run(ASTRAEUM_MODEL, projectId, mapId);
      database.exec("COMMIT");
      send(response, 200, { projectId, mapId, model: ASTRAEUM_MODEL });
    } catch (error) {
      if (active) database.exec("ROLLBACK");
      console.error("Could not assign model:", error);
      send(response, 500, { error: "Could not assign the model in SQLite." });
    }
    return;
  }
  if (request.method === "GET") {
    try {
      const row = getMap.get(projectId, mapId);
      if (row?.deleted_at) {
        send(response, 409, { error: "This level is deleted. Recover it from the Levels panel." });
        return;
      }
      const migrations = migrationsFor(projectId, mapId);
      const reason = row && unsupportedReason(row, projectId, mapId);
      if (reason) {
        send(response, 409, {
          error: `${reason} The saved design was left untouched.`,
          migrations
        });
        return;
      }
      send(response, 200, row
        ? { projectId, mapId, model: row.model,
          project: database.prepare("SELECT name, author FROM projects WHERE project_id = ?").get(projectId) ?? null,
          document: JSON.parse(row.document_json), updatedAt: row.updated_at, migrations }
        : { projectId, mapId, model: null, document: null, updatedAt: null, migrations });
    } catch (error) {
      console.error("Could not load design:", error);
      send(response, 500, { error: "Could not load the design from SQLite." });
    }
    return;
  }
  if (request.method !== "PUT") {
    send(response, 405, { error: "Method not allowed." });
    return;
  }
  if (database.prepare(`SELECT 1 FROM level_sections WHERE project_id = ? AND level_map_id = ?
      AND map_id != ?
      UNION ALL SELECT 1 FROM level_section_archives WHERE project_id = ? AND level_map_id = ?
      AND map_id != ? LIMIT 1`).get(projectId, mapId, mapId, projectId, mapId, mapId)) {
    send(response, 409, { error: "This level has multiple sections; save all of them transactionally through the level sections endpoint." });
    return;
  }
  try {
    let body = "";
    for await (const chunk of request) {
      body += chunk;
      if (Buffer.byteLength(body) > 2_000_000) {
        send(response, 413, { error: "Map document exceeds the 2 MB limit." });
        return;
      }
    }
    const parsed = JSON.parse(body);
    if (parsed.projectId !== projectId || parsed.document?.id !== mapId) {
      throw new TypeError("The project ID and document ID must match the request path.");
    }
    if (![ASTRAEUM_MODEL, generic.MODEL].includes(parsed.model)) {
      throw new TypeError("An explicit supported model is required.");
    }
    const catalog = assetCatalogFor(projectId, parsed.model);
    const document = (parsed.model === generic.MODEL ? generic.validateFloorDocument : validateFloorDocument)(parsed.document, catalog);
    if (document.playableBoundary) {
      validatePlayableBoundaryForSections(document.playableBoundary, [{ gridX: 0, gridY: 0, document }]);
    }
    let inTransaction = false;
    try {
      database.exec("BEGIN IMMEDIATE");
      inTransaction = true;
      const existing = getMap.get(projectId, mapId);
      if (existing?.deleted_at) {
        database.exec("ROLLBACK");
        send(response, 409, { error: "Cannot save a deleted level. Recover it first." });
        return;
      }
      const project = database.prepare("SELECT model FROM projects WHERE project_id = ?").get(projectId);
      if (project && project.model !== parsed.model) {
        database.exec("ROLLBACK");
        send(response, 409, { error: "The project model cannot change. Create a separate project instead." });
        return;
      }
      if (parsed.model === generic.MODEL && (!existing || existing.model !== parsed.model)) {
        database.exec("ROLLBACK");
        send(response, 409, { error: "Create generic projects through New Game; a saved map's model cannot change." });
        return;
      }
      const reason = existing && unsupportedReason(existing, projectId, mapId);
      if (reason || (existing && existing.model !== parsed.model)) {
        database.exec("ROLLBACK");
        send(response, 409, { error: `${reason ?? "The saved model cannot change."} Refusing to overwrite it.` });
        return;
      }
      saveMap.run(projectId, mapId, JSON.stringify(document), new Date().toISOString(), parsed.model);
      if (existing) advanceLevelRevision(projectId, mapId);
      ensureStartingLevel(projectId, mapId);
      database.exec("COMMIT");
    } catch (error) {
      if (inTransaction) database.exec("ROLLBACK");
      console.error("Could not save design:", error);
      send(response, 500, { error: "Could not save the design to SQLite." });
      return;
    }
    send(response, 200, { projectId, mapId, model: parsed.model, document, saved: true });
  } catch (error) {
    send(response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.on("error", error => {
  console.error("Studio API failed:", error);
  process.exitCode = 1;
});
server.listen(port, "127.0.0.1", () => {
  console.log(`Studio map service listening on http://127.0.0.1:${port}`);
});

function close() {
  server.close(() => {
    database.close();
    process.exit(0);
  });
}
process.on("SIGINT", close);
process.on("SIGTERM", close);
