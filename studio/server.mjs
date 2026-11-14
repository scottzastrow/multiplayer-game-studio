import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  DESIGN_FORMAT_VERSION,
  migrateFloorDocumentV1,
  validateFloorDocument
} from "../games/astraeum-tower/src/project.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataDirectory = resolve(root, "studio", "data");
const databasePath = resolve(root, process.env.STUDIO_DATABASE_PATH ?? "studio/data/studio.sqlite");
const relativeDatabase = relative(dataDirectory, databasePath);
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
  CREATE TABLE IF NOT EXISTS maps (
    id TEXT PRIMARY KEY,
    document_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS map_backups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    map_id TEXT NOT NULL,
    format_version INTEGER,
    document_json TEXT NOT NULL,
    original_updated_at TEXT,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    map_id TEXT NOT NULL,
    from_version INTEGER,
    to_version INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('migrated', 'failed')),
    backup_id INTEGER REFERENCES map_backups(id),
    report_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);
const getMap = database.prepare("SELECT document_json, updated_at FROM maps WHERE id = ?");
const saveMap = database.prepare(`
  INSERT INTO maps (id, document_json, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET document_json = excluded.document_json, updated_at = excluded.updated_at
`);
const insertBackup = database.prepare(`
  INSERT INTO map_backups (map_id, format_version, document_json, original_updated_at, reason, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const insertMigration = database.prepare(`
  INSERT INTO migrations (map_id, from_version, to_version, status, backup_id, report_json, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const listMigrations = database.prepare(`
  SELECT id, from_version, to_version, status, backup_id, report_json, created_at
  FROM migrations WHERE map_id = ? ORDER BY id DESC LIMIT 5
`);
const lastFailure = database.prepare(`
  SELECT report_json FROM migrations WHERE map_id = ? AND status = 'failed' ORDER BY id DESC LIMIT 1
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
  const rows = database.prepare("SELECT id, document_json, updated_at FROM maps").all();
  for (const row of rows) {
    const version = storedFormat(row.document_json);
    if (version === DESIGN_FORMAT_VERSION) continue;
    const now = new Date().toISOString();
    try {
      if (version !== 1) throw new TypeError(`No migration exists from format ${String(version)}.`);
      const { document, report } = migrateFloorDocumentV1(JSON.parse(row.document_json));
      database.exec("BEGIN IMMEDIATE");
      try {
        const backup = insertBackup.run(row.id, version, row.document_json, row.updated_at,
          `before migration to format ${DESIGN_FORMAT_VERSION}`, now);
        insertMigration.run(row.id, version, DESIGN_FORMAT_VERSION, "migrated",
          backup.lastInsertRowid, JSON.stringify(report), now);
        saveMap.run(row.id, JSON.stringify(document), now);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      console.log(`Migrated ${row.id} from format ${version} to ${DESIGN_FORMAT_VERSION}; ` +
        `original kept in map_backups.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const report = JSON.stringify({ error: message });
      if (lastFailure.get(row.id)?.report_json !== report) {
        insertMigration.run(row.id, version, DESIGN_FORMAT_VERSION, "failed", null, report, now);
      }
      console.error(`Could not migrate ${row.id}: ${message} The stored design was left untouched.`);
    }
  }
}
migrateStoredMaps();

function migrationsFor(id) {
  return listMigrations.all(id).map(row => ({
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

const server = createServer(async (request, response) => {
  if (!isLoopback(request.socket.remoteAddress)) {
    send(response, 403, { error: "Studio service accepts loopback connections only." });
    return;
  }
  if (request.method === "OPTIONS") {
    response.writeHead(204, { allow: "GET, PUT, OPTIONS" });
    response.end();
    return;
  }
  const match = /^\/api\/maps\/([a-z0-9][a-z0-9._:-]{0,127})$/.exec(
    new URL(request.url, "http://127.0.0.1").pathname
  );
  if (!match || match[1] !== "astraeum-tower-floor-1") {
    send(response, 404, { error: "Map not found." });
    return;
  }
  if (request.method === "GET") {
    const row = getMap.get(match[1]);
    const migrations = migrationsFor(match[1]);
    if (row && storedFormat(row.document_json) !== DESIGN_FORMAT_VERSION) {
      send(response, 409, {
        error: "The saved design could not be migrated to format 2 and was left untouched.",
        migrations
      });
      return;
    }
    send(response, 200, row
      ? { document: JSON.parse(row.document_json), updatedAt: row.updated_at, migrations }
      : { document: null, updatedAt: null, migrations });
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
    const existing = getMap.get(match[1]);
    if (existing && storedFormat(existing.document_json) !== DESIGN_FORMAT_VERSION) {
      send(response, 409, { error: "The saved design has not been migrated; refusing to overwrite it." });
      return;
    }
    const parsed = JSON.parse(body);
    const document = validateFloorDocument(parsed.document);
    saveMap.run(document.id, JSON.stringify(document), new Date().toISOString());
    send(response, 200, { document, saved: true });
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
