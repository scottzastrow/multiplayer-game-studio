import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { createFloorDocument } from "../../games/astraeum-tower/src/project.js";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
await mkdir(resolve(root, "studio", "data"), { recursive: true });
const directory = await mkdtemp(resolve(root, "studio", "data", "levels-smoke-"));
const database = resolve(directory, "designs.sqlite");
const seed = new DatabaseSync(database);
const original = JSON.stringify(createFloorDocument(), null, 2);
seed.exec(`CREATE TABLE maps (id TEXT PRIMARY KEY, document_json TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE map_backups (id INTEGER PRIMARY KEY AUTOINCREMENT, map_id TEXT NOT NULL, format_version INTEGER,
    document_json TEXT NOT NULL, original_updated_at TEXT, reason TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, map_id TEXT NOT NULL, from_version INTEGER,
    to_version INTEGER NOT NULL, status TEXT NOT NULL, backup_id INTEGER, report_json TEXT NOT NULL, created_at TEXT NOT NULL);`);
seed.prepare("INSERT INTO maps VALUES (?, ?, ?)").run("astraeum-tower-floor-1", original, "old");
seed.exec(`INSERT INTO map_backups VALUES (41, 'astraeum-tower-floor-1', 1, 'untouched backup', 'old', 'test', 'old');
  INSERT INTO migrations VALUES (51, 'astraeum-tower-floor-1', 1, 2, 'migrated', 41,
    '{"walls":0,"collisionBoxes":[]}', '2025-01-01');`);
seed.close();

async function freePort() {
  const listener = createServer();
  await new Promise(ok => listener.listen(0, "127.0.0.1", ok));
  const port = listener.address().port;
  await new Promise(ok => listener.close(ok));
  return port;
}
const apiPort = await freePort();
const webPort = await freePort();
const debugPort = await freePort();
const origin = `http://127.0.0.1:${webPort}`;
let service, web, chrome, socket, sessionId;
const pending = new Map();
const exceptions = [];
let nextId = 0;
const children = [];

function launch(file, args, env = {}) {
  const child = spawn(file, args, { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  child.output = "";
  child.stdout.on("data", chunk => { child.output += chunk; });
  child.stderr.on("data", chunk => { child.output += chunk; });
  children.push(child);
  return child;
}
function startService() {
  return launch(process.execPath, ["--no-warnings", resolve(root, "studio", "server.mjs")], {
    STUDIO_API_PORT: String(apiPort), STUDIO_DATABASE_PATH: relative(root, database),
    STUDIO_GAMES_PATH: relative(root, resolve(directory, "games"))
  });
}
async function ready(url, child) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null) throw new Error(`Process exited: ${child.output}`);
    try { const response = await fetch(url); if (response.ok) return response; } catch {}
    await delay(100);
  }
  throw new Error(`Not responsive: ${url}\n${child.output}`);
}
async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error("Child did not exit.")), 5000);
    child.once("exit", () => { clearTimeout(timer); ok(); });
    child.kill("SIGTERM");
  });
}
function cdp(method, params = {}, browser = false) {
  return new Promise((ok, fail) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); fail(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { ok, fail, timer });
    socket.send(JSON.stringify({ id, method, params, ...(!browser && sessionId ? { sessionId } : {}) }));
  });
}
async function evaluate(expression) {
  const value = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description ?? "Browser evaluation failed.");
  return value.result.value;
}
async function waitFor(expression) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (await evaluate(expression)) return;
    await delay(25);
  }
  throw new Error(`UI timed out: ${expression}\n${await evaluate('document.querySelector("#status").textContent')}`);
}
async function clickAt(x, y) {
  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}
