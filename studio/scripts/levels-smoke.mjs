import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import {
  collisionRect,
  createFloorDocument,
  createFloorMap,
  floorDocumentGrid,
  objectBounds
} from "../../games/astraeum-tower/src/project.js";

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
const networkFailures = [];
const consoleErrors = [];
const readiness = [];
const requests = new Map();
let failure;
let collisionEvidence;
let cameraEvidence;
const draftEvidence = [];
let responseFault;
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
async function waitFor(expression, isReady = value => value) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (isReady(await evaluate(expression))) return;
    await delay(25);
  }
  throw new Error(`UI timed out: ${expression}\n${await evaluate('document.querySelector("#status").textContent')}`);
}
async function reloadDesign(identity) {
  await evaluate("window.__beforeReload = true");
  await cdp("Page.reload", { ignoreCache: true });
  let previous;
  await waitFor(`(() => {
    const helper = window.__studioTest;
    const identity = helper?.identity();
    const state = {
      newPage: window.__beforeReload === undefined,
      readyState: document.readyState,
      helper: Boolean(helper),
      identity,
      mapId: helper?.document()?.id,
      selectedMapId: document.querySelector("#level-select")?.value,
      status: document.querySelector("#status")?.textContent,
      statusError: document.querySelector("#status")?.classList.contains("error"),
      saveState: document.querySelector("#save-state")?.textContent
    };
    return state;
  })()`, snapshot => {
    const serialized = JSON.stringify(snapshot);
    if (serialized !== previous) {
      readiness.push(snapshot);
      console.log("Reload readiness:", serialized);
      previous = serialized;
    }
    assert.deepEqual(exceptions, [], "reload must not hide page errors");
    if (snapshot.newPage && snapshot.statusError) {
      throw new Error(`Studio startup failed: ${snapshot.status}`);
    }
    return snapshot.newPage && snapshot.readyState === "complete" && snapshot.helper &&
      snapshot.identity?.projectId === identity.projectId && snapshot.identity?.mapId === identity.mapId &&
      snapshot.mapId === identity.mapId && snapshot.selectedMapId === identity.mapId;
  });
}
async function clickAt(x, y) {
  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}
