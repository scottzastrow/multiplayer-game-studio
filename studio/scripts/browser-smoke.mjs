import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const serviceFile = resolve(root, "studio", "server.mjs");
const viteFile = resolve(root, "games", "sample", "node_modules", "vite", "bin", "vite.js");
const chromePath = process.env.CHROME_PATH ??
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const apiPort = 4181;
const webPort = 4174;
const debugPort = 9224;
const database = `studio/data/browser-smoke-${process.pid}.sqlite`;
const legacyDatabase = `studio/data/browser-smoke-legacy-${process.pid}.sqlite`;
const project = await import(pathToFileURL(resolve(root, "games", "astraeum-tower", "src", "project.js")).href);
const profile = await mkdtemp(join(tmpdir(), "web-studio-smoke-"));
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const webOrigin = `http://127.0.0.1:${webPort}`;
let service;
let web;
let chrome;
let socket;
let targetId;
let sessionId;

function startService(databasePath = database) {
  const child = spawn(process.execPath, ["--no-warnings", serviceFile], {
    cwd: root,
    env: { ...process.env, STUDIO_API_PORT: String(apiPort), STUDIO_DATABASE_PATH: databasePath },
    stdio: "ignore"
  });
  child.on("error", error => console.error("Service process error:", error));
  return child;
}

function startWeb() {
  const child = spawn(process.execPath, [
    viteFile, "--config", "studio/vite.config.js",
    "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"
  ], {
    cwd: root,
    env: { ...process.env, STUDIO_API_PORT: String(apiPort), STUDIO_WEB_PORT: String(webPort) },
    stdio: "ignore"
  });
  child.on("error", error => console.error("Vite process error:", error));
  return child;
}

function startChrome() {
  return spawn(chromePath, [
    "--headless=new", "--no-sandbox", "--disable-gpu",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    "about:blank"
  ], { stdio: "ignore" });
}

async function waitForHttp(url, child, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${label} exited before becoming ready.`);
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {}
    await delay(100);
  }
  throw new Error(`${label} did not become ready at ${url}.`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolveExit => {
    const timer = setTimeout(resolveExit, 5000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveExit();
    });
    child.kill("SIGTERM");
  });
}

const pending = new Map();
const browserExceptions = [];
let nextId = 0;

function cdp(method, params = {}, targetSessionId) {
  return new Promise((resolvePromise, rejectPromise) => {
    const id = ++nextId;
    const timeout = setTimeout(() => {
      pending.delete(id);
      rejectPromise(new Error(`Chrome DevTools timeout: ${method}`));
    }, 10000);
    pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timeout });
    socket.send(JSON.stringify({
      id, method, params,
      ...(targetSessionId ? { sessionId: targetSessionId } : {})
    }));
  });
}

async function evaluate(expression) {
  const response = await cdp("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  }, sessionId);
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description ?? "Browser evaluation failed.");
  }
  return response.result.value;
}

async function waitFor(expression, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(expression)) return;
    } catch (error) {
      if (!/navigated|context|destroyed/i.test(error.message)) throw error;
    }
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${expression}`);
}

async function clickSelector(selector) {
  const point = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error(${JSON.stringify(`Missing UI control: ${selector}`)});
    element.scrollIntoView({ block: "center" });
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  await cdp("Input.dispatchMouseEvent", {
    type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1
  }, sessionId);
  await cdp("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1
  }, sessionId);
}

async function clickWorld(x, y) {
  const point = await evaluate(`(() => {
    const canvas = document.querySelector("#map-canvas");
    const rect = canvas.getBoundingClientRect();
    const zoom = Number(canvas.dataset.zoom);
    return {
      x: rect.left + (${x} - Number(canvas.dataset.cameraX)) * zoom,
      y: rect.top + (${y} - Number(canvas.dataset.cameraY)) * zoom
    };
  })()`);
  await cdp("Input.dispatchMouseEvent", {
    type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1
  }, sessionId);
  await cdp("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1
  }, sessionId);
}

