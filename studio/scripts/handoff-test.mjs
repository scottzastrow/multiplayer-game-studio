import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { assertStarterKitCompatibility } from "../../tools/starter-kit-compatibility.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = JSON.parse(await readFile(join(root, "starter-data", "astraeum", "manifest.json"), "utf8"));
const lock = JSON.parse(await readFile(join(root, "engine", "developer-kit.lock.json"), "utf8"));
assertStarterKitCompatibility(manifest, lock);
const data = join(root, "studio", "data");
await mkdir(data, { recursive: true });
const temporary = await mkdtemp(join(data, "handoff-test-"));
const database = join(temporary, "studio.sqlite");
const children = [];
let output = "";

async function freePort() {
  const listener = createServer();
  await new Promise((ok, fail) => listener.once("error", fail).listen(0, "127.0.0.1", ok));
  const port = listener.address().port;
  await new Promise((ok, fail) => listener.close(error => error ? fail(error) : ok()));
  return port;
}

function records(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    return tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all()
      .map(row => JSON.stringify(row)).sort()]);
  } finally {
    db.close();
  }
}

function start(args, env) {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  child.on("error", error => { output += `\n${error.stack}`; });
  children.push(child);
  return child;
}

async function ready(address) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (children.some(child => child.exitCode !== null)) throw new Error(`Handoff service exited:\n${output}`);
    try {
      const response = await fetch(address);
      if (response.ok) return;
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
    await delay(100);
  }
  throw new Error(`Handoff service was not responsive at ${address}:\n${output}`);
}

async function json(address) {
  const response = await fetch(address);
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

try {
  const restored = join(data, "studio.sqlite");
  assert.deepEqual(await readFile(restored),
    await readFile(join(root, "starter-data", "astraeum", "studio.sqlite")),
    "Run the documented bootstrap in a fresh checkout before this test; existing user storage is never used.");
  await copyFile(restored, database);
  const before = records(join(root, "starter-data", "astraeum", "studio.sqlite"));
  assert.deepEqual(records(database), before, "Restored database rows differ from the starter.");
  const apiPort = await freePort();
  let webPort = await freePort();
  while (webPort === apiPort) webPort = await freePort();
  const env = {
    ...process.env,
    STUDIO_API_PORT: String(apiPort), STUDIO_WEB_PORT: String(webPort),
    STUDIO_DATABASE_PATH: relative(root, database),
    STUDIO_GAMES_PATH: relative(root, join(temporary, "games"))
  };
  start([join(root, "studio", "server.mjs")], env);
  start([join(root, "games", "sample", "node_modules", "vite", "bin", "vite.js"),
    "--config", join(root, "studio", "vite.config.js")], env);
  const api = `http://127.0.0.1:${apiPort}`;
  const web = `http://127.0.0.1:${webPort}`;
  await Promise.all([ready(`${api}/api/projects`), ready(web)]);
  const projects = await json(`${web}/api/projects`);
  assert.ok(projects.maps.length > 0);
  assert.ok(projects.maps.every(map => map.projectId === manifest.game.projectId));
  const levels = await json(`${web}/api/projects/${manifest.game.projectId}/levels`);
  const active = levels.levels.filter(level => !level.deletedAt);
  assert.equal(active.length, manifest.database.activeLevels);
  assert.equal(levels.startingMapId, manifest.game.startingLevelId);
  let sections = 0;
  for (const level of active) {
    const payload = await json(`${web}/api/projects/${manifest.game.projectId}/levels/${level.mapId}/sections`);
    sections += payload.sections.length;
    assert.equal(payload.archivedSections.length, 0);
    for (const section of payload.sections) {
      assert.equal(section.document.id, section.mapId);
      assert.ok(Array.isArray(section.document.objects));
    }
  }
  assert.equal(sections, manifest.database.activeSections);
  const html = await fetch(web).then(response => response.text());
  assert.match(html, /Open Game/);
  assert.match(html, /id="export-game"/);
  const module = await fetch(`${web}/src/main.js`);
  assert.equal(module.status, 200);
  assert.doesNotMatch(await module.text(), /does not exist|Internal Server Error/);
  const image = await fetch(`${web}/@fs/${root.replaceAll("\\", "/")}/games/astraeum-tower/assets/chest.png`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.deepEqual(records(database), before, "Read-only startup must not change logical starter records.");
  console.log(`Handoff startup: explicit cwd=${root}; API=${apiPort}; web=${webPort}; disposable storage=${relative(root, temporary)}.`);
  console.log("Restored starter: only Astraeum, 3 active levels, 5 sections, saved start, source module and chest artwork; logical records unchanged.");
} finally {
  await Promise.all(children.map(async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }));
  await rm(temporary, { recursive: true, force: true });
}