async function click(selector) {
  if (await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)});
    return e?.closest("#level-menu") && e.tagName !== "SUMMARY" && !document.querySelector("#level-menu").open; })()`)) {
    await click("#level-menu > summary");
  }
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
  const selector = `.open-entry[data-project-id="${projectId}"] input`;
  await click(selector);
  await click("#open-selected");
  await waitFor('!document.querySelector("#open-dialog").open');
  await waitFor(`document.querySelector(${JSON.stringify(row(mapId))})`);
  if ((await design()).id !== mapId) {
    await selectLevel(mapId);
    await waitFor(`!document.querySelector("#open-dialog").open && window.__studioTest.document().id === ${JSON.stringify(mapId)}`);
  }
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
  await click("#map-canvas");
  await waitFor('document.querySelector("#save-state").textContent.includes("Unsaved")');
  await selectTool();
}
async function selectTool() {
  await click("#editor-tool");
  for (const [key, code] of [["Home", 36], ["Enter", 13]]) {
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, windowsVirtualKeyCode: code });
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: code });
  }
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

async function mapSettingsChecks() {
  const initial = await design();
  assert.deepEqual(initial.bounds, { width: 1152, height: 704 }, "existing Astraeum dimensions stay unchanged on open");
  assert.equal(initial.cameraZoom, 1, "legacy maps default to gameplay camera zoom 1.0");
  const originalObjects = structuredClone(initial.objects);
  const originalCollisions = initial.objects.filter(object => object.collision)
    .map(object => ({ id: object.id, transform: object.transform, collision: collisionRect(object) }));

  await fill("#map-width", "2048");
  assert.equal(await evaluate('document.querySelector("#map-height").value'), "704",
    "editing width leaves the height draft untouched");
  await fill("#map-height", "2048");
  assert.deepEqual(await evaluate(`({
    width: document.querySelector("#map-width").value,
    height: document.querySelector("#map-height").value
  })`), { width: "2048", height: "2048" }, "width-first draft retains both values");
  await click("#cancel-map-size");
  await waitFor('document.querySelector("#map-width").value === "1152" && document.querySelector("#map-height").value === "704"');
  assert.deepEqual((await design()).bounds, initial.bounds, "cancel discards dimensions without changing the saved level");

  await fill("#map-width", "2048");
  await fill("#map-height", "2048");
  await click("#apply-map-size");
  await waitFor('window.__studioTest.document().bounds.width === 2048 && window.__studioTest.document().bounds.height === 2048');
  let expanded = await design();
  assert.deepEqual(expanded.objects, originalObjects, "expansion preserves every existing transform and object");
  const expandedMap = createFloorMap(expanded);
  assert.deepEqual(expandedMap.bounds, { width: 2048, height: 2048 });
  const runtimeCollisionCount = expandedMap.collisions.length;
  const expandedGrid = floorDocumentGrid(expanded);
  assert.equal(expandedGrid.length, 64);
  assert.equal(expandedGrid[60].length, 64);
  assert.equal(expandedGrid[60][60], ".", "new space is open but contains no implicit floor or blockers");
  assert.ok(expanded.objects.every(object => {
    const bounds = objectBounds(object);
    return bounds.x + bounds.width <= initial.bounds.width && bounds.y + bounds.height <= initial.bounds.height;
  }), "expansion leaves added space empty");

  await click("#undo");
  await waitFor('window.__studioTest.document().bounds.width === 1152 && window.__studioTest.document().bounds.height === 704');
  assert.deepEqual(await design().then(document => document.objects), originalObjects, "undo restores only the old dimensions");
  await click("#redo");
  await waitFor('window.__studioTest.document().bounds.width === 2048 && window.__studioTest.document().bounds.height === 2048');
  expanded = await design();
  assert.deepEqual(expanded.objects, originalObjects, "redo restores expansion without altering objects");

  await click("#undo");
  await waitFor('window.__studioTest.document().bounds.width === 1152 && window.__studioTest.document().bounds.height === 704');
  await fill("#map-height", "2048");
  assert.equal(await evaluate('document.querySelector("#map-width").value'), "1152",
    "editing height leaves the width draft untouched");
  await fill("#map-width", "2048");
  assert.deepEqual(await evaluate(`({
    width: document.querySelector("#map-width").value,
    height: document.querySelector("#map-height").value
  })`), { width: "2048", height: "2048" }, "height-first draft retains both values");
  await click("#apply-map-size");
  await waitFor('window.__studioTest.document().bounds.width === 2048 && window.__studioTest.document().bounds.height === 2048');
  await click("#undo");
  await waitFor('window.__studioTest.document().bounds.width === 1152 && window.__studioTest.document().bounds.height === 704');
  await click("#redo");
  await waitFor('window.__studioTest.document().bounds.width === 2048 && window.__studioTest.document().bounds.height === 2048');
  expanded = await design();
  assert.deepEqual(expanded.objects, originalObjects, "height-first apply and undo/redo preserve all objects");

  await click('#object-tree [data-object-id="aries-start"]');
  // Keep the entire collision lane inside the centered-follow region at zoom 1.5.
  await fill("#object-x", "1280");
  await fill("#object-y", "1504");
  await selectTool();
  await waitFor(`(() => {
    const spawn = window.__studioTest.document().objects.find(object => object.id === "aries-start");
    return spawn.transform.x === 1296 && spawn.transform.y === 1520;
  })()`);
  const editedSpawn = (await design()).objects.find(object => object.id === "aries-start");
  const playerHalfWidth = 9;
  const playerHalfHeight = 8;
  const bodyBounds = position => ({
    x: position.x - playerHalfWidth,
    y: position.y - playerHalfHeight,
    width: playerHalfWidth * 2,
    height: playerHalfHeight
  });
  const fixtureWall = originalObjects.find(object => object.type === "wall" && object.collision);
  const fixtureWallBounds = collisionRect(fixtureWall);
  const wallBounds = {
    x: editedSpawn.transform.x + expanded.cellSize * 2.5,
    y: editedSpawn.transform.y - fixtureWallBounds.height / 2,
    width: fixtureWallBounds.width,
    height: fixtureWallBounds.height
  };
  const wallTransform = {
    x: wallBounds.x - fixtureWall.collision.x,
    y: wallBounds.y - fixtureWall.collision.y
  };
  await click('.asset-card[data-asset-id="wall-damp-stone"]');
  await evaluate("window.__studioTest.setView({ zoom: 0.5, cameraX: 0, cameraY: 0 })");
  const wallPoint = await evaluate(`window.__studioTest.worldToClient(
    ${wallBounds.x + wallBounds.width / 2}, ${wallBounds.y + wallBounds.height / 2})`);
  await clickAt(wallPoint.x, wallPoint.y);
  await waitFor(`window.__studioTest.document().objects.some(object =>
    object.type === "wall" && object.transform.x === ${wallTransform.x} && object.transform.y === ${wallTransform.y})`);
  const placedWall = (await design()).objects.find(object =>
    object.type === "wall" && object.transform.x === wallTransform.x && object.transform.y === wallTransform.y);
  const placedWallBounds = collisionRect(placedWall);
  const spawnBodyBounds = bodyBounds({ x: editedSpawn.transform.x, y: editedSpawn.transform.y + 8 });
  assert.ok(spawnBodyBounds.y < placedWallBounds.y + placedWallBounds.height &&
    spawnBodyBounds.y + spawnBodyBounds.height > placedWallBounds.y,
  `spawn body and wall must overlap in the movement lane; spawn body=${JSON.stringify(spawnBodyBounds)}, wall=${JSON.stringify(placedWallBounds)}`);
  await click("#player-settings");
  await waitFor('document.querySelector("#player-settings-dialog").open');
  await click("#camera-zoom");
  for (const [key, code, count] of [["Home", 36, 1], ["ArrowRight", 39, 10]]) {
    for (let index = 0; index < count; index += 1) {
      await cdp("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, windowsVirtualKeyCode: code });
      await cdp("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: code });
    }
  }
  await click("#player-settings-close");
  await waitFor('window.__studioTest.document().cameraZoom === 1.5');
  await save();

  const saved = await design();
  const newWall = saved.objects.find(object => object.type === "wall" && object.transform.x >= 1152);
  assert.ok(newWall, "the editor places a wall beyond the original east boundary");
  const savedAries = saved.objects.find(object => object.id === "aries-start");
  assert.deepEqual(savedAries.transform, {
    x: 1280 + saved.cellSize / 2,
    y: 1504 + saved.cellSize / 2
  }, "the test start snaps from its tile origin to the centered spawn pivot in the expanded area");
  const persistedResponse = await fetch(`http://127.0.0.1:${apiPort}/api/projects/astraeum-tower/maps/astraeum-tower-floor-1`);
  const persisted = await persistedResponse.json();
  assert.equal(persisted.document.cameraZoom, 1.5);
  assert.deepEqual(persisted.document.bounds, { width: 2048, height: 2048 });
  await reloadDesign({ projectId: "astraeum-tower", mapId: saved.id });
  assert.deepEqual(await design(), saved, "dimensions, placed collision, spawn, and camera zoom save and reopen");
  const reopenedCollisions = (await design()).objects.filter(object => originalCollisions.some(old => old.id === object.id))
    .map(object => ({ id: object.id, transform: object.transform, collision: collisionRect(object) }));
  assert.deepEqual(reopenedCollisions, originalCollisions, "all original collision geometry is unchanged");

  const editorView = await evaluate("window.__studioTest.view()");
  await click("#play");
  await waitFor('document.querySelector("#studio").dataset.playState === "playing" && document.querySelector("[data-testid=astraeum-world]")');
  const firstView = await evaluate(`(() => {
    const canvas = document.querySelector('[data-testid="astraeum-world"]');
    return { zoom: Number(canvas.dataset.cameraZoom), scale: Number(canvas.dataset.worldScale),
      width: Number(canvas.dataset.worldWidth), height: Number(canvas.dataset.worldHeight),
      viewportWidth: Number(canvas.dataset.viewportWidth), viewportHeight: Number(canvas.dataset.viewportHeight),
      collisionCount: Number(canvas.dataset.collisionRectangles),
      x: Number(canvas.dataset.x), y: Number(canvas.dataset.y),
      tick: Number(canvas.dataset.simulationTick), cameraX: Number(canvas.dataset.cameraX),
      playerScreenX: Number(canvas.dataset.playerScreenX),
      lightScreenX: Number(canvas.dataset.lightingScreenX),
      lightScreenY: Number(canvas.dataset.lightingScreenY),
      playerScreenY: Number(canvas.dataset.playerScreenY) };
  })()`);
  assert.equal(firstView.zoom, 1.5);
  assert.equal(firstView.scale, 1.5, "world artwork is enlarged at gameplay zoom 1.5");
  assert.deepEqual([firstView.width, firstView.height], [2048, 2048]);
  assert.equal(firstView.collisionCount, runtimeCollisionCount + 1);
  const actualWallBounds = collisionRect(newWall);
  const startPosition = { x: firstView.x, y: firstView.y };
  const startTick = firstView.tick;
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
  await delay(300);
  const approach = await evaluate(`(() => {
    const canvas = document.querySelector('[data-testid="astraeum-world"]');
    return { x: Number(canvas.dataset.x), y: Number(canvas.dataset.y),
      tick: Number(canvas.dataset.simulationTick) };
  })()`);
  await delay(1500);
  const stopped = await evaluate(`(() => {
    const canvas = document.querySelector('[data-testid="astraeum-world"]');
    return { x: Number(canvas.dataset.x), y: Number(canvas.dataset.y),
      tick: Number(canvas.dataset.simulationTick) };
  })()`);
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
  const blocked = await evaluate(`(() => {
    const canvas = document.querySelector('[data-testid="astraeum-world"]');
    return { worldScale: Number(canvas.dataset.worldScale),
      tick: Number(canvas.dataset.simulationTick), x: Number(canvas.dataset.x), y: Number(canvas.dataset.y),
      cameraY: Number(canvas.dataset.cameraY), zoom: Number(canvas.dataset.cameraZoom),
      height: Number(canvas.dataset.viewportHeight),
      cssWidth: canvas.clientWidth, cssHeight: canvas.clientHeight,
      worldWidth: Number(canvas.dataset.worldWidth), worldHeight: Number(canvas.dataset.worldHeight),
      cameraX: Number(canvas.dataset.cameraX), width: Number(canvas.dataset.viewportWidth),
      playerScreenX: Number(canvas.dataset.playerScreenX),
      lightScreenX: Number(canvas.dataset.lightingScreenX), lightScreenY: Number(canvas.dataset.lightingScreenY),
      playerScreenY: Number(canvas.dataset.playerScreenY) };
  })()`);
  const startBodyBounds = bodyBounds(startPosition);
  const approachBodyBounds = bodyBounds(approach);
  const finalBodyBounds = bodyBounds(stopped);
  collisionEvidence = {
    heldInput: ["ArrowRight"],
    ticks: { start: startTick, approach: approach.tick, final: stopped.tick },
    positions: { start: startPosition, approach: { x: approach.x, y: approach.y }, final: { x: stopped.x, y: stopped.y } },
    bodyBounds: { start: startBodyBounds, approach: approachBodyBounds, final: finalBodyBounds },
    wallBounds: actualWallBounds,
    expected: {
      approachXGreaterThan: startPosition.x,
      approachXLessThan: actualWallBounds.x - playerHalfWidth,
      finalXAtMost: actualWallBounds.x - playerHalfWidth,
      finalXAtLeast: actualWallBounds.x - playerHalfWidth - 2,
      finalBodyRightAtMost: actualWallBounds.x
    }
  };
  console.log("Play collision evidence:", JSON.stringify(collisionEvidence));
  const expectedCameraAxis = (position, viewportSize, worldSize) => {
    const visibleSize = viewportSize / blocked.zoom;
    return visibleSize >= worldSize ? (worldSize - visibleSize) / 2
      : Math.max(0, Math.min(worldSize - visibleSize, position - visibleSize / 2));
  };
  cameraEvidence = {
    sample: blocked,
    expected: {
      cameraX: expectedCameraAxis(blocked.x, blocked.width, blocked.worldWidth),
      cameraY: expectedCameraAxis(blocked.y, blocked.height, blocked.worldHeight),
      centeredScreenX: blocked.width / 2,
      maximumCenterError: 1
    },
    actualCenterError: Math.abs(blocked.playerScreenX - blocked.width / 2)
  };
  console.log("Play camera evidence:", JSON.stringify(cameraEvidence));
  assert.ok(approach.x > startPosition.x && approach.x < actualWallBounds.x - playerHalfWidth,
    `player should approach without reaching the wall; actual=${JSON.stringify(approach)}, expected x in (${startPosition.x}, ${actualWallBounds.x - playerHalfWidth})`);
  assert.ok(stopped.x > approach.x,
    `player should continue toward the wall while input is held; actual=${stopped.x}, expected > ${approach.x}`);
  assert.ok(stopped.x <= actualWallBounds.x - playerHalfWidth,
    `player body must not penetrate the wall; actual body=${JSON.stringify(finalBodyBounds)}, wall=${JSON.stringify(actualWallBounds)}`);
  assert.ok(stopped.x >= actualWallBounds.x - playerHalfWidth - 2,
    `player should stop at the wall; actual x=${stopped.x}, expected >= ${actualWallBounds.x - playerHalfWidth - 2}`);
  assert.ok(finalBodyBounds.y < actualWallBounds.y + actualWallBounds.height &&
    finalBodyBounds.y + finalBodyBounds.height > actualWallBounds.y,
  `player body must overlap the wall's lane; actual body=${JSON.stringify(finalBodyBounds)}, wall=${JSON.stringify(actualWallBounds)}`);
  assert.ok(approach.tick > startTick && stopped.tick > approach.tick,
    `simulation ticks should advance while ArrowRight is held; actual=${JSON.stringify(collisionEvidence.ticks)}`);
  assert.ok(Math.abs(blocked.playerScreenX - blocked.width / 2) <= 1, "camera follows at the first viewport size");
  assert.equal(blocked.lightScreenX, blocked.playerScreenX, "zoom keeps the player light aligned horizontally");
  assert.ok(Math.abs(blocked.lightScreenY - (blocked.playerScreenY - 30)) <= 0.01,
    "zoom keeps the player light aligned vertically");

  await cdp("Emulation.setDeviceMetricsOverride", { width: 1100, height: 850, deviceScaleFactor: 1, mobile: false });
  await delay(250);
  const smallerViewport = await evaluate(`(() => {
    const canvas = document.querySelector('[data-testid="astraeum-world"]');
    return { zoom: Number(canvas.dataset.cameraZoom), scale: Number(canvas.dataset.worldScale),
      cameraX: Number(canvas.dataset.cameraX), width: Number(canvas.dataset.viewportWidth),
      playerScreenX: Number(canvas.dataset.playerScreenX),
      lightScreenX: Number(canvas.dataset.lightingScreenX) };
  })()`);
  assert.equal(smallerViewport.zoom, 1.5);
  assert.equal(smallerViewport.scale, 1.5, "a viewport resize does not change gameplay zoom or artwork scale");
  assert.notEqual(smallerViewport.width, blocked.width);
  assert.ok(Math.abs(smallerViewport.playerScreenX - smallerViewport.width / 2) <= 1,
    "camera follows at the resized viewport");
  assert.equal(smallerViewport.lightScreenX, smallerViewport.playerScreenX);
  await click("#stop");
  await waitFor('document.querySelector("#studio").dataset.playState === "idle"');
  assert.deepEqual(await evaluate("window.__studioTest.view()"), editorView, "Play preserves independent editor zoom and pan");

  await click("#player-settings");
  await click("#camera-zoom");
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Home", code: "Home", windowsVirtualKeyCode: 36 });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Home", code: "Home", windowsVirtualKeyCode: 36 });
  await click("#player-settings-close");
  await waitFor('window.__studioTest.document().cameraZoom === 0.5');
  await save();
  await reloadDesign({ projectId: "astraeum-tower", mapId: saved.id });
  assert.equal((await design()).cameraZoom, 0.5);
  await click("#play");
  await waitFor('document.querySelector("#studio").dataset.playState === "playing" && document.querySelector("[data-testid=astraeum-world]")');
  assert.equal(await evaluate('Number(document.querySelector("[data-testid=astraeum-world]").dataset.worldScale)'), 0.5,
    "smaller configured zoom shows more world without viewport-fit scaling");
  await click("#stop");
  await waitFor('document.querySelector("#studio").dataset.playState === "idle"');

  await cdp("Emulation.setDeviceMetricsOverride", { width: 1800, height: 1100, deviceScaleFactor: 1, mobile: false });
  await delay(150);
  const blankTower = await operation("add", "Blank Tower default");
  assert.deepEqual(blankTower.bounds, { width: 2048, height: 2048 }, "new Tower levels default to 2048 x 2048");
  await selectLevel(initial.id);
  await waitFor(`window.__studioTest.document().id === ${JSON.stringify(initial.id)} && !document.querySelector("#open-dialog").open`);
  await click("#new-game");
  assert.equal(await evaluate('document.querySelector("#new-width") === null && document.querySelector("#new-height") === null'),
    true, "New Game has no editable dimensions");
  assert.equal(await evaluate('document.querySelector("#new-world-size").textContent.includes("2048 × 2048")'),
    true, "New Game states the fixed world size");
  await fill("#new-name", "Default dimensions");
  await fill("#new-author", "Disposable map settings test");
  await click("#new-create");
  await waitFor('!document.querySelector("#new-dialog").open && window.__studioTest.document().bounds.width === 2048');
  assert.deepEqual((await design()).bounds, { width: 2048, height: 2048 }, "new games default to 2048 x 2048");
  const blankGeneric = await operation("add", "Blank Grid default");
  assert.deepEqual(blankGeneric.bounds, { width: 2048, height: 2048 }, "new Generic Grid levels default to 2048 x 2048");
  assert.deepEqual(exceptions, []);
  console.log("Map dimensions and camera settings passed via disposable direct CDP: unchanged 1152x704 open, undoable 2048 expansion, empty new space, extended placement and collision, save/reopen, both-model defaults, saved zoom, resized Play viewports, lighting alignment and independent editor zoom.");
}

