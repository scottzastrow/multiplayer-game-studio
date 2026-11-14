import { createServer } from "node:http";
import { mkdirSync, writeFileSync, readFileSync, rmSync, renameSync, lstatSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  DESIGN_FORMAT_VERSION,
  migrateFloorDocumentV1,
  validateFloorDocument
} from "../games/astraeum-tower/src/project.js";
import { ASSET_CATALOG } from "../games/astraeum-tower/src/catalog.js";
import { ASTRAEUM_PROJECT_ID, ASTRAEUM_FLOOR_1_MAP_ID, ASTRAEUM_MODEL, isProjectMapId } from "./project-identity.js";
import * as generic from "../games/generic-grid-v1/src/project.js";
import { parseAssetUpload, sha256, validateImportFields } from "./asset-import.js";
import { importedAssetDefinition } from "./project-assets.js";

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

const getMap = database.prepare("SELECT document_json, updated_at, model FROM maps WHERE project_id = ? AND map_id = ?");
const listMaps = database.prepare("SELECT project_id, map_id, document_json, updated_at, model FROM maps ORDER BY project_id, map_id");
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
      const maps = listMaps.all().map(row => {
        const reason = unsupportedReason(row, row.project_id, row.map_id);
        const canAdopt = row.model === null && documentProblem(row, row.project_id, row.map_id) === null;
        return { projectId: row.project_id, mapId: row.map_id, model: row.model,
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
    let inTransaction = false;
    try {
      database.exec("BEGIN IMMEDIATE");
      inTransaction = true;
      const existing = getMap.get(projectId, mapId);
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
