import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, readdir, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createFloorDocument, FLOOR1_GRID, migrateFloorDocumentV1 } from "../../games/astraeum-tower/src/project.js";
import { ASTRAEUM_PROJECT_ID as projectId, ASTRAEUM_FLOOR_1_MAP_ID as mapId, ASTRAEUM_MODEL as model } from "../project-identity.js";
import * as generic from "../../games/generic-grid-v1/src/project.js";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const dataDir = resolve(root, "studio", "data");
await mkdir(dataDir, { recursive: true });
const testDir = await mkdtemp(resolve(dataDir, "persistence-test-"));
let service;
let output = "";

async function freePort() {
  const listener = createServer();
  await new Promise((ok, fail) => listener.once("error", fail).listen(0, "127.0.0.1", ok));
  const port = listener.address().port;
  await new Promise((ok, fail) => listener.close(error => error ? fail(error) : ok()));
  return port;
}

async function start(dbPath) {
  const port = await freePort();
  output = "";
  service = spawn(process.execPath, ["--no-warnings", resolve(root, "studio", "server.mjs")], {
    cwd: root,
    env: { ...process.env, STUDIO_API_PORT: String(port), STUDIO_DATABASE_PATH: relative(root, dbPath),
      STUDIO_GAMES_PATH: relative(root, resolve(testDir, "games")) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  service.stdout.on("data", chunk => { output += chunk; });
  service.stderr.on("data", chunk => { output += chunk; });
  const origin = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (service.exitCode !== null) throw new Error(`Service exited: ${output}`);
    try {
      const response = await fetch(`${origin}/api/projects/${projectId}/maps/${mapId}`);
      if (response.status === 200 || response.status === 409) return origin;
    } catch {}
    await delay(100);
  }
  throw new Error(`Service did not start: ${output}`);
}

async function stop() {
  if (!service || service.exitCode !== null || service.signalCode !== null) return;
  await new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error("Service did not stop.")), 5000);
    service.once("exit", () => { clearTimeout(timer); ok(); });
    service.kill("SIGTERM");
  });
}