async function dropdownChecks() {
  const firstGame = await createGame("Open Game grouping");
  const originalStart = await design();
  const designatedStart = await operation("add", "Designated start");
  await click("#level-start");
  await waitFor(`document.querySelector(${JSON.stringify(row(designatedStart.id))}).textContent.includes("(Start)")`);
  const secondGame = await createGame("Separate game");

  await click("#open-game");
  await waitFor(`document.querySelector('.open-entry[data-project-id="${firstGame.projectId}"]') &&
    document.querySelector('.open-entry[data-project-id="${secondGame.projectId}"]')`);
  const projectEntries = await evaluate(`Array.from(document.querySelectorAll("#open-list .open-entry")).map(entry => ({
    projectId: entry.dataset.projectId, text: entry.textContent
  }))`);
  assert.equal(projectEntries.filter(entry => entry.projectId === firstGame.projectId).length, 1,
    "two levels in one game produce one Open Game entry");
  assert.equal(projectEntries.filter(entry => entry.projectId === secondGame.projectId).length, 1,
    "a separate game produces a separate Open Game entry");
  const firstEntryText = projectEntries.find(entry => entry.projectId === firstGame.projectId).text;
  assert.match(firstEntryText, /Open Game grouping/);
  assert.match(firstEntryText, /2 active levels/);
  assert.doesNotMatch(firstEntryText, /Designated start/);

  await click(`.open-entry[data-project-id="${firstGame.projectId}"] input`);
  await click("#open-selected");
  await waitFor(`!document.querySelector("#open-dialog").open &&
    window.__studioTest.document().id === ${JSON.stringify(designatedStart.id)}`);
  await waitFor(`document.querySelector(${JSON.stringify(row(originalStart.id))})`);
  assert.equal(await evaluate('document.querySelector("#level-select").options.length'), 2,
    "other levels remain available in the Levels dropdown");
  assert.equal((await (await fetch(`http://127.0.0.1:${apiPort}/api/projects/${firstGame.projectId}/levels`))
    .json()).startingMapId, designatedStart.id, "opening does not change the designated start metadata");
  await selectLevel(originalStart.id);
  await waitFor(`window.__studioTest.document().id === ${JSON.stringify(originalStart.id)} &&
    !document.querySelector("#open-dialog").open`);
  assert.deepEqual(await design(), originalStart, "the Levels dropdown still opens another level unchanged");

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
  console.log("Open Game and Levels passed via disposable direct CDP: one entry per project, designated-start opening, level switching, unsaved cancellation, selected-level actions, recovery and Play/Stop disabled states.");
}