async function click(selector) {
  await waitFor(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); return e && !e.disabled && !e.closest("[inert]") && e.getClientRects().length; })()`);
  const point = await evaluate(`(() => {
    const e = document.querySelector(${JSON.stringify(selector)});
    e.scrollIntoView({ block: "center" });
    const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  await clickAt(point.x, point.y);
}
async function fill(selector, value) {
  await click(selector);
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 });
  await cdp("Input.insertText", { text: value });
}
const design = () => evaluate("window.__studioTest.document()");
const row = id => `#level-select option[data-map-id="${id}"]`;
async function selectLevel(id) {
  await waitFor(`document.querySelector(${JSON.stringify(row(id))}) && !document.querySelector("#level-select").disabled`);
  const index = await evaluate(`Array.from(document.querySelector("#level-select").options).findIndex(option => option.value === ${JSON.stringify(id)})`);
  assert.ok(index >= 0);
  await click("#level-select");
  for (const [key, code] of [["Home", 36], ...Array.from({ length: index }, () => ["ArrowDown", 40]), ["Enter", 13]]) {
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, windowsVirtualKeyCode: code });
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: code });
  }
}
async function openGame(projectId, mapId) {
  await click("#open-game");
  const selector = `.open-entry[data-project-id="${projectId}"][data-map-id="${mapId}"] input`;
  await click(selector);
  await click("#open-selected");
  await waitFor(`!document.querySelector("#open-dialog").open && window.__studioTest.document().id === ${JSON.stringify(mapId)}`);
  await waitFor(`document.querySelector(${JSON.stringify(row(mapId))})`);
}
async function createGame(name) {
  await click("#new-game");
  await fill("#new-name", name);
  await fill("#new-author", "Disposable level test");
  await click("#new-create");
  await waitFor('!document.querySelector("#new-dialog").open');
  const document = await design();
  await waitFor(`document.querySelector(${JSON.stringify(row(document.id))})`);
  const listing = await (await fetch(`http://127.0.0.1:${apiPort}/api/projects`)).json();
  return listing.maps.find(entry => entry.mapId === document.id);
}
async function operation(action, name) {
  const before = (await design()).id;
  await click(`#level-${action}`);
  if (name) await fill("#level-name", name);
  await click("#level-submit");
  await waitFor('!document.querySelector("#level-dialog").open');
  if (["add", "duplicate"].includes(action)) assert.notEqual((await design()).id, before);
  return design();
}
async function placeMarker() {
  await click('.asset-card[data-asset-id="generic-marker"]');
  const { x, y } = await evaluate("window.__studioTest.worldToClient(80, 80)");
  await clickAt(x, y);
  await waitFor('document.querySelector("#save-state").textContent.includes("Unsaved")');
  await click("#select-tool");
}
async function save() {
  await click("#save");
  await waitFor('document.querySelector("#save-state").classList.contains("saved") && !document.querySelector("#open-game").disabled');
}
async function preview(testId, position) {
  const before = await design();
  await click("#play");
  await waitFor(`document.querySelector("#studio").dataset.playState === "playing" && document.querySelector('[data-testid="${testId}"]')`);
  if (position) {
    const actual = await evaluate(`JSON.parse(document.querySelector('[data-testid="${testId}"]').dataset.position)`);
    assert.equal(actual.x, position.x);
    assert.equal(actual.y, position.y);
  }
  assert.equal(await evaluate('document.querySelector("#level-add").disabled'), true);
  assert.equal(await evaluate('document.querySelector("#level-select").disabled'), true);
  await click("#stop");
  await waitFor('document.querySelector("#studio").dataset.playState === "idle"');
  assert.deepEqual(await design(), before, "Stop does not save movement or mutate the design");
}

