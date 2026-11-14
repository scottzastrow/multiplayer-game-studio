import { createServer } from "node:http";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  DESIGN_FORMAT_VERSION,
  migrateFloorDocumentV1,
  validateFloorDocument
} from "../games/astraeum-tower/src/project.js";
import { ASTRAEUM_PROJECT_ID, ASTRAEUM_FLOOR_1_MAP_ID, ASTRAEUM_MODEL, isProjectMapId } from "./project-identity.js";
import * as generic from "../games/generic-grid-v1/src/project.js";

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
    (row.model === generic.MODEL ? generic.validateFloorDocument : validateFloorDocument)(document);
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

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > 2_000_000) throw new RangeError("Request exceeds the 2 MB limit.");
  }
  return JSON.parse(body);
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
    const document = (parsed.model === generic.MODEL ? generic.validateFloorDocument : validateFloorDocument)(parsed.document);
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