async function draftRecoveryChecks() {
  const snapshot = () => evaluate(`({
    identity: window.__studioTest.identity(), document: window.__studioTest.document(),
    view: window.__studioTest.view(),
    status: document.querySelector("#status").textContent,
    controls: Object.fromEntries(["save", "play", "open-game", "level-select", "undo", "switch-cancel", "open-cancel"]
      .map(id => [id, document.getElementById(id).disabled])),
    inert: document.querySelector(".workspace").inert,
    selected: document.querySelector("#map-canvas").dataset.selectedId
  })`);
  async function record(step) {
    assert.deepEqual(exceptions, [], `${step}: no uncaught browser errors`);
    draftEvidence.push({ step, ...await snapshot() });
    await writeFile(resolve(directory, "draft-evidence.json"), JSON.stringify(draftEvidence, null, 2));
    const image = await cdp("Page.captureScreenshot", { format: "png" });
    await writeFile(resolve(directory, `${String(draftEvidence.length).padStart(2, "0")}-${step}.png`),
      Buffer.from(image.data, "base64"));
    console.log(`Draft UI passed: ${step}`);
  }
  async function controlsRecovered(expected) {
    assert.deepEqual(await design(), expected, "failure preserves every draft object and setting");
    const current = await snapshot();
    assert.equal(current.inert, false);
    for (const id of ["save", "play", "open-game", "level-select", "undo"]) {
      assert.equal(current.controls[id], false, `${id} recovers after failure`);
    }
  }
  async function faultResponse(method, path, body) {
    responseFault = { method, path, body };
    await cdp("Fetch.enable", { patterns: [{ urlPattern: `*${path}`, requestStage: "Request" }] });
  }
  async function endFault() {
    assert.equal(responseFault, null, "the intended request consumed the injected failure");
    await cdp("Fetch.disable");
  }
  async function renderFault(targetId = null) {
    await evaluate(`(() => {
      window.__originalDrawImage = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function(...args) {
        if (this.canvas.id === "map-canvas" && (${JSON.stringify(targetId)} === null ||
            window.__studioTest.document().id === ${JSON.stringify(targetId)})) {
          throw new Error("Injected editor render failure");
        }
        return window.__originalDrawImage.apply(this, args);
      };
    })()`);
  }
  async function restoreRendering() {
    await evaluate(`CanvasRenderingContext2D.prototype.drawImage = window.__originalDrawImage;
      delete window.__originalDrawImage`);
  }
  const initial = await design();
  const initialId = initial.id;
  const copy = await operation("duplicate", "Disposable switch target");
  await selectLevel(initialId);
  await waitFor(`window.__studioTest.document().id === ${JSON.stringify(initialId)} && !document.querySelector("#open-dialog").open`);
  if (!await evaluate('document.querySelector(\'.tree-group[data-layer="spawns"]\').open')) {
    await click('.tree-group[data-layer="spawns"] > summary');
  }
  await click('.tree-item[data-object-id="aries-start"]');
  await click("#delete-object");
  const spawnFree = await design();
  assert.deepEqual(spawnFree, { ...initial, objects: initial.objects.filter(object => object.id !== "aries-start") });
  assert.equal(await evaluate('document.querySelector("#map-canvas").dataset.selectedId'), "");
  const canvasColors = await evaluate(`(() => {
    const c = document.querySelector("#map-canvas");
    const pixels = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    const colors = new Set();
    for (let i = 0; i < pixels.length; i += 64) colors.add(pixels.slice(i, i + 3).join(","));
    return colors.size;
  })()`);
  assert.ok(canvasColors > 20, `spawn-free canvas is rendered (${canvasColors} colors)`);
  const otherSpawn = spawnFree.objects.find(object => object.type === "spawn");
  await click(`.tree-item[data-object-id="${otherSpawn.id}"]`);
  assert.equal(await evaluate('document.querySelector("#map-canvas").dataset.selectedId'), otherSpawn.id);
  await record("deleted-start-canvas-usable");
  await save();
  await click("#play");
  await waitFor('!document.querySelector("#play-error").hidden');
  assert.match(await evaluate('document.querySelector("#play-error-message").textContent'), /Aries player start is missing.*palette.*undo/i);
  assert.deepEqual(await design(), spawnFree, "Play does not invent replacement starts");
  await click("#play-error-close");
  await click("#undo");
  assert.deepEqual(await design(), initial, "one undo restores the exact authored start");
  await record("undo-restores-start");
  await click("#redo");
  assert.deepEqual(await design(), spawnFree);
  await selectLevel(copy.id);
  await waitFor(`window.__studioTest.document().id === ${JSON.stringify(copy.id)} && !document.querySelector("#open-dialog").open`);
  await selectLevel(initialId);
  await waitFor(`window.__studioTest.document().id === ${JSON.stringify(initialId)} && !document.querySelector("#open-dialog").open`);
  assert.deepEqual(await design(), spawnFree, "save and reopen retain the spawn-free draft exactly");
  await record("spawn-free-reopened");
  await click(`.tree-item[data-object-id="${otherSpawn.id}"]`);
  await fill("#object-x", String(otherSpawn.transform.x + 32));
  await click("#object-y");
  const edited = await design();
  assert.notDeepEqual(edited, spawnFree, "Inspector makes a real unsaved edit");
  await selectLevel(copy.id);
  await waitFor('!document.querySelector("#open-confirm").hidden');
  await click("#switch-cancel");
  await click("#open-cancel");
  await controlsRecovered(edited);
  await record("cancel-switch-preserves-draft");

  await faultResponse("PUT", `/api/projects/astraeum-tower/maps/${initialId}`, { error: "Injected save request failure" });
  await click("#save");
  await waitFor('document.querySelector("#status").textContent.includes("Injected save request failure")');
  await endFault();
  await controlsRecovered(edited);
  await record("failed-save-request-recovered");

  await renderFault();
  await click("#save");
  await waitFor('document.querySelector("#status").textContent.includes("Injected editor render failure")');
  await restoreRendering();
  await controlsRecovered(edited);
  await record("failed-save-render-recovered");

  await faultResponse("PUT", `/api/projects/astraeum-tower/maps/${initialId}`, {
    projectId: "astraeum-tower", mapId: initialId, model: "astraeum-floor-v2", document: { ...edited, cellSize: 1 }
  });
  await click("#save");
  await waitFor('document.querySelector("#status").textContent.startsWith("Save failed:") && !document.querySelector("#save").disabled');
  await endFault();
  await controlsRecovered(edited);
  await record("failed-save-validation-recovered");

  for (const kind of ["save-first", "request", "validation", "initial-render", "target-render"]) {
    await selectLevel(copy.id);
    await waitFor('!document.querySelector("#open-confirm").hidden');
    if (kind === "save-first") {
      await faultResponse("PUT", `/api/projects/astraeum-tower/maps/${initialId}`, { error: "Injected save-before-switch failure" });
    } else if (kind === "request") {
      await faultResponse("GET", `/api/projects/astraeum-tower/maps/${copy.id}`, { error: "Injected switch request failure" });
    } else if (kind === "validation") {
      await faultResponse("GET", `/api/projects/astraeum-tower/maps/${copy.id}`, {
        projectId: "astraeum-tower", mapId: copy.id, model: "astraeum-floor-v2", document: { ...copy, cellSize: 1 }
      });
    } else {
      await renderFault(kind === "target-render" ? copy.id : null);
    }
    await click(kind === "save-first" ? "#switch-save" : "#switch-discard");
    await waitFor('document.querySelector("#open-message").textContent.startsWith("Could not open map:") && !document.querySelector("#switch-cancel").disabled');
    if (["initial-render", "target-render"].includes(kind)) await restoreRendering();
    else await endFault();
    assert.deepEqual(await design(), edited);
    assert.equal(await evaluate('window.__studioTest.identity().mapId'), initialId);
    assert.equal(await evaluate('document.querySelector("#open-cancel").disabled'), false);
    await click("#switch-cancel");
    await click("#open-cancel");
    await controlsRecovered(edited);
    await record(`failed-switch-${kind}-recovered`);
  }
  await click("#undo");
  assert.deepEqual(await design(), spawnFree, "failed switches preserve undo history");
  await click("#redo");
  assert.deepEqual(await design(), edited);

  await wallAndClearChecks(record);
}