async function dropdownChecks() {
  await createGame("Level dropdown");
  const first = await design();
  assert.equal(await evaluate('document.querySelector("#level-select").labels[0].textContent'), "Current level");
  assert.equal(await evaluate('document.querySelector("#level-select").value'), first.id);
  assert.equal(await evaluate('document.querySelector("#level-delete").disabled'), true);
  assert.equal(await evaluate('document.querySelector("#level-start").disabled'), true);
  const second = await operation("add", "Second room");
  await selectLevel(first.id);
  await waitFor(`window.__studioTest.document().id === ${JSON.stringify(first.id)} && !document.querySelector("#open-dialog").open && document.querySelector("#level-select").value === ${JSON.stringify(first.id)}`);
  assert.equal(await evaluate('document.querySelector("#level-select").selectedOptions[0].textContent'), `${first.name} (Start)`);
  await placeMarker();
  const unsaved = await design();
  await selectLevel(second.id);
  await waitFor('!document.querySelector("#open-confirm").hidden');
  assert.equal(await evaluate('document.querySelector("#level-select").value'), first.id);
  await click("#switch-cancel");
  await click("#open-cancel");
  assert.deepEqual(await design(), unsaved, "cancel preserves the open level and its unsaved edits");
  assert.equal(await evaluate('document.querySelector("#level-select").value'), first.id);
  await click("#level-rename");
  assert.equal(await evaluate('document.querySelector("#level-name").value'), first.name, "actions still target the open level after cancellation");
  await click("#level-cancel");
  await selectLevel(second.id);
  await click("#switch-discard");
  await waitFor(`window.__studioTest.document().id === ${JSON.stringify(second.id)} && !document.querySelector("#open-dialog").open`);
  const renamed = await operation("rename", "Selected room");
  assert.equal(renamed.id, second.id);
  await waitFor('document.querySelector("#level-select").selectedOptions[0]?.textContent === "Selected room"');
  const copy = await operation("duplicate", "Selected copy");
  assert.deepEqual(copy, { ...renamed, id: copy.id, name: "Selected copy" }, "duplicate targets the selected document");
  await click("#level-start");
  await waitFor(`document.querySelector(${JSON.stringify(row(copy.id))}).textContent === "Selected copy (Start)"`);
  assert.equal(await evaluate('document.querySelector("#level-start").disabled'), true);
  await selectLevel(second.id);
  await waitFor(`window.__studioTest.document().id === ${JSON.stringify(second.id)} && !document.querySelector("#open-dialog").open`);
  assert.equal(await evaluate('document.querySelector("#level-start").disabled'), false);
  await click("#level-delete");
  assert.equal(await evaluate('document.querySelector("#level-replacement-field").hidden'), true, "delete targets the selected non-start level");
  await click("#level-submit");
  await waitFor(`!document.querySelector("#level-dialog").open && !document.querySelector(${JSON.stringify(row(second.id))})`);
  assert.equal((await design()).id, copy.id);
  assert.equal(await evaluate('document.querySelector("#deleted-levels").open'), false);
  await click("#deleted-levels summary");
  await click(`#level-recovery [data-map-id="${second.id}"]`);
  await waitFor(`document.querySelector(${JSON.stringify(row(second.id))})`);
  await selectLevel(first.id);
  await waitFor(`window.__studioTest.document().id === ${JSON.stringify(first.id)} && !document.querySelector("#open-dialog").open`);
  assert.deepEqual(await design(), first, "other-level actions leave the first saved design unchanged");
  const spawn = first.objects.find(object => object.assetId === "generic-player").transform;
  await preview("generic-preview", { x: spawn.x + first.cellSize / 2, y: spawn.y + first.cellSize / 2 });
  await waitFor('!document.querySelector("#level-select").disabled');
  assert.equal(await evaluate('document.querySelector("#level-select").value'), first.id);
  assert.deepEqual(exceptions, []);
  console.log("Levels dropdown passed via disposable direct CDP: labelled keyboard selection, current/start labels, unsaved cancellation, selected-level actions, separate recovery and Play/Stop disabled states.");
}

