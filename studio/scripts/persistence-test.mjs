import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, readdir, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  createFloorDocument,
  FLOOR1_GRID,
  migrateFloorDocumentV1,
  playStartProblems as towerPlayStartProblems,
  validateFloorDocument as validateTowerDocument
} from "../../games/astraeum-tower/src/project.js";
import { ASTRAEUM_PROJECT_ID as projectId, ASTRAEUM_FLOOR_1_MAP_ID as mapId, ASTRAEUM_MODEL as model } from "../project-identity.js";
import * as generic from "../../games/generic-grid-v1/src/project.js";
import { createGridRectangleBoundary } from "../playable-boundaries.js";

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
  const creation = { name: "Generic One", author: "Disposable credits", ...generic.DEFAULT_DIMENSIONS, model: generic.MODEL };
  for (const patch of [
    { name: "" }, { name: "   " }, { name: "a".repeat(65) }, { name: "bad\nname" },
    { author: "" }, { author: "a".repeat(129) }, { width: 640 }, { height: 480 },
    { width: 640, height: 480 },
    { width: 64, height: 64 }, { width: "2048" }, { height: 2048.5 },
    { model: "astraeum-floor-v2" }, { extra: true }
  ]) {
    assert.equal((await request(`${origin}/api/projects`, "POST", { ...creation, ...patch })).status, 400);
  }
  const created = await request(`${origin}/api/projects`, "POST", creation);
  assert.equal(created.status, 201);
  const one = created.body;
  assert.notEqual(one.projectId, one.model, "project identity is not its model");
  assert.deepEqual(one.document.bounds, generic.DEFAULT_DIMENSIONS, "new projects use fixed world dimensions");
  assert.equal(one.document.objects.length, 2, "blank terrain and only two required player starts");
  assert.deepEqual(generic.playStartProblems(one.document), []);
  const noGenericStarts = structuredClone(one.document);
  noGenericStarts.objects = noGenericStarts.objects.filter(object => object.type !== "spawn");
  assert.deepEqual(generic.validateFloorDocument(noGenericStarts).objects, []);
  assert.match(generic.playStartProblems(noGenericStarts).join(" "), /missing; add it from the palette/i);
  const savedNoSpawnDraft = await request(url(origin, one.projectId, one.mapId), "PUT",
    { projectId: one.projectId, model: generic.MODEL, document: noGenericStarts });
  assert.equal(savedNoSpawnDraft.status, 200, "a generic draft without player starts remains saveable");
  assert.deepEqual((await request(url(origin, one.projectId, one.mapId))).body.document, noGenericStarts,
    "SQLite reopens the spawn-free draft unchanged");
  const towerWithoutStart = createFloorDocument();
  towerWithoutStart.objects = towerWithoutStart.objects.filter(object => object.assetId !== "spawn-aries");
  validateTowerDocument(towerWithoutStart);
  assert.match(towerPlayStartProblems(towerWithoutStart).join(" "), /player start is missing.*add a player start/i);
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
  const two = (await request(`${origin}/api/projects`, "POST", { ...creation, name: "Generic Two" })).body;
  assert.notEqual(one.projectId, two.projectId);
  assert.notEqual(one.mapId, two.mapId);
  assert.deepEqual(two.document.bounds, generic.DEFAULT_DIMENSIONS);
  assert.deepEqual(generic.playStartProblems(two.document), [], "fixed dimensions include two safe starts");
  const twoSectionsAddress = `${origin}/api/projects/${two.projectId}/levels/${two.mapId}/sections`;
  const twoBaseline = (await request(twoSectionsAddress)).body;
  const directEdit = { ...two.document, name: "Concurrent map write" };
  assert.equal((await request(url(origin, two.projectId, two.mapId), "PUT",
    { projectId: two.projectId, model: generic.MODEL, document: directEdit })).status, 200);
  const staleTwo = { operationId: "stale-after-direct-write", revision: twoBaseline.revision,
    sections: twoBaseline.sections.map(section => ({ sectionId: section.sectionId,
      revision: section.revision, document: section.document })), archivedSections: [] };
  assert.equal((await request(twoSectionsAddress, "PUT", staleTwo)).status, 409,
    "a direct map write invalidates an earlier section-save baseline");
  assert.equal((await request(twoSectionsAddress)).body.sections[0].document.name, directEdit.name);
  assert.equal((await request(url(origin, two.projectId, two.mapId), "PUT",
    { projectId: two.projectId, model: generic.MODEL, document: two.document })).status, 200);
  const beforeRename = (await request(twoSectionsAddress)).body;
  assert.equal((await request(`${origin}/api/projects/${two.projectId}/levels`, "POST",
    { action: "rename", mapId: two.mapId, name: "Renamed concurrently" })).status, 200);
  assert.equal((await request(twoSectionsAddress, "PUT", { ...staleTwo,
    operationId: "stale-after-rename", revision: beforeRename.revision,
    sections: beforeRename.sections.map(section => ({ sectionId: section.sectionId,
      revision: section.revision, document: section.document })) })).status, 409,
  "renaming invalidates an earlier section-save baseline");
  assert.equal((await request(url(origin, two.projectId, two.mapId), "PUT",
    { projectId: two.projectId, model: generic.MODEL, document: two.document })).status, 200);
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
  assert.equal((await mutate({ action: "add", name: "Custom size", width: 640, height: 480 })).status, 400,
    "blank levels reject custom dimensions");
  const blank = await mutate({ action: "add", name: "Blank" });
  assert.equal(blank.status, 200);
  const blankId = blank.body.mapId;
  assert.notEqual(blankId, one.mapId);
  const blankDocument = (await request(url(origin, one.projectId, blankId))).body.document;
  assert.deepEqual(blankDocument.objects, [], "Add Level creates no objects, including player starts");
  assert.deepEqual(blankDocument.bounds, { width: 2048, height: 2048 });
  assert.equal(blank.body.startingMapId, one.mapId, "Add Level does not change the starting level");
  const blankSections = (await request(`${origin}/api/projects/${one.projectId}/levels/${blankId}/sections`)).body;
  assert.equal(blankSections.sections.length, 1);
  assert.deepEqual([blankSections.sections[0].gridX, blankSections.sections[0].gridY], [0, 0]);
  assert.deepEqual(blankSections.sections[0].document, blankDocument);
  assert.equal((await mutate({ action: "add", mapId: two.mapId, name: "Foreign source" })).status, 404);
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

  origin = await start(creationPath);
  const world = await request(`${origin}/api/projects/${one.projectId}/worlds`, "POST", {
    name: "Retained legacy world", sourceMapId: one.mapId,
    positions: [{ gridX: 0, gridY: 0 }, { gridX: 1, gridY: 0 }]
  });
  assert.equal(world.status, 201);
  const worldPath = `/api/projects/${one.projectId}/worlds/${world.body.worldId}`;
  const worldAddress = `${origin}${worldPath}`;
  const preservedWorld = (await request(worldAddress)).body;
  const sectionsPath = `/api/projects/${one.projectId}/levels/${one.mapId}/sections`;
  const sectionsAddress = `${origin}${sectionsPath}`;
  const firstSection = await request(sectionsAddress);
  assert.equal(firstSection.status, 200);
  assert.equal(firstSection.body.sections.length, 1, "an existing level opens as its original single section");
  assert.deepEqual(firstSection.body.sections[0].document, edited, "existing level bytes are preserved");
  const added = await request(sectionsAddress, "POST", { gridX: 1, gridY: 0, revision: firstSection.body.revision });
  assert.equal(added.status, 201);
  assert.equal(added.body.sections.length, 2);
  assert.deepEqual(added.body.sections.map(section => [section.gridX, section.gridY]), [[0, 0], [1, 0]]);
  assert.deepEqual(added.body.sections[1].document.objects, [], "new Generic sections have no starts or other contents");
  assert.deepEqual(added.body.sections[0].document, edited, "adding a section preserves saved contents exactly");
  assert.equal((await request(sectionsAddress, "POST", { gridX: 1, gridY: 0, revision: added.body.revision })).status, 409,
    "occupied section positions are rejected");
  assert.equal((await request(sectionsAddress, "POST", { gridX: 3, gridY: 0, revision: added.body.revision })).status, 400,
    "non-adjacent section positions are rejected");
  assert.equal((await request(`${origin}/api/projects/${one.projectId}/levels`)).body.levels
    .filter(level => !level.deletedAt).length, 3, "section maps do not become independent levels");
  assert.equal((await request(url(origin, two.projectId, two.mapId))).body.document.id, two.mapId,
    "another project remains isolated");
  const sectionDocs = added.body.sections.map(section => structuredClone(section.document));
  sectionDocs[0].objects.push(generic.createDesignObject("root-section-edit", "generic-block", { x: 64, y: 64 }, 0));
  sectionDocs[1].objects.push(generic.createDesignObject("adjacent-section-edit", "generic-block", { x: 96, y: 96 }, 0));
  const sectionSave = {
    operationId: "section-save-test-1", revision: added.body.revision,
    sections: added.body.sections.map((section, index) => ({ sectionId: section.sectionId,
      revision: section.revision, document: sectionDocs[index] }))
  };
  const failChildUpdate = new DatabaseSync(creationPath);
  const childMapId = added.body.sections[1].mapId;
  failChildUpdate.exec(`CREATE TRIGGER fail_level_section BEFORE UPDATE ON maps
    WHEN NEW.map_id = '${childMapId}' BEGIN SELECT RAISE(ABORT, 'injected section save failure'); END`);
  assert.equal((await request(sectionsAddress, "PUT", sectionSave)).status, 500);
  assert.deepEqual((await request(sectionsAddress)).body, added.body, "failed save rolls back every section");
  failChildUpdate.exec("DROP TRIGGER fail_level_section");
  failChildUpdate.close();
  const savedSections = await request(sectionsAddress, "PUT", sectionSave);
  assert.equal(savedSections.status, 200);
  assert.deepEqual((await request(sectionsAddress, "PUT", sectionSave)).body, savedSections.body,
    "section save retries are idempotent");
  assert.deepEqual((await request(worldAddress)).body, preservedWorld, "legacy world records remain unchanged");
  await stop();
  origin = await start(creationPath);
  assert.deepEqual((await request(`${origin}${sectionsPath}`)).body,
    savedSections.body, "all section documents reopen exactly after service restart");
  assert.deepEqual((await request(`${origin}${worldPath}`)).body,
    preservedWorld, "world records survive section saves and restart");

  const towerUrl = url(origin, projectId, mapId);
  const towerOriginal = createFloorDocument();
  assert.equal((await request(towerUrl, "PUT", { projectId, model, document: towerOriginal })).status, 200);
  const towerSectionAddress = `${origin}/api/projects/${projectId}/levels/${mapId}/sections`;
  const towerRoot = (await request(towerSectionAddress)).body;
  const towerAdded = await request(towerSectionAddress, "POST", { gridX: 0, gridY: -1, revision: towerRoot.revision });
  assert.equal(towerAdded.status, 201);
  const towerEmpty = towerAdded.body.sections.find(section => section.mapId !== mapId);
  assert.deepEqual(towerEmpty.document.objects, [], "new Tower sections have no cobblestone, walls, props or starts");
  assert.deepEqual(towerEmpty.document.bounds, { width: 2048, height: 2048 });
  assert.deepEqual(towerAdded.body.sections.find(section => section.mapId === mapId).document, towerOriginal);
  const authoredChild = structuredClone(towerEmpty.document);
  authoredChild.objects.push({ ...towerOriginal.objects[0], id: "saved-child-tile" });
  const towerSaved = await request(towerSectionAddress, "PUT", {
    operationId: "tower-preservation", revision: towerAdded.body.revision,
    sections: towerAdded.body.sections.map(section => ({
      sectionId: section.sectionId, revision: section.revision,
      document: section.sectionId === towerEmpty.sectionId ? authoredChild : section.document
    }))
  });
  assert.equal(towerSaved.status, 200);
  const towerThird = await request(towerSectionAddress, "POST", { gridX: -1, gridY: -1, revision: towerSaved.body.revision });
  assert.equal(towerThird.status, 201);
  assert.deepEqual(towerThird.body.sections.find(section => section.sectionId === towerEmpty.sectionId).document,
    authoredChild, "later section creation must not clear an already-saved section");
  await stop();
  origin = await start(creationPath);
  const towerReopened = (await request(`${origin}/api/projects/${projectId}/levels/${mapId}/sections`)).body;
  assert.deepEqual(towerReopened, towerThird.body, "empty and authored Tower sections persist after restart");
  assert.deepEqual((await request(`${origin}${worldPath}`)).body, preservedWorld);
  const preservedGenericSections = (await request(`${origin}${sectionsPath}`)).body;
  const levelCreationSnapshots = [];
  for (const [owner, sourceId, modelId, objectFactory] of [
    [projectId, mapId, model, (id, assetId, transform, order) =>
      ({ ...towerOriginal.objects.find(object => object.assetId === "prop-barrel"), id, transform, order })],
    [one.projectId, one.mapId, generic.MODEL, generic.createDesignObject]
  ]) {
    const levels = `${origin}/api/projects/${owner}/levels`;
    const beforeLevels = (await request(levels)).body;
    const inspect = new DatabaseSync(creationPath, { readOnly: true });
    const beforeRows = inspect.prepare("SELECT * FROM maps ORDER BY project_id, map_id").all();
    const beforeMembership = inspect.prepare("SELECT * FROM level_sections ORDER BY project_id, level_map_id, section_id").all();
    const beforeStarts = inspect.prepare("SELECT * FROM project_levels ORDER BY project_id").all();
    const created = await request(levels, "POST", { action: "add", mapId: sourceId, name: `Empty ${modelId}` });
    assert.equal(created.status, 200);
    const newId = created.body.mapId;
    assert.equal(created.body.startingMapId, beforeLevels.startingMapId);
    const sectionAddress = `${origin}/api/projects/${owner}/levels/${newId}/sections`;
    const fresh = (await request(sectionAddress)).body;
    assert.equal(fresh.sections.length, 1, "a separate level starts with exactly one section");
    const rootSection = fresh.sections[0];
    assert.equal(rootSection.mapId, newId);
    assert.deepEqual([rootSection.gridX, rootSection.gridY], [0, 0]);
    assert.deepEqual(rootSection.document.bounds, { width: 2048, height: 2048 });
    assert.deepEqual(rootSection.document.objects, [], "neither model inherits cobblestone, objects or starts");
    assert.equal(Object.hasOwn(rootSection.document, "playableBoundary"), false);
    const oldIds = new Set(beforeRows.map(row => `${row.project_id}/${row.map_id}`));
    assert.deepEqual(inspect.prepare("SELECT * FROM maps ORDER BY project_id, map_id").all()
      .filter(row => oldIds.has(`${row.project_id}/${row.map_id}`)), beforeRows,
    "Add Level preserves every existing saved row, timestamp, model and deletion flag");
    assert.deepEqual(inspect.prepare("SELECT * FROM level_sections ORDER BY project_id, level_map_id, section_id").all(),
      beforeMembership, "adding a separate level never reassigns existing sections");
    assert.deepEqual(inspect.prepare("SELECT * FROM project_levels ORDER BY project_id").all(), beforeStarts);
    inspect.close();
    const document = structuredClone(rootSection.document);
    document.objects.push(objectFactory("new-level-marker", owner === projectId ? "prop-barrel" : "generic-marker",
      { x: 128, y: 128 }, 0));
    const saved = await request(sectionAddress, "PUT", { operationId: `empty-level-${newId}`,
      revision: fresh.revision, sections: [{ sectionId: rootSection.sectionId,
        revision: rootSection.revision, document }] });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.sections[0].document, document);
    assert.equal((await request(url(origin, two.projectId, newId))).body.document, null, "new level is project-isolated");
    assert.equal((await request(`${origin}/api/projects/${two.projectId}/levels/${newId}/sections`)).status, 404);
    levelCreationSnapshots.push({ owner, newId, payload: saved.body });
  }
  await stop();
  origin = await start(creationPath);
  for (const saved of levelCreationSnapshots) {
    assert.deepEqual((await request(`${origin}/api/projects/${saved.owner}/levels/${saved.newId}/sections`)).body,
      saved.payload, "newly created and edited levels reopen exactly after service restart");
  }
  assert.deepEqual((await request(`${origin}/api/projects/${projectId}/levels/${mapId}/sections`)).body, towerReopened);
  assert.deepEqual((await request(`${origin}${sectionsPath}`)).body, preservedGenericSections);
  assert.deepEqual((await request(`${origin}${worldPath}`)).body, preservedWorld);
  assert.deepEqual((await request(url(origin, two.projectId, two.mapId))).body.document, two.document);

  for (const [owner, levelId, initialSource] of [
    [one.projectId, one.mapId, preservedGenericSections],
    [projectId, mapId, towerReopened]
  ]) {
    const sectionAddress = `${origin}/api/projects/${owner}/levels/${levelId}/sections`;
    let source = initialSource;
    const toSave = (section, document = section.document) =>
      ({ sectionId: section.sectionId, revision: section.revision, document });
    const undoDraft = source.sections.map((section, index) => toSave(section,
      { ...section.document, name: index === 0 ? "Unsaved edit after undo" : section.document.name }));
    const undoSave = { operationId: `undo-before-save-${levelId}`, revision: source.revision,
      sections: undoDraft, archivedSections: [] };
    const undoResult = await request(sectionAddress, "PUT", undoSave);
    assert.equal(undoResult.status, 200, "remove then undo saves the unchanged membership and unrelated edit");
    assert.equal(undoResult.body.revision, source.revision + 1);
    assert.equal(undoResult.body.sections[0].document.name, "Unsaved edit after undo");
    source = undoResult.body;
    const concurrentDraft = { operationId: `concurrent-draft-${levelId}`, revision: source.revision,
      sections: source.sections.map(section => toSave(section)), archivedSections: [] };
    const concurrentWrite = { operationId: `concurrent-writer-${levelId}`, revision: source.revision,
      sections: source.sections.map((section, index) => toSave(section,
        index === 0 ? { ...section.document, name: "Concurrent writer" } : section.document)),
      archivedSections: [] };
    const concurrentResult = await request(sectionAddress, "PUT", concurrentWrite);
    assert.equal(concurrentResult.status, 200);
    const rejected = await request(sectionAddress, "PUT", concurrentDraft);
    assert.equal(rejected.status, 409, "a concurrent write is rejected even with unchanged membership");
    assert.deepEqual((await request(sectionAddress)).body, concurrentResult.body);
    assert.equal(concurrentDraft.sections[0].document.name, "Unsaved edit after undo",
      "the rejected request leaves the client draft unchanged");
    source = concurrentResult.body;
    const rootSection = source.sections.find(section => section.mapId === levelId);
    const neighbor = source.sections.find(section => section.mapId !== levelId);
    const modifiedRoot = { ...rootSection.document, name: "Unsaved root kept on removal" };
    const modifiedNeighbor = { ...neighbor.document, name: "Unsaved neighbor kept on removal" };
    const active = source.sections.filter(section => section.sectionId !== rootSection.sectionId)
      .map(section => toSave(section, section.sectionId === neighbor.sectionId ? modifiedNeighbor : section.document));
    const occupied = new Set([...source.sections, ...source.archivedSections]
      .map(section => `${section.gridX},${section.gridY}`));
    const newPosition = [[neighbor.gridX + 1, neighbor.gridY], [neighbor.gridX, neighbor.gridY + 1],
      [neighbor.gridX, neighbor.gridY - 1], [neighbor.gridX - 1, neighbor.gridY]]
      .find(([x, y]) => !occupied.has(`${x},${y}`));
    assert.ok(newPosition, "the fixture has an empty adjacent section position");
    const newMapId = `map-draft-${levelId}`;
    const newDocument = { ...neighbor.document, id: newMapId, name: "Saved draft section", objects: [] };
    const addedSection = { sectionId: `section-draft-${levelId}`, mapId: newMapId,
      gridX: newPosition[0], gridY: newPosition[1], revision: 0, document: newDocument };
    active.push(addedSection);
    const removeRoot = { operationId: `remove-root-${levelId}`, revision: source.revision,
      sections: active, archivedSections: [toSave(rootSection, modifiedRoot)] };
    const failureDb = new DatabaseSync(creationPath);
    failureDb.exec(`CREATE TRIGGER reject_archive BEFORE INSERT ON level_section_archives
      BEGIN SELECT RAISE(ABORT, 'injected archive failure'); END`);
    assert.equal((await request(sectionAddress, "PUT", removeRoot)).status, 500);
    assert.deepEqual((await request(sectionAddress)).body, source, "failed archival rolls back every document and membership");
    const failedAdditionDb = new DatabaseSync(creationPath, { readOnly: true });
    assert.equal(failedAdditionDb.prepare("SELECT 1 FROM maps WHERE project_id = ? AND map_id = ?")
      .get(owner, newMapId), undefined, "failed atomic Add leaves no orphan map row");
    failedAdditionDb.close();
    failureDb.exec("DROP TRIGGER reject_archive");
    failureDb.close();
    const removed = await request(sectionAddress, "PUT", removeRoot);
    assert.equal(removed.status, 200);
    assert.equal(removed.body.revision, source.revision + 1, "membership changes use and advance the baseline revision");
    assert.deepEqual(removed.body.sections.find(section => section.sectionId === addedSection.sectionId).document,
      newDocument, "Add, Remove and document edits persist in one atomic save");
    assert.equal(removed.body.sections.find(section => section.sectionId === addedSection.sectionId).revision, 1);
    assert.deepEqual(removed.body.sections.map(section => [section.gridX, section.gridY]),
      [...source.sections.filter(section => section.sectionId !== rootSection.sectionId), addedSection]
        .map(section => [section.gridX, section.gridY]));
    assert.deepEqual(removed.body.archivedSections.find(section => section.sectionId === rootSection.sectionId).document, modifiedRoot);
    assert.deepEqual(removed.body.sections.find(section => section.sectionId === neighbor.sectionId).document, modifiedNeighbor);
    assert.deepEqual((await request(sectionAddress, "PUT", removeRoot)).body, removed.body, "removal retries are idempotent");
    assert.equal((await request(sectionAddress, "PUT", { ...removeRoot, operationId: `stale-${levelId}` })).status, 409);
    const levelList = (await request(`${origin}/api/projects/${owner}/levels`)).body.levels;
    assert.equal(levelList.some(level => level.mapId === neighbor.mapId), false);
    await stop();
    origin = await start(creationPath);
    const addressAfterRestart = `${origin}/api/projects/${owner}/levels/${levelId}/sections`;
    assert.deepEqual((await request(addressAfterRestart)).body, removed.body, "removed content and active membership survive restart");
    const restore = { operationId: `restore-root-${levelId}`, revision: removed.body.revision,
      sections: [...removed.body.sections, ...removed.body.archivedSections].map(section => toSave(section)),
      archivedSections: [] };
    const restored = await request(addressAfterRestart, "PUT", restore);
    assert.equal(restored.status, 200);
    assert.deepEqual(restored.body.sections.find(section => section.sectionId === rootSection.sectionId).document, modifiedRoot);
    assert.deepEqual(restored.body.sections.find(section => section.sectionId === neighbor.sectionId).document, modifiedNeighbor);
    const restoredPositions = restored.body.sections.map(section => [section.gridX, section.gridY])
      .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    const expectedPositions = [...removed.body.sections, ...removed.body.archivedSections]
      .map(section => [section.gridX, section.gridY]).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    assert.deepEqual(restoredPositions, expectedPositions,
      "restoration preserves exact positions including the added section");
    const noActive = { operationId: `remove-all-${levelId}`, revision: restored.body.revision,
      sections: [], archivedSections: restored.body.sections.map(section => toSave(section)) };
    assert.notEqual((await request(addressAfterRestart, "PUT", noActive)).status, 200);
    const rootNow = restored.body.sections.find(section => section.mapId === levelId);
    const otherNow = restored.body.sections.find(section => section.mapId !== levelId);
    const boundary = createGridRectangleBoundary(
      { x: otherNow.gridX * 64, y: otherNow.gridY * 64 },
      { x: otherNow.gridX * 64 + 1, y: otherNow.gridY * 64 + 1 }, restored.body.sections).boundary;
    const boundaryRemoval = { operationId: `boundary-remove-${levelId}`, revision: restored.body.revision,
      sections: restored.body.sections.filter(section => section.sectionId !== otherNow.sectionId)
        .map(section => toSave(section, section.sectionId === rootNow.sectionId
          ? { ...section.document, playableBoundary: boundary } : section.document)),
      archivedSections: [toSave(otherNow)] };
    assert.notEqual((await request(addressAfterRestart, "PUT", boundaryRemoval)).status, 200,
      "a custom boundary cannot silently extend into a removed section");
    assert.deepEqual((await request(addressAfterRestart)).body, restored.body);
    const removeNeighbor = { operationId: `remove-neighbor-${levelId}`, revision: restored.body.revision,
      sections: restored.body.sections.filter(section => section.sectionId !== otherNow.sectionId).map(section => toSave(section)),
      archivedSections: [toSave(otherNow)] };
    const neighborRemoved = await request(addressAfterRestart, "PUT", removeNeighbor);
    assert.equal(neighborRemoved.status, 200);
    assert.deepEqual(neighborRemoved.body.archivedSections[0].document, modifiedNeighbor);
    assert.equal((await request(url(origin, owner, otherNow.mapId))).status, 409,
      "an archived section is not exposed as an independent map");
    const replacement = await request(addressAfterRestart, "POST", {
      gridX: otherNow.gridX, gridY: otherNow.gridY, revision: neighborRemoved.body.revision
    });
    assert.equal(replacement.status, 201, "Add Section may reuse an archived position after saving");
    const conflictingRestore = { operationId: `conflicting-restore-${levelId}`, revision: replacement.body.revision,
      sections: [...replacement.body.sections, ...replacement.body.archivedSections].map(section => toSave(section)),
      archivedSections: [] };
    assert.equal((await request(addressAfterRestart, "PUT", conflictingRestore)).status, 409,
      "restoring into an occupied position fails atomically");
    const overArchiveLimit = { operationId: `archive-limit-${levelId}`, revision: replacement.body.revision,
      sections: replacement.body.sections.map(section => toSave(section)),
      archivedSections: Array(17).fill(toSave(replacement.body.archivedSections[0])) };
    assert.equal((await request(addressAfterRestart, "PUT", overArchiveLimit)).status, 400,
      "the archive limit is enforced without dropping any retained document");
    assert.deepEqual((await request(addressAfterRestart)).body, replacement.body);
    assert.deepEqual((await request(`${origin}${worldPath}`)).body, preservedWorld);
  }
  const replacementAddress = `${origin}/api/projects/${two.projectId}/levels/${two.mapId}/sections`;
  const replaceRootBaseline = (await request(replacementAddress)).body;
  const replacementMap = "map-unsaved-replacement";
  const replaceRoot = { operationId: "replace-root-in-one-save", revision: replaceRootBaseline.revision,
    sections: [{ sectionId: "section-unsaved-replacement", mapId: replacementMap, gridX: 1, gridY: 0,
      revision: 0, document: { ...two.document, id: replacementMap, objects: [] } }],
    archivedSections: replaceRootBaseline.sections.map(section => ({ sectionId: section.sectionId,
      revision: section.revision, document: section.document })) };
  const replacedRoot = await request(replacementAddress, "PUT", replaceRoot);
  assert.equal(replacedRoot.status, 200, "a draft addition can remain after its saved anchor is removed");
  assert.deepEqual(replacedRoot.body.archivedSections[0].document, two.document);
  assert.equal((await request(`${origin}/api/projects/${two.projectId}/levels`, "POST",
    { action: "rename", mapId: two.mapId, name: "Archived root renamed" })).status, 200);
  const staleArchivedRoot = { operationId: "stale-after-archived-root-rename", revision: replacedRoot.body.revision,
    sections: replacedRoot.body.sections.map(section => ({ sectionId: section.sectionId,
      revision: section.revision, document: section.document })),
    archivedSections: replacedRoot.body.archivedSections.map(section => ({ sectionId: section.sectionId,
      revision: section.revision, document: section.document })) };
  assert.equal((await request(replacementAddress, "PUT", staleArchivedRoot)).status, 409);
  const afterArchivedRename = (await request(replacementAddress)).body;
  assert.equal(afterArchivedRename.archivedSections[0].document.name, "Archived root renamed");
  assert.equal(afterArchivedRename.archivedSections[0].revision,
    replacedRoot.body.archivedSections[0].revision + 1);
  await stop();

  const badPath = resolve(testDir, "unknown.sqlite");
  seed(badPath, v2Json, "unknown-map");
  await assert.rejects(start(badPath), /unknown legacy/);
  const badDb = new DatabaseSync(badPath);
  assert.equal(badDb.prepare("SELECT document_json FROM maps WHERE id = ?").get("unknown-map").document_json, v2Json);
  assert.equal(badDb.prepare("SELECT document_json FROM map_backups").get().document_json, "original backup bytes");
  badDb.close();
  console.log("Persistence passed: legacy migration/backups, model isolation, level-section membership and atomic save/reopen, retained World records, fixed dimensions, metadata-only files, rollback cleanup and restart.");
} finally {
  await stop();
  await rm(testDir, { recursive: true, force: true });
}