async function wallAndClearChecks(record) {
  const before = await design();
  const reference = await readFile(resolve(root, "reference", "astraeum-tower-original", "dungeon", "index.html"), "utf8");
  const wang = JSON.parse(reference.match(/const WANG = (\{[\s\S]*?\});/)[1].replaceAll("'", '"'));
  const viteFileUrl = file => `/@fs/${file.replaceAll("\\", "/")}`;
  const rendererUrl = viteFileUrl(resolve(root, "games", "astraeum-tower", "src", "design-render.js"));
  const projectUrl = viteFileUrl(resolve(root, "games", "astraeum-tower", "src", "project.js"));
  async function compareArtwork(step) {
    const result = await evaluate(`(async () => {
      const render = await import(${JSON.stringify(rendererUrl)});
      const project = await import(${JSON.stringify(projectUrl)});
      const design = window.__studioTest.document();
      const artwork = await render.loadArtwork();
      const actual = document.createElement("canvas"), expected = document.createElement("canvas");
      actual.width = expected.width = design.bounds.width;
      actual.height = expected.height = design.bounds.height;
      const a = actual.getContext("2d"), e = expected.getContext("2d");
      a.imageSmoothingEnabled = e.imageSmoothingEnabled = false;
      render.drawDesign(a, artwork, design, { decorations: false,
        visible: { terrain: true, walls: true, props: false } });
      e.fillStyle = "#0b0910"; e.fillRect(0, 0, expected.width, expected.height);
      const { floor, wall } = project.cellOccupancy(design);
      const F = (x, y) => floor[y]?.[x] && !wall[y][x] ? 1 : 0;
      const wang = ${JSON.stringify(wang)};
      for (let y = -1; y < floor.length; y++) for (let x = -1; x < floor[0].length; x++) {
        const key = "" + F(x,y) + F(x+1,y) + F(x,y+1) + F(x+1,y+1);
        const t = wang[key];
        e.drawImage(artwork.wang, t%4*32, Math.floor(t/4)*32, 32, 32, x*32+16, y*32+16, 32, 32);
      }
      for (const object of design.objects) if (object.type === "wall" && !project.isAutotiledWall(object)) {
        const t = wang["0000"];
        e.drawImage(artwork.wang, t%4*32, Math.floor(t/4)*32, 32, 32, object.transform.x, object.transform.y, 32, 32);
      }
      const actualPixels = a.getImageData(0, 0, actual.width, actual.height).data;
      const expectedPixels = e.getImageData(0, 0, expected.width, expected.height).data;
      let differentChannels = 0;
      for (let i = 0; i < actualPixels.length; i++) if (actualPixels[i] !== expectedPixels[i]) differentChannels++;
      return { differentChannels, comparedChannels: actualPixels.length,
        walls: design.objects.filter(o => o.type === "wall").map(o => ({
          id: o.id, x: o.transform.x, y: o.transform.y, autotiled: project.isAutotiledWall(o)
        })) };
    })()`);
    draftEvidence.push({ step, ...result });
    await writeFile(resolve(directory, "draft-evidence.json"), JSON.stringify(draftEvidence, null, 2));
    assert.equal(result.differentChannels, 0, "wall/floor artwork matches the original Wang renderer; off-grid walls use its solid-wall tile");
  }
  if (!await evaluate('document.querySelector(\'.tree-group[data-layer="walls"]\').open')) {
    await click('.tree-group[data-layer="walls"] > summary');
  }
  const wall = before.objects.find(object => object.type === "wall" && object.transform.x > 0 && object.transform.y > 0);
  assert.ok(wall, "the imported level contains a wall to compare");
  await click(`.tree-item[data-object-id="${wall.id}"]`);
  const view = await evaluate("window.__studioTest.view()");
  await evaluate(`window.__studioTest.setView({ zoom: 2, cameraX: ${wall.transform.x - 100}, cameraY: ${wall.transform.y - 100} })`);
  await compareArtwork("wall-imported-reference");
  await record("wall-before-move");
  if (await evaluate('document.querySelector("#snap-grid").checked')) await click("#snap-grid");
  await fill("#object-x", String(wall.transform.x + 5));
  await click("#object-y");
  const moved = await design();
  assert.deepEqual(moved.objects.filter(object => object.id !== wall.id), before.objects.filter(object => object.id !== wall.id),
    "moving a wall does not change or recreate floor/other objects");
  assert.deepEqual(moved.objects.find(object => object.id === wall.id).transform, { ...wall.transform, x: wall.transform.x + 5 });
  await compareArtwork("wall-imported-off-grid");
  await record("wall-moved-off-grid");
  await click("#undo");
  assert.deepEqual(await design(), before);
  await record("wall-undo");
  await click("#redo");
  assert.deepEqual(await design(), moved);
  await record("wall-redo");
  await evaluate(`window.__studioTest.setView(${JSON.stringify(view)})`);

  const alignedWallCells = new Set(before.objects.filter(object => object.type === "wall" &&
    object.transform.x % 32 === 0 && object.transform.y % 32 === 0)
    .map(object => `${object.transform.x},${object.transform.y}`));
  const openFloorCells = before.objects.filter(object => object.type === "terrain-tile" &&
    !alignedWallCells.has(`${object.transform.x},${object.transform.y}`))
    .map(object => object.transform);
  assert.ok(openFloorCells.length >= 2, "the imported level has open floor cells for new walls");
  await evaluate("window.__studioTest.setView({ zoom: 0.5, cameraX: 0, cameraY: 0 })");
  if (!await evaluate('document.querySelector("#snap-grid").checked')) await click("#snap-grid");
  await click('.asset-card[data-asset-id="wall-damp-stone"]');
  const snappedCell = openFloorCells[0];
  const snappedPoint = await evaluate(`window.__studioTest.worldToClient(${snappedCell.x + 16}, ${snappedCell.y + 16})`);
  await clickAt(snappedPoint.x, snappedPoint.y);
  await waitFor(`window.__studioTest.document().objects.some(object =>
    object.type === "wall" && object.transform.x === ${snappedCell.x} && object.transform.y === ${snappedCell.y})`);
  const snappedWall = (await design()).objects.find(object =>
    object.type === "wall" && object.transform.x === snappedCell.x && object.transform.y === snappedCell.y);
  assert.ok(snappedWall, "the newly placed wall snaps to the 32-pixel grid");
  await compareArtwork("wall-new-snapped");
  await record("wall-new-snapped");

  if (await evaluate('document.querySelector("#snap-grid").checked')) await click("#snap-grid");
  const offGridCell = openFloorCells.find(cell => cell.x !== snappedCell.x || cell.y !== snappedCell.y);
  await click('.asset-card[data-asset-id="wall-damp-stone"]');
  const offGridPoint = await evaluate(`window.__studioTest.worldToClient(${offGridCell.x + 21}, ${offGridCell.y + 21})`);
  await clickAt(offGridPoint.x, offGridPoint.y);
  await waitFor(`window.__studioTest.document().objects.some(object =>
    object.type === "wall" && object.transform.x === ${offGridCell.x + 5} && object.transform.y === ${offGridCell.y + 5})`);
  const newlyPlacedOffGridWall = (await design()).objects.find(object =>
    object.type === "wall" && object.transform.x === offGridCell.x + 5 && object.transform.y === offGridCell.y + 5);
  assert.ok(newlyPlacedOffGridWall, "the newly placed wall remains off-grid when snapping is disabled");
  await compareArtwork("wall-new-off-grid");
  await record("wall-new-off-grid");

  const contentsBeforeClear = await design();
  const allCategories = ["terrain", "walls", "props", "items", "collision", "spawns"];
  await click('.layer-row[data-layer="walls"] [data-action="lock"]');
  await click("#clear-level-contents");
  for (const category of allCategories) await click(`[data-clear-category="${category}"]`);
  const categoryTypes = {
    terrain: "terrain-tile", walls: "wall", props: "prop", items: "item",
    collision: "collision", spawns: "spawn"
  };
  const categoryCounts = Object.fromEntries(allCategories.map(category => {
    const objects = contentsBeforeClear.objects.filter(object => object.type === categoryTypes[category]);
    const skipped = objects.filter(object => ["terrain", "walls"].includes(object.layer)).length;
    return [category, {
      affected: objects.length - skipped,
      skipped,
      display: `${objects.length - skipped} affected${skipped ? ` · ${skipped} locked skipped` : ""}`
    }];
  }));
  assert.deepEqual(await evaluate(`Object.fromEntries(${JSON.stringify(allCategories)}.map(category => [
    category, document.querySelector("#clear-count-" + category).textContent
  ]))`), Object.fromEntries(allCategories.map(category => [category, categoryCounts[category].display])),
  "the dialog reports affected and locked counts for every category");
  const locked = contentsBeforeClear.objects.filter(object => ["terrain", "walls"].includes(object.layer));
  const affected = contentsBeforeClear.objects.length - locked.length;
  assert.equal(await evaluate('document.querySelector("#clear-contents-summary").textContent'),
    `${affected} objects will be removed; ${locked.length} locked objects will be skipped.`);
  await click("#clear-contents-cancel");
  assert.deepEqual(await design(), contentsBeforeClear, "cancelling clear preserves all content");
  await click("#clear-level-contents");
  for (const category of allCategories) await click(`[data-clear-category="${category}"]`);
  await click("#clear-contents-confirm");
  const cleared = await design();
  assert.deepEqual(cleared, { ...contentsBeforeClear, objects: locked },
    "only unlocked selected categories are removed, without replacement spawns");
  await record("clear-locked-counts-and-content");
  await click("#undo");
  assert.deepEqual(await design(), contentsBeforeClear, "clear is one undoable edit");
  await click("#redo");
  assert.deepEqual(await design(), cleared);
  await save();
  await reloadDesign({ projectId: "astraeum-tower", mapId: cleared.id });
  assert.deepEqual(await design(), cleared, "cleared spawn-free draft survives reload");
  await click("#play");
  await waitFor('!document.querySelector("#play-error").hidden');
  assert.match(await evaluate('document.querySelector("#play-error-message").textContent'), /Aries player start is missing/);
  assert.deepEqual(await design(), cleared);
  await record("clear-saved-reopened-play-blocked");
}