function seed(path, json, id = mapId) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE maps (id TEXT PRIMARY KEY, document_json TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE map_backups (id INTEGER PRIMARY KEY AUTOINCREMENT, map_id TEXT NOT NULL,
      format_version INTEGER, document_json TEXT NOT NULL, original_updated_at TEXT, reason TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, map_id TEXT NOT NULL, from_version INTEGER,
      to_version INTEGER NOT NULL, status TEXT NOT NULL, backup_id INTEGER REFERENCES map_backups(id),
      report_json TEXT NOT NULL, created_at TEXT NOT NULL);
  `);
  db.prepare("INSERT INTO maps VALUES (?, ?, ?)").run(id, json, "2025-01-01");
  db.prepare("INSERT INTO map_backups VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(41, id, 0, "original backup bytes", "2024-01-01", "old backup", "2025-01-01");
  db.prepare("INSERT INTO migrations VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(51, id, 0, 1, "migrated", 41, '{"previous":true}', "2025-01-01");
  db.prepare("UPDATE sqlite_sequence SET seq = 100 WHERE name IN ('map_backups', 'migrations')").run();
  db.close();
}

function url(origin, project, map) {
  return `${origin}/api/projects/${project}/maps/${map}`;
}

async function request(address, method = "GET", body) {
  const response = await fetch(address, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  });
  return { status: response.status, body: await response.json() };
}

try {
  const dbPath = resolve(testDir, "legacy.sqlite");
  const terrain = FLOOR1_GRID.map(row => row.replaceAll("#", "."));
  const walls = [];
  FLOOR1_GRID.forEach((row, y) => [...row].forEach((cell, x) => {
    if (cell === "#") walls.push({ id: `wall-${x}-${y}`, x: x * 32, y: y * 32, width: 32, height: 32 });
  }));
  walls.push({ id: "off-grid-wall", x: 245, y: 101, width: 32, height: 32 });
  const legacy = JSON.stringify({ formatVersion: 1, id: mapId, name: "Damp Corridors", cellSize: 32, terrain, walls });
  seed(dbPath, legacy);
  let origin = await start(dbPath);
  const address = url(origin, projectId, mapId);
  const loaded = await request(address);
  assert.equal(loaded.status, 200);
  assert.equal(loaded.body.projectId, projectId);
  assert.equal(loaded.body.mapId, mapId);
  assert.equal(loaded.body.document.id, mapId);
  assert.equal(loaded.body.document.formatVersion, 2);
  assert.deepEqual(loaded.body.document, migrateFloorDocumentV1(JSON.parse(legacy)).document);
  assert.equal(loaded.body.document.objects.find(object => object.id === "off-grid-wall").type, "collision");
  assert.equal(loaded.body.migrations.length, 2);
  const db = new DatabaseSync(dbPath);
  const backups = db.prepare("SELECT * FROM map_backups ORDER BY id").all();
  const history = db.prepare("SELECT * FROM migrations ORDER BY id").all();
  assert.equal(backups.length, 2);
  assert.deepEqual([backups[0].id, backups[0].project_id, backups[0].map_id, backups[0].document_json],
    [41, projectId, mapId, "original backup bytes"]);
  assert.equal(backups[1].document_json, legacy);
  assert.equal(backups[1].id, 101);
  assert.equal(backups[1].original_updated_at, "2025-01-01");
  assert.deepEqual([history[0].id, history[0].backup_id, history[0].report_json], [51, 41, '{"previous":true}']);
  assert.equal(history[1].backup_id, backups[1].id);
  assert.equal(history[1].id, 101);
  db.close();

  const first = loaded.body.document;
  const second = structuredClone(first);
  second.objects.reverse();
  const otherMap = structuredClone(first);
  otherMap.id = "second-map";
  assert.equal((await request(address, "PUT", { projectId, document: first })).status, 400);
  assert.equal((await request(address, "PUT", { projectId, model, document: first })).status, 200);
  assert.equal((await request(url(origin, "other-project", mapId), "PUT",
    { projectId: "other-project", model, document: second })).status, 200);
  assert.equal((await request(url(origin, projectId, "second-map"), "PUT",
    { projectId, model, document: otherMap })).status, 200);
  assert.equal((await request(address, "PUT", { projectId: "other-project", model, document: second })).status, 400);
  assert.equal((await request(address, "PUT", { projectId, model, document: otherMap })).status, 400);
  for (const [project, map] of [["Bad", mapId], ["bad_id", mapId], [projectId, "bad."],
    [projectId, "a".repeat(129)], ["%2e%2e", mapId], [projectId, "%2f"]]) {
    assert.notEqual((await request(url(origin, project, map))).status, 200);
    assert.notEqual((await request(url(origin, project, map), "PUT", { projectId, model, document: first })).status, 200);
  }
  assert.deepEqual((await request(url(origin, "other-project", mapId))).body.migrations, []);
  await stop();
  origin = await start(dbPath);
  assert.deepEqual((await request(url(origin, projectId, mapId))).body.document, first);
  assert.deepEqual((await request(url(origin, "other-project", mapId))).body.document, second);
  assert.deepEqual((await request(url(origin, projectId, "second-map"))).body.document, otherMap);
  await stop();

  const v2Path = resolve(testDir, "format2.sqlite");
  const v2Json = JSON.stringify(createFloorDocument(), null, 2);
  seed(v2Path, v2Json);
  origin = await start(v2Path);
  assert.deepEqual((await request(url(origin, projectId, mapId))).body.document, JSON.parse(v2Json));
  await stop();
  const v2db = new DatabaseSync(v2Path);
  assert.equal(v2db.prepare("SELECT document_json FROM maps").get().document_json, v2Json);
  assert.equal(v2db.prepare("SELECT count(*) AS count FROM map_backups").get().count, 1);
  v2db.close();

  const failedPath = resolve(testDir, "failed.sqlite");
  const invalidLegacy = JSON.stringify({ formatVersion: 1, id: mapId });
  seed(failedPath, invalidLegacy);
  origin = await start(failedPath);
  assert.equal((await request(url(origin, projectId, mapId))).status, 409);
  assert.equal((await request(url(origin, projectId, mapId), "PUT",
    { projectId, model, document: createFloorDocument() })).status, 409);
  await stop();
  const failedDb = new DatabaseSync(failedPath);
  assert.equal(failedDb.prepare("SELECT document_json FROM maps").get().document_json, invalidLegacy);
  assert.equal(failedDb.prepare("SELECT count(*) AS count FROM map_backups").get().count, 1);
  assert.equal(failedDb.prepare("SELECT status FROM migrations ORDER BY id DESC").get().status, "failed");
  failedDb.close();

  const scopedPath = resolve(testDir, "untyped-scoped.sqlite");
  const scopedDb = new DatabaseSync(scopedPath);
  scopedDb.exec(`CREATE TABLE maps (project_id TEXT NOT NULL, map_id TEXT NOT NULL, document_json TEXT NOT NULL,
    updated_at TEXT NOT NULL, PRIMARY KEY (project_id, map_id))`);
  scopedDb.prepare("INSERT INTO maps VALUES (?, ?, ?, ?)").run(projectId, mapId, v2Json, "old");
  scopedDb.prepare("INSERT INTO maps VALUES (?, ?, ?, ?)").run("unknown-project", mapId, v2Json, "old");
  scopedDb.prepare("INSERT INTO maps VALUES (?, ?, ?, ?)").run("broken-project", "broken-map", '{"formatVersion":2}', "old");
  scopedDb.close();
  origin = await start(scopedPath);
  const typedDb = new DatabaseSync(scopedPath);
  typedDb.prepare("INSERT INTO maps (project_id, map_id, document_json, updated_at, model) VALUES (?, ?, ?, ?, ?)")
    .run("foreign-project", mapId, v2Json, "old", "other-game");
  typedDb.close();
  const listed = (await request(`${origin}/api/projects`)).body.maps;
  assert.equal(listed.find(entry => entry.projectId === projectId).supported, true);
  assert.match(listed.find(entry => entry.projectId === "unknown-project").reason, /unknown game model/);
  assert.equal(listed.find(entry => entry.projectId === "unknown-project").canAdopt, true);
  assert.equal(listed.find(entry => entry.projectId === "broken-project").canAdopt, false);
  assert.equal(listed.find(entry => entry.projectId === "foreign-project").canAdopt, false);
  assert.equal((await request(`${url(origin, "foreign-project", mapId)}/model/${model}`, "POST")).status, 409);
  assert.equal((await request(url(origin, "foreign-project", mapId), "PUT",
    { projectId: "foreign-project", model, document: createFloorDocument() })).status, 409);
  assert.equal((await request(url(origin, "unknown-project", mapId))).status, 409);
  assert.equal((await request(url(origin, "unknown-project", mapId), "PUT",
    { projectId: "unknown-project", model, document: createFloorDocument() })).status, 409);
  assert.equal((await request(`${url(origin, "broken-project", "broken-map")}/model/${model}`, "POST")).status, 409);
  assert.equal((await request(`${url(origin, "unknown-project", mapId)}/model/${model}`, "POST")).status, 200);
  assert.deepEqual((await request(url(origin, "unknown-project", mapId))).body.document, JSON.parse(v2Json));
  await stop();
  const checkScoped = new DatabaseSync(scopedPath);
  assert.equal(checkScoped.prepare("SELECT document_json FROM maps WHERE project_id = ?").get("unknown-project").document_json, v2Json);
  assert.equal(checkScoped.prepare("SELECT model FROM maps WHERE project_id = ?").get("unknown-project").model, model);
  assert.equal(checkScoped.prepare("SELECT model FROM maps WHERE project_id = ?").get("foreign-project").model, "other-game");
  checkScoped.close();

  const creationPath = resolve(testDir, "creation.sqlite");
  origin = await start(creationPath);
  const creation = { name: "Generic One", author: "Disposable credits", width: 640, height: 480, model: generic.MODEL };
  for (const patch of [
    { name: "" }, { name: "   " }, { name: "a".repeat(65) }, { name: "bad\nname" },
    { author: "" }, { author: "a".repeat(129) }, { width: 63 }, { width: 65 },
    { height: 2080 }, { width: "640" }, { height: 64.5 }, { model: "astraeum-floor-v2" }, { extra: true }
  ]) {
    assert.equal((await request(`${origin}/api/projects`, "POST", { ...creation, ...patch })).status, 400);
  }
  const created = await request(`${origin}/api/projects`, "POST", creation);
  assert.equal(created.status, 201);
  const one = created.body;
  assert.notEqual(one.projectId, one.model, "project identity is not its model");
  assert.equal(one.document.objects.length, 2, "blank terrain and only two required player starts");
  assert.deepEqual(generic.playStartProblems(one.document), []);
  const gamesPath = resolve(testDir, "games");
  const projectPath = resolve(gamesPath, one.projectId);
  const metadata = JSON.parse(await readFile(resolve(projectPath, "project.json"), "utf8"));
  assert.deepEqual(metadata.mapIds, [one.mapId]);
  assert.equal(metadata.author, creation.author);
  assert.equal(Object.hasOwn(metadata, "document"), false, "metadata is not an independently editable saved map");
  assert.deepEqual((await readdir(projectPath)).sort(), ["assets", "project.json", "src"]);
  const beforeDuplicate = await readdir(gamesPath);
  assert.equal((await request(`${origin}/api/projects`, "POST", { ...creation, name: " generic ONE " })).status, 409);
  assert.deepEqual(await readdir(gamesPath), beforeDuplicate);
  const two = (await request(`${origin}/api/projects`, "POST", { ...creation, name: "Generic Two", width: 64, height: 64 })).body;
  assert.notEqual(one.projectId, two.projectId);
  assert.notEqual(one.mapId, two.mapId);
  assert.deepEqual(generic.playStartProblems(two.document), [], "minimum dimensions still have two safe starts");
  generic.createDocument("maximum-map", "Maximum map", { width: 2048, height: 2048 });
  const edited = structuredClone(one.document);
  edited.objects.push(generic.createDesignObject("block-1", "generic-block", { x: 64, y: 64 }, 0));
  assert.equal((await request(url(origin, one.projectId, one.mapId), "PUT",
    { projectId: one.projectId, model: generic.MODEL, document: edited })).status, 200);
  assert.equal((await request(url(origin, one.projectId, one.mapId), "PUT",
    { projectId: one.projectId, model, document: createFloorDocument() })).status, 400);
  const borrowed = structuredClone(edited);
  borrowed.objects[2].assetId = "wall-damp-stone";
  assert.equal((await request(url(origin, one.projectId, one.mapId), "PUT",
    { projectId: one.projectId, model: generic.MODEL, document: borrowed })).status, 400);
  const failureDb = new DatabaseSync(creationPath);
  failureDb.exec(`CREATE TRIGGER fail_creation BEFORE INSERT ON maps BEGIN SELECT RAISE(ABORT, 'Injected creation failure'); END`);
  const beforeFailure = await readdir(gamesPath);
  assert.equal((await request(`${origin}/api/projects`, "POST", { ...creation, name: "Failed creation" })).status, 500);
  assert.deepEqual(await readdir(gamesPath), beforeFailure, "failed DB insert removes all newly generated files");
  assert.equal(failureDb.prepare("SELECT count(*) AS count FROM projects").get().count, 2, "failed creation rolls back project metadata");
  assert.equal(failureDb.prepare("SELECT count(*) AS count FROM maps").get().count, 2, "failed creation rolls back maps");
  failureDb.exec("DROP TRIGGER fail_creation");
  failureDb.close();
  await stop();
  origin = await start(creationPath);
  assert.deepEqual((await request(url(origin, one.projectId, one.mapId))).body.document, edited);
  assert.deepEqual((await request(url(origin, two.projectId, two.mapId))).body.document, two.document);
  const levelsAddress = `${origin}/api/projects/${one.projectId}/levels`;
  const mutate = body => request(levelsAddress, "POST", { mapId: one.mapId, ...body });
  assert.equal((await mutate({ action: "delete" })).status, 409, "last active level cannot be deleted");
  assert.equal((await mutate({ action: "add", name: " " })).status, 400);
  const blank = await mutate({ action: "add", name: "Blank" });
  assert.equal(blank.status, 200);
  const blankId = blank.body.mapId;
  assert.notEqual(blankId, one.mapId);
  const blankDocument = (await request(url(origin, one.projectId, blankId))).body.document;
  assert.equal(blankDocument.objects.length, 2);
  assert.deepEqual(blankDocument.bounds, edited.bounds);
  const duplicate = await mutate({ action: "duplicate", name: "Independent copy" });
  assert.equal(duplicate.status, 200);
  const copyId = duplicate.body.mapId;
  assert.deepEqual((await request(url(origin, one.projectId, copyId))).body.document,
    { ...edited, id: copyId, name: "Independent copy" });
  assert.equal((await mutate({ action: "rename", mapId: copyId, name: "Renamed" })).status, 200);
  assert.deepEqual((await request(url(origin, one.projectId, one.mapId))).body.document, edited);
  assert.equal((await mutate({ action: "delete" })).status, 409, "starting level requires an explicit replacement");
  assert.equal((await mutate({ action: "delete", replacementMapId: two.mapId })).status, 409, "replacement cannot belong to another project");
  assert.equal((await mutate({ action: "start", mapId: two.mapId })).status, 404);
  assert.equal((await mutate({ action: "recover", mapId: two.mapId })).status, 404);
  assert.equal((await mutate({ action: "delete", replacementMapId: blankId })).status, 200);
  assert.equal((await request(url(origin, one.projectId, one.mapId))).status, 409);
  assert.equal((await request(url(origin, one.projectId, one.mapId), "PUT",
    { projectId: one.projectId, model: generic.MODEL, document: edited })).status, 409);
  assert.equal((await mutate({ action: "start" })).status, 409);
  await stop();
  origin = await start(creationPath);
  const restartedLevels = `${origin}/api/projects/${one.projectId}/levels`;
  assert.equal((await request(restartedLevels)).body.startingMapId, blankId);
  assert.ok((await request(restartedLevels)).body.levels.find(level => level.mapId === one.mapId).deletedAt);
  assert.equal((await request(restartedLevels, "POST", { action: "recover", mapId: one.mapId })).status, 200);
  assert.deepEqual((await request(url(origin, one.projectId, one.mapId))).body.document, edited);
  assert.deepEqual((await request(url(origin, two.projectId, two.mapId))).body.document, two.document);
  assert.equal((await request(`${origin}/api/projects/${two.projectId}/levels`)).body.levels.length, 1);
  await stop();

  const badPath = resolve(testDir, "unknown.sqlite");
  seed(badPath, v2Json, "unknown-map");
  await assert.rejects(start(badPath), /unknown legacy/);
  const badDb = new DatabaseSync(badPath);
  assert.equal(badDb.prepare("SELECT document_json FROM maps WHERE id = ?").get("unknown-map").document_json, v2Json);
  assert.equal(badDb.prepare("SELECT document_json FROM map_backups").get().document_json, "original backup bytes");
  badDb.close();
  console.log("Persistence passed: legacy migration/backups, model isolation, New Game validation/defaults, duplicate rejection, metadata-only files, rollback cleanup and restart.");
} finally {
  await stop();
  await rm(testDir, { recursive: true, force: true });
}