async function key(type, code, keyValue, modifiers = 0) {
  await cdp("Input.dispatchKeyEvent", {
    type,
    code,
    key: keyValue,
    modifiers,
    windowsVirtualKeyCode: keyValue.length === 1 ? keyValue.toUpperCase().charCodeAt(0) : undefined
  }, sessionId);
}

const canvasData = name => evaluate(`document.querySelector("#map-canvas").dataset.${name}`);
const studioDocument = () => evaluate(`window.__studioTest.document()`);
const objectById = async id => (await studioDocument()).objects.find(object => object.id === id);
const studioView = () => evaluate(`window.__studioTest.view()`);
const saveState = () => evaluate(`document.querySelector("#save-state").textContent`);

async function worldPoint(x, y) {
  return evaluate(`window.__studioTest.worldToClient(${x}, ${y})`);
}

async function mouse(type, point, buttons = type === "mouseReleased" ? 0 : 1) {
  await cdp("Input.dispatchMouseEvent", {
    type, x: point.x, y: point.y, button: "left", buttons, clickCount: 1
  }, sessionId);
}

async function dragPath(from, to, check) {
  await mouse("mousePressed", from);
  for (let step = 1; step <= 6; step += 1) {
    await mouse("mouseMoved", {
      x: from.x + (to.x - from.x) * step / 6,
      y: from.y + (to.y - from.y) * step / 6
    });
  }
  if (check) await check();
  await mouse("mouseReleased", to);
}