try {
  service = startService();
  await ready(`http://127.0.0.1:${apiPort}/api/projects`, service);
  web = launch(process.execPath, [process.env.STUDIO_VITE_BIN ??
    resolve(root, "games", "sample", "node_modules", "vite", "bin", "vite.js"),
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
    if (message.method === "Fetch.requestPaused") {
      const { requestId, request } = message.params;
      if (responseFault && request.method === responseFault.method && new URL(request.url).pathname === responseFault.path) {
        const { body } = responseFault;
        responseFault = null;
        cdp("Fetch.fulfillRequest", {
          requestId, responseCode: body.error ? 503 : 200,
          responseHeaders: [{ name: "content-type", value: "application/json" }],
          body: Buffer.from(JSON.stringify(body)).toString("base64")
        }).catch(error => { exceptions.push({ interceptionError: error.message }); });
      } else {
        cdp("Fetch.continueRequest", { requestId }).catch(error => { exceptions.push({ interceptionError: error.message }); });
      }
    }
    if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails);
    if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
      consoleErrors.push(message.params);
    }
    if (message.method === "Network.requestWillBeSent") {
      requests.set(message.params.requestId, message.params.request.url);
    }
    if (message.method === "Network.loadingFailed") {
      networkFailures.push({ ...message.params, url: requests.get(message.params.requestId) });
      requests.delete(message.params.requestId);
    }
    if (message.method === "Network.responseReceived" && message.params.response.status >= 400) {
      const { url, status, statusText } = message.params.response;
      networkFailures.push({ url, status, statusText });
    }
    if (message.method === "Network.loadingFinished") requests.delete(message.params.requestId);
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
  await cdp("Network.enable");
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1800, height: 1100, deviceScaleFactor: 1, mobile: false });
  await cdp("Page.navigate", { url: origin });
  await waitFor('window.__studioTest?.document() && document.querySelector("#level-select option")');
  if (process.argv.includes("--wall-clear-only")) {
    await openGame("astraeum-tower", "astraeum-tower-floor-1");
    const record = async step => {
      assert.deepEqual(exceptions, [], `${step}: no uncaught browser errors`);
      draftEvidence.push({
        step,
        identity: await evaluate("window.__studioTest.identity()"),
        document: await design(),
        view: await evaluate("window.__studioTest.view()"),
        status: await evaluate('document.querySelector("#status").textContent')
      });
      await writeFile(resolve(directory, "draft-evidence.json"), JSON.stringify(draftEvidence, null, 2));
      const image = await cdp("Page.captureScreenshot", { format: "png" });
      await writeFile(resolve(directory, `${String(draftEvidence.length).padStart(2, "0")}-${step}.png`),
        Buffer.from(image.data, "base64"));
      console.log(`Wall/clear UI passed: ${step}`);
    };
    await wallAndClearChecks(record);
    assert.deepEqual(exceptions, []);
    console.log("Wall artwork comparison and Clear Level Contents passed via disposable direct CDP.");
  } else if (process.argv.includes("--draft-recovery-only")) {
    await draftRecoveryChecks();
  } else if (process.argv.includes("--map-settings-only")) {
    await mapSettingsChecks();
  } else if (process.argv.includes("--dropdown-only")) {
    await dropdownChecks();
  } else {
  const towerBlank = await operation("add", "Empty Tower");
  assert.deepEqual(towerBlank.objects, [], "new Tower levels contain no cobblestone or starts");
  await openGame("astraeum-tower", "astraeum-tower-floor-1");
  await preview("astraeum-world");
  const one = await createGame("Levels One");
  assert.equal(await evaluate('document.querySelector("#level-delete").disabled'), true);
  const first = await design();
  await placeMarker();
  await save();
  const editedFirst = await design();
  const blank = await operation("add", "Blank room");
  assert.deepEqual(blank.objects, [], "blank levels have no objects or copied placements");
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
  for (const [assetId, x, y] of [["generic-player", 320, 320], ["generic-player-2", 416, 320]]) {
    await click(`.asset-card[data-asset-id="${assetId}"]`);
    const point = await evaluate(`window.__studioTest.worldToClient(${x},${y})`);
    await clickAt(point.x, point.y);
  }
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
} catch (error) {
  failure = error.stack ?? String(error);
  throw error;
} finally {
  if (socket?.readyState === WebSocket.OPEN && sessionId) {
    try {
      readiness.push({ final: await evaluate(`({
        readyState: document.readyState,
        helper: Boolean(window.__studioTest),
        identity: window.__studioTest?.identity(),
        mapId: window.__studioTest?.document()?.id,
        selectedMapId: document.querySelector("#level-select")?.value,
        status: document.querySelector("#status")?.textContent,
        statusError: document.querySelector("#status")?.classList.contains("error"),
        saveState: document.querySelector("#save-state")?.textContent
      })`) });
    } catch (error) {
      readiness.push({ diagnosticError: error.message });
    }
  }
  try {
    if (socket?.readyState === WebSocket.OPEN) socket.close();
    for (const child of [...children].reverse()) await stopChild(child);
  } finally {
    await writeFile(resolve(directory, "diagnostics.json"),
      JSON.stringify({ failure, collisionEvidence, cameraEvidence, draftEvidence, exceptions, consoleErrors, networkFailures, readiness }, null, 2));
    for (const [index, child] of children.entries()) {
      await writeFile(resolve(directory, `process-${index}.log`), child.output);
    }
    console.log(`Smoke artifacts preserved: ${directory}`);
    console.log(`Page errors: ${exceptions.length}; console errors: ${consoleErrors.length}; network failures: ${networkFailures.length}`);
  }
}