try {
  service = startService();
  await ready(`http://127.0.0.1:${apiPort}/api/projects`, service);
  web = launch(process.execPath, [resolve(root, "games", "sample", "node_modules", "vite", "bin", "vite.js"),
    "--config", "studio/vite.config.js", "--port", String(webPort), "--strictPort"], { STUDIO_API_PORT: String(apiPort) });
  await ready(origin, web);
  chrome = launch(process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", [
    "--headless=new", "--disable-gpu", `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${resolve(directory, "chrome")}`, "about:blank"
  ]);
  const version = await (await ready(`http://127.0.0.1:${debugPort}/json/version`, chrome)).json();
  socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((ok, fail) => { socket.addEventListener("open", ok, { once: true }); socket.addEventListener("error", fail, { once: true }); });
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.fail(new Error(message.error.message)); else request.ok(message.result);
  });
  const { targetId } = await cdp("Target.createTarget", { url: "about:blank" }, true);
  ({ sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true }, true));
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1800, height: 1100, deviceScaleFactor: 1, mobile: false });
  await cdp("Page.navigate", { url: origin });
  await waitFor('window.__studioTest?.document() && document.querySelector("#level-select option")');
  if (process.argv.includes("--dropdown-only")) {
    await dropdownChecks();
  } else {
  const towerBlank = await operation("add", "Empty Tower");
  assert.deepEqual([...new Set(towerBlank.objects.map(object => object.assetId))].sort(), ["floor-cobblestone", "spawn-aries"]);
  await preview("astraeum-world");
  const one = await createGame("Levels One");
  assert.equal(await evaluate('document.querySelector("#level-delete").disabled'), true);
  const first = await design();
  await placeMarker();
  await save();
  const editedFirst = await design();
  const blank = await operation("add", "Blank room");
  assert.equal(blank.objects.length, 2, "blank levels have no copied placements");
  assert.deepEqual(blank.bounds, first.bounds);
  await placeMarker();
  const unsaved = await design();
  await selectLevel(first.id);
  await waitFor('!document.querySelector("#open-confirm").hidden');
  await click("#switch-cancel");
  await click("#open-cancel");
  assert.deepEqual(await design(), unsaved, "cancel keeps unsaved changes");
  await selectLevel(first.id);
  await click("#switch-discard");
  await waitFor(`!document.querySelector("#open-dialog").open && window.__studioTest.document().id === ${JSON.stringify(first.id)}`);
  assert.deepEqual(await design(), editedFirst);
  await selectLevel(blank.id);
  await waitFor(`window.__studioTest.document().id === ${JSON.stringify(blank.id)} && !document.querySelector("#open-dialog").open`);
  assert.deepEqual(await design(), blank, "discard did not save the marker");
  await placeMarker();
  await selectLevel(first.id);
  await click("#switch-save");
  await waitFor(`!document.querySelector("#open-dialog").open && window.__studioTest.document().id === ${JSON.stringify(first.id)}`);
  await selectLevel(blank.id);
  await waitFor(`window.__studioTest.document().id === ${JSON.stringify(blank.id)} && !document.querySelector("#open-dialog").open`);
  const savedBlank = await design();
  const copy = await operation("duplicate", "Copy room");
  assert.deepEqual(copy, { ...savedBlank, id: copy.id, name: "Copy room" });
  const renamed = await operation("rename", "Starting room");
  assert.equal(renamed.id, copy.id);
  await click("#level-start");
  await waitFor(`document.querySelector(${JSON.stringify(row(copy.id))}).textContent.includes("(Start)")`);
  await placeMarker();
  await save();
  const savedCopy = await design();
  const spawn = savedCopy.objects.find(object => object.assetId === "generic-player").transform;
  // Authored transforms are tile origins; runtime positions are circle centers.
  await preview("generic-preview", {
    x: spawn.x + savedCopy.cellSize / 2,
    y: spawn.y + savedCopy.cellSize / 2
  });
  const two = await createGame("Levels Two");
  assert.equal(await evaluate('document.querySelector("#level-select").options.length'), 1);
  const other = await design();
  await stopChild(service);
  service = startService();
  await ready(`http://127.0.0.1:${apiPort}/api/projects`, service);
  await cdp("Page.reload", { ignoreCache: true });
  await waitFor('window.__studioTest?.document() && !document.querySelector("#open-game").disabled');
  await openGame(one.projectId, copy.id);
  assert.deepEqual(await design(), savedCopy, "save/reopen after service and page restart");
  await waitFor(`document.querySelector(${JSON.stringify(row(copy.id))}).textContent.includes("(Start)")`);
  await click("#level-delete");
  assert.equal(await evaluate('document.querySelector("#level-replacement-field").hidden'), false);
  await click("#level-submit");
  assert.equal(await evaluate('document.querySelector("#level-dialog").open'), true, "deleting start requires choosing a replacement");
  await click("#level-cancel");
  assert.deepEqual(await design(), savedCopy, "cancel deletion is nondestructive");
  await click("#level-delete");
  await click("#level-replacement");
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 });
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await click("#level-submit");
  await waitFor('!document.querySelector("#level-dialog").open');
  assert.notEqual((await design()).id, copy.id);
  assert.equal(await evaluate(`Boolean(document.querySelector(${JSON.stringify(row(copy.id))}))`), false);
  await click("#deleted-levels summary");
  await click(`#level-recovery [data-map-id="${copy.id}"]`);
  await waitFor(`document.querySelector(${JSON.stringify(row(copy.id))})`);
  await selectLevel(copy.id);
  await waitFor(`window.__studioTest.document().id === ${JSON.stringify(copy.id)} && !document.querySelector("#open-dialog").open`);
  assert.deepEqual(await design(), savedCopy, "recovery restores the same ID and independent saved document");
  await openGame(one.projectId, blank.id);
  assert.deepEqual(await design(), savedBlank, "editing and deleting duplicate did not change its source");
  await openGame(two.projectId, two.mapId);
  assert.deepEqual(await design(), other, "another game is unchanged");
  assert.equal(await evaluate('document.querySelector("#level-select").options.length'), 1);
  await openGame("astraeum-tower", "astraeum-tower-floor-1");
  assert.deepEqual(await design(), JSON.parse(original), "existing Tower design is unchanged");
  const check = new DatabaseSync(database);
  assert.equal(check.prepare("SELECT document_json FROM maps WHERE map_id = 'astraeum-tower-floor-1'").get().document_json, original);
  assert.equal(check.prepare("SELECT document_json FROM map_backups WHERE id = 41").get().document_json, "untouched backup");
  assert.equal(check.prepare("SELECT backup_id FROM migrations WHERE id = 51").get().backup_id, 41);
  check.close();
  assert.deepEqual(exceptions, []);
  console.log("Levels UI passed via direct CDP: blank Tower/Generic, independent duplicate, rename, starting level, unsaved cancel/discard/save, restart/reopen, delete/recover, isolation, selected-level Play/Stop and untouched legacy backups.");
  }
} finally {
  if (socket?.readyState === WebSocket.OPEN) socket.close();
  for (const child of children.reverse()) await stopChild(child);
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