async function dragFromPalette(assetId, worldX, worldY) {
  const card = await evaluate(`(() => {
    const card = document.querySelector('.asset-card[data-asset-id="${assetId}"]');
    card.scrollIntoView({ block: "nearest", inline: "center" });
    const rect = card.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  let preview = "";
  await dragPath(card, await worldPoint(worldX, worldY), async () => {
    preview = await canvasData("preview");
  });
  return preview;
}

async function dragWorld(from, to, check) {
  await dragPath(await worldPoint(from.x, from.y), await worldPoint(to.x, to.y), check);
}

async function samplePixel(x, y) {
  return evaluate(`(() => {
    const canvas = document.querySelector("#map-canvas");
    const point = window.__studioTest.worldToClient(${x}, ${y});
    const rect = canvas.getBoundingClientRect();
    const scale = canvas.width / rect.width;
    const data = canvas.getContext("2d").getImageData(
      Math.floor((point.x - rect.left) * scale), Math.floor((point.y - rect.top) * scale), 1, 1).data;
    return [...data].join(",");
  })()`);
}

async function clickButton(selector) {
  await clickSelector(selector);
  await delay(30);
}

async function reloadPage() {
  await evaluate(`window.__beforeReload = true`).catch(() => {});
  await cdp("Page.reload", { ignoreCache: true }, sessionId);
  await waitFor(`window.__beforeReload === undefined && document.readyState === "complete"`);
}

async function openStudio(expectedStatus) {
  const ready = `document.querySelector('[data-testid="studio-status"]')?.textContent.includes(${JSON.stringify(expectedStatus)}) &&
    document.querySelector("#map-canvas")?.dataset.layerCounts !== undefined && window.__studioTest !== undefined`;
  await reloadPage();
  await waitFor(ready);
  await evaluate(`localStorage.removeItem("web-studio.astraeum.layers.v1"); localStorage.removeItem("web-studio.palette-view.v1")`);
  await reloadPage();
  await waitFor(ready);
}

function seedLegacyDatabase() {
  const terrain = project.FLOOR1_GRID.map(row => row.replaceAll("#", "."));
  const walls = [];
  project.FLOOR1_GRID.forEach((row, y) => [...row].forEach((cell, x) => {
    if (cell === "#") walls.push({ id: `wall-${x}-${y}`, x: x * 32, y: y * 32, width: 32, height: 32 });
  }));
  walls.push({ id: "wall-editor-900", x: 245, y: 101, width: 32, height: 32 });
  const legacy = {
    formatVersion: 1, id: "astraeum-tower-floor-1", name: "Damp Corridors", cellSize: 32, terrain, walls
  };
  const json = JSON.stringify(legacy);
  const db = new DatabaseSync(resolve(root, legacyDatabase));
  db.exec(`CREATE TABLE maps (id TEXT PRIMARY KEY, document_json TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  db.prepare("INSERT INTO maps VALUES (?, ?, ?)").run("astraeum-tower-floor-1", json, "2025-01-01T00:00:00.000Z");
  db.close();
  return { json, walls: walls.length };
}

try {
  assert.ok(existsSync(chromePath), `Chrome was not found at ${chromePath}.`);
  const legacy = seedLegacyDatabase();
  service = startService(legacyDatabase);
  await waitForHttp(`${apiOrigin}/api/maps/astraeum-tower-floor-1`, service, "SQLite service (legacy)");
  web = startWeb();
  await waitForHttp(webOrigin, web, "Studio Vite server");
  chrome = startChrome();
  const versionResponse = await waitForHttp(`http://127.0.0.1:${debugPort}/json/version`, chrome,
    "headless Chrome");
  const version = await versionResponse.json();
  socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", rejectOpen, { once: true });
  });
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === "Runtime.exceptionThrown") {
      browserExceptions.push(message.params.exceptionDetails.exception?.description ?? "Browser exception");
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timeout);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  ({ targetId } = await cdp("Target.createTarget", { url: webOrigin }));
  ({ sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true }));
  await cdp("Page.enable", {}, sessionId);
  await cdp("Runtime.enable", {}, sessionId);
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false
  }, sessionId);

  // ---- Phase 1: a format 1 database is migrated explicitly, with an untouched backup.
  await openStudio("upgraded to the object format");
  const migrated = await evaluate(`({
    notice: document.querySelector("#migration-notice").textContent,
    counts: JSON.parse(document.querySelector("#map-canvas").dataset.layerCounts)
  })`);
  assert.match(migrated.notice, /format 1 to 2/);
  assert.match(migrated.notice, /wall-editor-900/);
  assert.match(migrated.notice, /backup #\d+/);
  assert.equal(migrated.counts.walls, legacy.walls - 1, "aligned format 1 walls stay walls.");
  assert.equal(migrated.counts.collision, 1, "the off-grid wall is kept as a collision box, not a wall.");
  await clickWorld(261, 117);
  await waitFor(`document.querySelector("#map-canvas").dataset.selectedId === "wall-editor-900"`);
  assert.match(await evaluate(`document.querySelector("#object-type").textContent`), /Collision/i);
  assert.match(await evaluate(`document.querySelector("#object-migration").textContent`), /off the 32 px grid/);

  // The migrated box is labelled as an unresolved collision with explicit repair actions, all undoable.
  const unresolvedUi = await evaluate(`({
    summary: document.querySelector("#unresolved-summary").hidden ? "" : document.querySelector("#unresolved-count").textContent,
    type: document.querySelector("#object-type").textContent,
    panel: !document.querySelector("#unresolved-panel").hidden,
    origin: document.querySelector("#unresolved-origin").textContent,
    asset: document.querySelector("#resolve-asset").value,
    outcome: document.querySelector("#resolve-outcome").dataset.outcome,
    tree: document.querySelector('.tree-item[data-object-id="wall-editor-900"]')?.textContent ?? ""
  })`);
  assert.match(unresolvedUi.summary, /1 unresolved collision\b/);
  assert.match(unresolvedUi.type, /^Unresolved collision/);
  assert.equal(unresolvedUi.panel, true);
  assert.match(unresolvedUi.origin, /format 1/i);
  assert.equal(unresolvedUi.asset, "wall-damp-stone");
  assert.equal(unresolvedUi.outcome, "identical", "wall artwork keeps the collision unchanged.");
  assert.match(unresolvedUi.tree, /Unresolved collision/);
  const migratedDocument = JSON.stringify(await studioDocument());
  const unresolvedBox = await objectById("wall-editor-900");
  await evaluate(`document.querySelector("#next-unresolved").click()`);
  await waitFor(`document.querySelector("#map-canvas").dataset.selectedId === "wall-editor-900"`);
  await clickButton("#resolve-assign");
  const assigned = await objectById("wall-editor-900");
  assert.equal(assigned.type, "wall");
  assert.equal(assigned.assetId, "wall-damp-stone");
  assert.deepEqual(assigned.transform, unresolvedBox.transform);
  assert.deepEqual(assigned.collision, unresolvedBox.collision, "assigning wall artwork keeps the collision.");
  assert.equal(assigned.migration.from, "format-1-wall-resolved");
  assert.equal(await evaluate(`document.querySelector("#unresolved-summary").hidden`), true);
  await clickButton("#undo");
  assert.equal(JSON.stringify(await studioDocument()), migratedDocument, "undo restores the unresolved box.");
  await clickButton("#redo");
  assert.equal((await objectById("wall-editor-900")).type, "wall");
  await clickButton("#undo");
  await clickButton("#resolve-keep");
  const kept = await objectById("wall-editor-900");
  assert.equal(kept.type, "collision");
  assert.deepEqual(kept.collision, unresolvedBox.collision, "keeping the box keeps its collision.");
  assert.equal(kept.migration.from, "format-1-wall-kept");
  await clickButton("#undo");
  await clickButton("#resolve-delete");
  assert.equal(await objectById("wall-editor-900"), undefined, "delete removes the box only when asked.");
  await clickButton("#undo");
  assert.equal(JSON.stringify(await studioDocument()), migratedDocument, "undo restores the original box.");
  await stopChild(service);
  {
    const db = new DatabaseSync(resolve(root, legacyDatabase), { readOnly: true });
    const backup = db.prepare("SELECT document_json, format_version FROM map_backups").get();
    const stored = JSON.parse(db.prepare("SELECT document_json FROM maps").get().document_json);
    db.close();
    assert.equal(backup.document_json, legacy.json, "the original format 1 row is kept byte-for-byte.");
    assert.equal(backup.format_version, 1);
    assert.equal(stored.formatVersion, 2);
  }

  // ---- Phase 2: the authoring workflow on a fresh database.
  service = startService();
  await waitForHttp(`${apiOrigin}/api/maps/astraeum-tower-floor-1`, service, "SQLite service");
  await openStudio("Opened the original");
  const initial = await evaluate(`(() => ({
    counts: JSON.parse(document.querySelector("#map-canvas").dataset.layerCounts),
    grid: document.querySelector("#show-grid").checked,
    snap: document.querySelector("#snap-grid").checked,
    terrainLocked: document.querySelector('.layer-row[data-layer="terrain"]').classList.contains("locked"),
    badges: Object.fromEntries([...document.querySelectorAll(".asset-card")].map(card =>
      [card.dataset.assetId, card.dataset.playStatus + ":" + card.querySelector('[data-testid="play-badge"]').textContent]))
  }))()`);
  assert.deepEqual(initial.counts, { terrain: 792, walls: 383, props: 7, items: 7, spawns: 8, collision: 0 });
  assert.equal(initial.grid, true);
  assert.equal(initial.snap, true);
  assert.equal(initial.terrainLocked, true, "the floor starts visible but locked.");
  for (const id of ["item-chest", "item-herb", "item-mushroom", "item-amethyst", "item-sapphire", "spawn-slime"]) {
    assert.equal(initial.badges[id], "editor-only:Editor only", `${id} is marked as having no gameplay.`);
  }
  assert.equal(initial.badges["wall-damp-stone"], "implemented:In Play");
  assert.equal(initial.badges["prop-barrel"], "implemented:In Play");
  assert.equal(initial.badges["prop-stairs-rune"], "partial:Partial in Play");
  assert.equal(await saveState(), "✓ Saved");
  const initialZoom = Number(await canvasData("zoom"));
  await clickButton("#zoom-in");
  await waitFor(`Number(document.querySelector("#map-canvas").dataset.zoom) > ${initialZoom}`);
  await clickButton("#zoom-out");
  await waitFor(`Math.abs(Number(document.querySelector("#map-canvas").dataset.zoom) - ${initialZoom}) < 0.0001`);

  const floorPixel = await samplePixel(170, 140);
  const terrainBefore = JSON.stringify((await studioDocument()).objects.filter(object => object.type === "terrain-tile"));

  // Drag a wall from the palette, with a snapped preview.
  const wallPreview = await dragFromPalette("wall-damp-stone", 176, 144);
  assert.equal(wallPreview, "wall-damp-stone@160,128", "the drag shows a snapped placement preview.");
  await waitFor(`document.querySelector("#map-canvas").dataset.selectedId.startsWith("wall-damp-stone-")`);
  const wallId = await canvasData("selectedId");
  const placedWall = await objectById(wallId);
  assert.deepEqual(placedWall.transform, { x: 160, y: 128 });
  assert.equal(placedWall.layer, "walls");
  assert.equal(placedWall.type, "wall");
  assert.equal(await canvasData("preview"), "", "the preview disappears after dropping.");
  assert.notEqual(await samplePixel(170, 140), floorPixel, "the placed wall shows wall artwork.");

  // Drag a prop from the palette.
  const barrelPreview = await dragFromPalette("prop-barrel", 208, 150);
  assert.equal(barrelPreview, "prop-barrel@208,152");
  await waitFor(`document.querySelector("#map-canvas").dataset.selectedId.startsWith("prop-barrel-")`);
  const barrelId = await canvasData("selectedId");
  const barrel = await objectById(barrelId);
  assert.equal(barrel.layer, "props");
  const barrelBounds = project.objectBounds(barrel);
  const barrelCenter = {
    x: barrelBounds.x + Math.floor(barrelBounds.width / 2),
    y: barrelBounds.y + Math.floor(barrelBounds.height / 2)
  };
  const barrelPixel = await samplePixel(barrelCenter.x, barrelCenter.y);

  // Move the wall off-grid (snap off): only the wall moves; the floor stays put and draws below.
  await clickButton("#snap-grid");
  assert.equal(await evaluate(`document.querySelector("#snap-grid").checked`), false);
  await dragWorld({ x: 176, y: 144 }, { x: 196, y: 144 });
  await waitFor(`window.__studioTest.document().objects.find(o => o.id === ${JSON.stringify(wallId)}).transform.x === 180`);
  const movedWall = await objectById(wallId);
  assert.deepEqual(movedWall.transform, { x: 180, y: 128 }, "dragging moves only the selected wall, unsnapped.");
  assert.equal(movedWall.layer, placedWall.layer, "moving does not change the layer.");
  assert.equal(movedWall.order, placedWall.order, "moving does not change the order.");
  assert.equal(await canvasData("selectedId"), wallId);
  assert.equal(JSON.stringify((await studioDocument()).objects.filter(object => object.type === "terrain-tile")),
    terrainBefore, "no terrain tile moved.");
  assert.equal(await samplePixel(170, 140), floorPixel, "the old wall cell shows the untouched floor.");
  assert.ok(barrelCenter.x >= 180 && barrelCenter.x < 212 && barrelCenter.y >= 128 && barrelCenter.y < 160,
    "the moved wall overlaps the barrel.");
  assert.equal(await samplePixel(barrelCenter.x, barrelCenter.y), barrelPixel,
    "the barrel still draws above the moved wall.");
  const movedWallPixel = await samplePixel(184, 132);
  assert.notEqual(movedWallPixel, await samplePixel(184 - 64, 132), "the moved wall draws wall artwork, not floor.");

  // Undo/redo of the move.
  await clickButton("#undo");
  assert.deepEqual((await objectById(wallId)).transform, { x: 160, y: 128 }, "undo restores the wall position.");
  await clickButton("#redo");
  assert.deepEqual((await objectById(wallId)).transform, { x: 180, y: 128 }, "redo repeats the move.");
  await clickButton("#undo");

  // Snapping on: a drag of 40 px lands on the grid.
  await clickButton("#snap-grid");
  await dragWorld({ x: 176, y: 144 }, { x: 216, y: 144 });
  await waitFor(`window.__studioTest.document().objects.find(o => o.id === ${JSON.stringify(wallId)}).transform.x !== 160`);
  assert.deepEqual((await objectById(wallId)).transform, { x: 192, y: 128 }, "snapping lands moves on 32 px.");
  await clickButton("#undo");
  assert.deepEqual((await objectById(wallId)).transform, { x: 160, y: 128 });

  // Five-pixel nudge, independent of snapping, with undo/redo.
  await evaluate(`document.querySelector("#map-canvas").focus()`);
  assert.equal(await canvasData("selectedId"), wallId);
  await key("keyDown", "ArrowRight", "ArrowRight");
  await key("keyUp", "ArrowRight", "ArrowRight");
  assert.deepEqual((await objectById(wallId)).transform, { x: 165, y: 128 }, "arrow keys nudge 5 px.");
  await clickButton("#undo");
  assert.deepEqual((await objectById(wallId)).transform, { x: 160, y: 128 });
  await clickButton("#redo");
  const nudged = await objectById(wallId);
  assert.deepEqual(nudged.transform, { x: 165, y: 128 });
  await evaluate(`document.querySelector("#object-x").focus()`);
  await key("keyDown", "ArrowRight", "ArrowRight");
  await key("keyUp", "ArrowRight", "ArrowRight");
  assert.deepEqual((await objectById(wallId)).transform, nudged.transform,
    "arrow keys in Inspector fields do not nudge.");

  // Locked floor is visible but cannot be selected; unlocking allows it.
  await clickWorld(400, 144);
  await delay(50);
  assert.equal(await canvasData("selectedId"), "", "a locked floor tile is not selectable.");
  await clickSelector('.layer-row[data-layer="terrain"] [data-action="lock"]');
  await clickWorld(400, 144);
  await waitFor(`document.querySelector("#map-canvas").dataset.selectedId === "terrain-12-4"`);
  await clickSelector('.layer-row[data-layer="terrain"] [data-action="lock"]');
  assert.equal(await canvasData("selectedId"), "", "locking the floor clears a floor selection.");

  // Save, restart the service, reopen.
  await evaluate(`document.querySelector("#map-canvas").focus()`);
  await key("keyDown", "KeyS", "s", 2);
  await key("keyUp", "KeyS", "s", 2);
  await waitFor(`document.querySelector("#save-state").textContent === "✓ Saved"`);
  const savedDocument = JSON.stringify(await studioDocument());
  await stopChild(service);
  service = startService();
  await waitForHttp(`${apiOrigin}/api/maps/astraeum-tower-floor-1`, service, "restarted SQLite service");
  await reloadPage();
  await waitFor(`document.querySelector('[data-testid="studio-status"]')?.textContent.includes("Reopened the locally saved") &&
    window.__studioTest !== undefined`);
  assert.equal(JSON.stringify(await studioDocument()), savedDocument, "reopening restores the saved design exactly.");
  assert.equal(await samplePixel(barrelCenter.x, barrelCenter.y), barrelPixel, "draw order survives reopening.");

  // Play through the real Play button.
  await clickWorld(barrelCenter.x, barrelCenter.y);
  await evaluate(`window.__studioTest.setView({ zoom: 1.5, cameraX: 40, cameraY: 20 })`);
  const editorView = await studioView();
  await evaluate(`(() => {
    window.__playStates = [];
    new MutationObserver(() => window.__playStates.push(document.querySelector("#studio").dataset.playState +
      (document.querySelector("#play-loading").hidden ? "" : "+loading")))
      .observe(document.querySelector("#studio"), { attributes: true, attributeFilter: ["data-play-state"] });
  })()`);
  await clickButton("#play");
  await waitFor(`document.querySelector("#studio").dataset.playState === "playing"`);
  const playStates = await evaluate(`window.__playStates`);
  assert.ok(playStates.includes("starting+loading"), `Play shows a loading state (${playStates}).`);
  const runtime = await evaluate(`(() => {
    const world = document.querySelector('[data-testid="astraeum-world"]');
    const rect = world.getBoundingClientRect();
    return {
      width: rect.width, height: rect.height, focused: document.activeElement === world,
      editorHidden: document.querySelector("#editor-view").hidden,
      collisions: Number(world.dataset.collisionRectangles),
      x: Number(world.dataset.x), y: Number(world.dataset.y)
    };
  })()`);
  assert.ok(runtime.width > 400 && runtime.height > 300, `the Play canvas is visible (${runtime.width}x${runtime.height}).`);
  assert.equal(runtime.focused, true, "the Play canvas has keyboard focus.");
  assert.equal(runtime.editorHidden, true, "Play replaces the editor view.");
  assert.equal(runtime.collisions, initial.counts.walls + 1, "runtime collision is derived from the saved walls.");
  assert.equal(runtime.x, 144);
  await key("keyDown", "KeyD", "d");
  await delay(900);
  const beforeRelease = Number(await evaluate(`document.querySelector('[data-testid="astraeum-world"]').dataset.x`));
  await key("keyUp", "KeyD", "d");
  await delay(250);
  const afterRelease = Number(await evaluate(`document.querySelector('[data-testid="astraeum-world"]').dataset.x`));
  assert.ok(beforeRelease > runtime.x && beforeRelease < nudged.transform.x,
    `Aries moves and stops at the edited wall (start=${runtime.x}, wall=${nudged.transform.x}, x=${beforeRelease}).`);
  assert.equal(afterRelease, beforeRelease, "the wall stays impassable.");
  await clickButton("#stop");
  await waitFor(`document.querySelector("#studio").dataset.playState === "idle" &&
    document.querySelector("#editor-view").hidden === false && document.querySelector("#play-host").hidden === true`);
  assert.deepEqual(await studioView(), editorView, "Stop restores the editor camera and zoom.");
  assert.equal(JSON.stringify(await studioDocument()), savedDocument, "Play does not alter the authored design.");
  assert.equal(await saveState(), "✓ Saved");
  assert.equal(await canvasData("selectedId"), barrelId, "the selection survives Play.");

  // An unplayable map gives an actionable error instead of failing silently.
  await evaluate(`window.__studioTest.setView({ zoom: 1, cameraX: 0, cameraY: 0 })`);
  assert.equal(await evaluate(`document.querySelector("#snap-grid").checked`), true);
  await dragFromPalette("wall-damp-stone", 140, 140);
  await waitFor(`window.__studioTest.document().objects.some(o => o.type === "wall" && o.transform.x === 128 && o.transform.y === 128)`);
  await clickButton("#play");
  await waitFor(`document.querySelector("#play-error").hidden === false`);
  const playError = await evaluate(`document.querySelector("#play-error-message").textContent`);
  assert.match(playError, /Aries/i, `the Play error names the blocked spawn (${playError}).`);
  assert.equal(await evaluate(`document.querySelector("#editor-view").hidden`), false, "the editor stays usable.");
  await clickButton("#play-error-close");
  await clickButton("#undo");
  assert.equal(JSON.stringify(await studioDocument()), savedDocument);

  // Palette display modes keep names readable and drag-to-place working; the choice is local only.
  assert.equal(await evaluate(`document.querySelector("#asset-list").dataset.view`), "medium");
  const paletteViews = [];
  for (const [view, assetId] of [["large", "prop-crate"], ["small", "prop-barrel"], ["list", "item-chest"], ["medium", "wall-damp-stone"]]) {
    await clickSelector(`#palette-view [data-view="${view}"]`);
    await waitFor(`document.querySelector("#asset-list").dataset.view === "${view}"`);
    const layout = await evaluate(`(() => {
      const list = document.querySelector("#asset-list");
      const bottom = list.getBoundingClientRect().top + list.clientHeight + 0.5;
      return {
        stored: localStorage.getItem("web-studio.palette-view.v1"),
        clipped: [...list.querySelectorAll(".asset-card")].filter(card => card.getBoundingClientRect().bottom > bottom ||
          [...card.querySelectorAll("strong")].some(name => name.scrollWidth > name.clientWidth + 1)).map(card => card.dataset.assetId),
        thumbnails: list.querySelectorAll(".asset-card canvas").length
      };
    })()`);
    assert.equal(layout.stored, view);
    assert.deepEqual(layout.clipped, [], `${view} view keeps every card and name visible.`);
    assert.equal(layout.thumbnails > 0, view !== "list", `${view} view thumbnail mode.`);
    assert.equal(JSON.stringify(await studioDocument()), savedDocument, "changing the view does not touch the design.");
    await evaluate(`window.__studioTest.setView({ zoom: 1, cameraX: 0, cameraY: 0 })`);
    const preview = await dragFromPalette(assetId, 400, 216);
    assert.match(preview, new RegExp(`^${assetId}@`), `${view} view shows a placement preview.`);
    await waitFor(`document.querySelector("#map-canvas").dataset.selectedId.startsWith("${assetId}-")`);
    await clickButton("#undo");
    assert.equal(JSON.stringify(await studioDocument()), savedDocument);
    paletteViews.push(view);
  }
  await clickSelector(`#palette-view [data-view="small"]`);
  await reloadPage();
  await waitFor(`document.querySelector("#asset-list")?.dataset.view === "small" && window.__studioTest !== undefined &&
    document.querySelector("#map-canvas")?.dataset.layerCounts !== undefined`);
  assert.equal(JSON.stringify(await studioDocument()), savedDocument, "the view preference is remembered without touching game data.");

  assert.deepEqual(browserExceptions, [], "the Studio browser workflow reports no uncaught exceptions.");
  console.log(`Studio workflow passed: migrated format 1 (${legacy.walls} walls, 1 collision box, backup kept); ` +
    `unresolved collision labelled, assigned wall artwork / kept / deleted with undo; ` +
    `dragged a wall and a barrel from the palette; moved the wall off-grid without moving the floor; ` +
    `barrel stayed above the wall; snap, 5 px nudge, undo/redo, floor lock; saved and reopened; ` +
    `Play button ran the edited map and Aries stopped at x=${beforeRelease} against the wall at ` +
    `x=${nudged.transform.x}; Stop restored the view; unplayable map showed an actionable error; ` +
    `palette ${paletteViews.join("/")} views dragged-to-place and the view was remembered locally.`);
} finally {
  if (targetId && socket?.readyState === WebSocket.OPEN) {
    await cdp("Target.closeTarget", { targetId }).catch(() => {});
  }
  socket?.close();
  await Promise.all([stopChild(chrome), stopChild(web), stopChild(service)]);
  for (const name of [`browser-smoke-${process.pid}`, `browser-smoke-legacy-${process.pid}`]) {
    for (const suffix of ["", "-wal", "-shm"]) {
      await rm(resolve(root, "studio", "data", `${name}.sqlite${suffix}`), { force: true });
    }
  }
  await rm(profile, { recursive: true, force: true });
}
