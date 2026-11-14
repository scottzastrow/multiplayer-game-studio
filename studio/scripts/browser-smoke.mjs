import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { deflateSync } from "node:zlib";
import { ASTRAEUM_MODEL } from "../project-identity.js";
import { parseAssetUpload } from "../asset-import.js";
import { importedAssetDefinition } from "../project-assets.js";

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
const gamesPath = resolve(root, "studio", "data", `browser-games-${process.pid}`);
const project = await import(pathToFileURL(resolve(root, "games", "astraeum-tower", "src", "project.js")).href);
const genericProject = await import(pathToFileURL(resolve(root, "games", "generic-grid-v1", "src", "project.js")).href);
const profile = await mkdtemp(join(tmpdir(), "web-studio-smoke-"));
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const webOrigin = `http://127.0.0.1:${webPort}`;
const mapUrl = `${apiOrigin}/api/projects/astraeum-tower/maps/astraeum-tower-floor-1`;
const gopherZipPath = process.env.STUDIO_GOPHER_ZIP ? resolve(root, process.env.STUDIO_GOPHER_ZIP) : null;
if (gopherZipPath && !existsSync(gopherZipPath)) throw new Error(`Mutant-gopher ZIP not found: ${gopherZipPath}`);
let service;
let web;
let chrome;
let socket;
let targetId;
let sessionId;

function startService(databasePath = database) {
  const child = spawn(process.execPath, ["--no-warnings", serviceFile], {
    cwd: root,
    env: { ...process.env, STUDIO_API_PORT: String(apiPort), STUDIO_DATABASE_PATH: databasePath,
      STUDIO_GAMES_PATH: `studio/data/browser-games-${process.pid}` },
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

function pngCrc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const contents = Buffer.concat([Buffer.from(type), data]);
  const chunk = Buffer.alloc(contents.length + 8);
  chunk.writeUInt32BE(data.length, 0);
  contents.copy(chunk, 4);
  chunk.writeUInt32BE(pngCrc32(contents), contents.length + 4);
  return chunk;
}

function makeRgbaPng(width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const stride = 1 + width * 4;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    pixels[row] = 0;
    for (let x = 0; x < width; x += 1) {
      pixels[row + 1 + x * 4] = 0x8c;
      pixels[row + 2 + x * 4] = 0x45;
      pixels[row + 3 + x * 4] = 0x28;
      pixels[row + 4 + x * 4] = 0xff;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
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

async function assertStableHierarchy() {
  assert.equal(await evaluate(`(async () => {
    const tree = document.querySelector("#object-tree");
    const groups = [...tree.children];
    await new Promise(resolve => setTimeout(resolve, 100));
    return groups.length === tree.children.length &&
      groups.every((group, index) => group === tree.children[index]);
  })()`), true, "idle hierarchy must not rebuild from queued details toggle events");
}

async function fillInput(selector, value) {
  await clickSelector(selector);
  await key("keyDown", "KeyA", "a", 2);
  await key("keyUp", "KeyA", "a", 2);
  await cdp("Input.insertText", { text: String(value) }, sessionId);
}

async function setFileInput(selector, filename) {
  const { root: documentRoot } = await cdp("DOM.getDocument", { depth: -1 }, sessionId);
  const { nodeId } = await cdp("DOM.querySelector", { nodeId: documentRoot.nodeId, selector }, sessionId);
  assert.ok(nodeId, `File input ${selector} exists.`);
  await cdp("DOM.setFileInputFiles", { files: [filename], nodeId }, sessionId);
}

async function reloadPage() {
  await evaluate(`window.__beforeReload = true`).catch(() => {});
  await cdp("Page.reload", { ignoreCache: true }, sessionId);
  await waitFor(`window.__beforeReload === undefined && document.readyState === "complete"`);
}

async function openStudio(expectedStatus) {
  const ready = `document.querySelector('[data-testid="studio-status"]')?.textContent.includes(${JSON.stringify(expectedStatus)}) &&
    document.querySelector("#map-canvas")?.dataset.layerCounts !== undefined && window.__studioTest !== undefined`;
  const waitForReady = async () => {
    try {
      await waitFor(ready);
    } catch (error) {
      const state = await evaluate(`({
        status: document.querySelector('[data-testid="studio-status"]')?.textContent,
        saveState: document.querySelector("#save-state")?.textContent,
        exceptions: window.__studioTest ? [] : []
      })`).catch(() => null);
      throw new Error(`${error.message}; Studio state: ${JSON.stringify(state)}; exceptions: ${JSON.stringify(browserExceptions)}`);
    }
  };
  await reloadPage();
  await waitForReady();
  await evaluate(`localStorage.removeItem("web-studio.astraeum.layers.v1"); localStorage.removeItem("web-studio.palette-view.v1")`);
  await reloadPage();
  await waitForReady();
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
  await waitForHttp(mapUrl, service, "SQLite service (legacy)");
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
  await waitForHttp(mapUrl, service, "SQLite service");
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
  await waitForHttp(mapUrl, service, "restarted SQLite service");
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

  // ---- Phase 3: explicit Astraeum-model projects, switching and isolated saves.
  const second = JSON.parse(savedDocument);
  second.id = "second-map";
  second.objects = second.objects.filter(object => object.id !== wallId);
  const secondUrl = `${apiOrigin}/api/projects/second-project/maps/second-map`;
  const putSecond = await fetch(secondUrl, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: "second-project", model: ASTRAEUM_MODEL, document: second })
  });
  assert.equal(putSecond.status, 200);
  {
    const db = new DatabaseSync(resolve(root, database));
    db.prepare("INSERT INTO maps (project_id, map_id, document_json, updated_at, model) VALUES (?, ?, ?, ?, ?)")
      .run("unsupported-game", "foreign-map", JSON.stringify(second), "2025-01-01", "another-game-v1");
    const untyped = structuredClone(second);
    untyped.id = "untyped-map";
    db.prepare("INSERT INTO maps (project_id, map_id, document_json, updated_at, model) VALUES (?, ?, ?, ?, ?)")
      .run("untyped-project", "untyped-map", JSON.stringify(untyped), "2025-01-01", null);
    db.close();
  }
  async function selectSaved(projectId, mapId) {
    await clickButton("#open-game");
    const selector = `.open-entry[data-project-id="${projectId}"][data-map-id="${mapId}"] input`;
    await waitFor(`document.querySelector(${JSON.stringify(selector)}) !== null`);
    await clickSelector(selector);
    await clickButton("#open-selected");
  }
  await clickButton("#open-game");
  await waitFor(`document.querySelector('.open-entry[data-project-id="unsupported-game"]') !== null`);
  assert.match(await evaluate(`document.querySelector('.open-entry[data-project-id="unsupported-game"]').textContent`), /Unsupported.*model/i);
  assert.equal(await evaluate(`document.querySelector('.open-entry[data-project-id="unsupported-game"] input').disabled`), true);
  await clickButton("#open-cancel");

  await evaluate(`window.__studioTest.setView({ zoom: 1, cameraX: 0, cameraY: 0 })`);
  await dragFromPalette("item-herb", 400, 216);
  await waitFor(`document.querySelector("#save-state").textContent.includes("Unsaved")`);
  const unsavedFirst = JSON.stringify(await studioDocument());
  await selectSaved("second-project", "second-map");
  assert.equal(await evaluate(`document.querySelector("#open-confirm").hidden`), false);
  await clickButton("#switch-cancel");
  await clickButton("#open-cancel");
  assert.equal(JSON.stringify(await studioDocument()), unsavedFirst, "cancelling a switch retains unsaved edits.");
  await selectSaved("second-project", "second-map");
  await clickButton("#switch-discard");
  await waitFor(`!document.querySelector("#open-dialog").open && window.__studioTest.document().id === "second-map"`);
  assert.match(await evaluate(`document.querySelector("#project-name").textContent`), /second-project.*second-map/);
  assert.equal(JSON.stringify(await studioDocument()), JSON.stringify(second));
  assert.deepEqual((await (await fetch(mapUrl)).json()).document, JSON.parse(savedDocument), "discard never overwrites the original.");
  assert.equal(await evaluate(`document.querySelector("#undo").disabled`), true, "history is reset on switch.");

  await evaluate(`window.__studioTest.setView({ zoom: 1, cameraX: 0, cameraY: 0 })`);
  await dragFromPalette("item-herb", 400, 216);
  await waitFor(`document.querySelector("#save-state").textContent.includes("Unsaved")`);
  const secondEdited = await studioDocument();
  await selectSaved("astraeum-tower", "astraeum-tower-floor-1");
  await clickButton("#switch-save");
  await waitFor(`!document.querySelector("#open-dialog").open && window.__studioTest.document().id === "astraeum-tower-floor-1"`);
  assert.deepEqual((await (await fetch(secondUrl)).json()).document, secondEdited, "save-and-open saves the selected project.");
  assert.equal(JSON.stringify(await studioDocument()), savedDocument, "other project remains isolated.");

  await stopChild(service);
  service = startService();
  await waitForHttp(mapUrl, service, "restarted SQLite service (projects)");
  await reloadPage();
  await waitFor(`window.__studioTest !== undefined && document.querySelector("#map-canvas").dataset.layerCounts !== undefined`);
  await selectSaved("second-project", "second-map");
  await waitFor(`!document.querySelector("#open-dialog").open && window.__studioTest.document().id === "second-map"`);
  assert.deepEqual(await studioDocument(), secondEdited, "selected project reopens after service restart.");
  await clickButton("#play");
  await waitFor(`document.querySelector("#studio").dataset.playState === "playing"`);
  assert.equal(Number(await evaluate(`document.querySelector('[data-testid="astraeum-world"]').dataset.collisionRectangles`)),
    project.createFloorMap(secondEdited).collisions.length, "Play uses the selected document.");
  assert.match(await evaluate(`document.querySelector("#project-name").textContent`), /second-project/);
  assert.equal(await evaluate(`document.querySelector("#open-game").disabled`), true);
  await clickButton("#stop");
  assert.deepEqual(await studioDocument(), secondEdited, "Stop restores the selected design.");
  await evaluate(`window.__studioTest.setView({ zoom: 1, cameraX: 0, cameraY: 0 })`);
  await dragFromPalette("item-herb", 450, 216);
  await waitFor(`document.querySelector("#save-state").textContent.includes("Unsaved")`);
  const pendingEdit = await studioDocument();
  await selectSaved("astraeum-tower", "astraeum-tower-floor-1");
  await stopChild(service);
  await clickButton("#switch-save");
  await waitFor(`document.querySelector("#open-message").classList.contains("error")`);
  assert.deepEqual(await studioDocument(), pendingEdit, "a failed save leaves the unsaved map open.");
  assert.equal(await evaluate(`document.querySelector("#open-dialog").open`), true);
  service = startService();
  await waitForHttp(mapUrl, service, "restarted SQLite service (failed switch)");
  await clickButton("#switch-cancel");
  await clickButton("#open-cancel");
  await clickButton("#undo");
  assert.deepEqual(await studioDocument(), secondEdited);
  await selectSaved("untyped-project", "untyped-map");
  assert.equal(await evaluate(`document.querySelector("#open-model-confirm").hidden`), false);
  await clickButton("#model-cancel");
  await clickButton("#open-cancel");
  assert.deepEqual(await studioDocument(), secondEdited, "cancelling model assignment keeps the selected map.");
  assert.equal((await (await fetch(`${apiOrigin}/api/projects`)).json()).maps
    .find(entry => entry.projectId === "untyped-project").model, null);
  await selectSaved("untyped-project", "untyped-map");
  assert.equal(await evaluate(`document.querySelector("#open-model-confirm").hidden`), false, "model confirmation shown");
  await clickButton("#model-confirm");
  await waitFor(`!document.querySelector("#open-dialog").open && window.__studioTest.document().id === "untyped-map"`);
  assert.equal((await (await fetch(`${apiOrigin}/api/projects`)).json()).maps
    .find(entry => entry.projectId === "untyped-project").model, ASTRAEUM_MODEL);

  // ---- Phase 4: create and edit two genuinely generic games through real controls.
  await selectSaved("astraeum-tower", "astraeum-tower-floor-1");
  await waitFor(`!document.querySelector("#open-dialog").open && window.__studioTest.document().id === "astraeum-tower-floor-1"`);
  const astraeumBefore = await (await fetch(mapUrl)).json();
  const countBefore = (await (await fetch(`${apiOrigin}/api/projects`)).json()).maps.length;
  await clickButton("#new-game");
  await fillInput("#new-name", "Cancelled game");
  await fillInput("#new-author", "Disposable credits");
  await clickButton("#new-cancel");
  assert.deepEqual(await studioDocument(), astraeumBefore.document);
  assert.equal((await (await fetch(`${apiOrigin}/api/projects`)).json()).maps.length, countBefore);

  await clickButton("#new-game");
  await clickButton("#new-create");
  assert.equal(await evaluate(`document.querySelector("#new-name").validity.valueMissing`), true);
  await fillInput("#new-name", "   ");
  await fillInput("#new-author", "Disposable credits");
  await clickButton("#new-create");
  assert.match(await evaluate(`document.querySelector("#new-message").textContent`), /nonblank/);
  await fillInput("#new-name", "Browser Generic One");
  for (const width of [63, 65, 2080]) {
    await fillInput("#new-width", width);
    await clickButton("#new-create");
    assert.equal(await evaluate(`document.querySelector("#new-width").checkValidity()`), false);
    assert.equal((await (await fetch(`${apiOrigin}/api/projects`)).json()).maps.length, countBefore);
  }
  await fillInput("#new-width", 640);
  assert.equal(await evaluate(`document.querySelector("#new-height").value`), "480");
  await clickButton("#new-create");
  await waitFor(`!document.querySelector("#new-dialog").open && document.querySelector("#project-name").textContent === "Browser Generic One"`);
  const firstGeneric = await studioDocument();
  assert.equal(firstGeneric.objects.length, 2, "generic starter contains only safe player spawns");
  assert.deepEqual(firstGeneric.bounds, { width: 640, height: 480 });
  await assertStableHierarchy();
  await clickButton('.tree-group[data-layer="walls"] > summary');
  assert.equal(await evaluate(`document.querySelector('.tree-group[data-layer="walls"]').open`), false);
  await clickButton('.tree-group[data-layer="walls"] > summary');
  assert.equal(await evaluate(`document.querySelector('.tree-group[data-layer="walls"]').open`), true);
  await assertStableHierarchy();
  const listing = (await (await fetch(`${apiOrigin}/api/projects`)).json()).maps;
  const firstEntry = listing.find(entry => entry.mapId === firstGeneric.id);
  assert.equal(firstEntry.model, "generic-grid-v1");
  assert.deepEqual(firstEntry.project, { name: "Browser Generic One", author: "Disposable credits" });
  assert.equal(await evaluate(`[...document.querySelectorAll(".asset-card")].every(card => card.dataset.assetId.startsWith("generic-"))`), true);
  assert.equal(await evaluate(`document.querySelector("#unresolved-summary").hidden`), true);
  assert.equal(await evaluate(`document.querySelector("#migration-notice").hidden`), true);
  const genericFile = JSON.parse(await readFile(resolve(gamesPath, firstEntry.projectId, "project.json"), "utf8"));
  assert.equal(genericFile.model, "generic-grid-v1");
  assert.equal(genericFile.document, undefined);
  await evaluate(`window.__studioTest.setView({ zoom: 1, cameraX: 0, cameraY: 0 })`);
  await dragFromPalette("generic-block", 80, 80);
  await waitFor(`document.querySelector("#save-state").textContent.includes("Unsaved")`);
  const editedFirst = await studioDocument();
  await clickButton("#new-game");
  await fillInput("#new-name", "Cancelled dirty game");
  await fillInput("#new-author", "Disposable credits");
  await clickButton("#new-create");
  assert.equal(await evaluate(`document.querySelector("#new-confirm").hidden`), false);
  await clickButton("#new-cancel");
  assert.deepEqual(await studioDocument(), editedFirst, "cancelling creation preserves unsaved edits");
  await clickSelector("#map-canvas");
  await key("keyDown", "KeyS", "s", 2);
  await key("keyUp", "KeyS", "s", 2);
  await waitFor(`document.querySelector("#save-state").textContent.includes("Saved")`);
  assert.deepEqual((await (await fetch(`${apiOrigin}/api/projects/${firstEntry.projectId}/maps/${firstEntry.mapId}`)).json()).document, editedFirst);

  await clickButton("#new-game");
  await fillInput("#new-name", " browser generic ONE ");
  await fillInput("#new-author", "Other credits");
  await clickButton("#new-create");
  await waitFor(`document.querySelector("#new-message").textContent.includes("already exists")`);
  assert.deepEqual(await studioDocument(), editedFirst);
  assert.equal((await readdir(gamesPath)).length, 1, "duplicate names do not allocate files");
  await clickButton("#new-cancel");

  // Save-and-create protects the current project, without using it as a template.
  await dragFromPalette("generic-marker", 144, 80);
  const savedOnCreate = await studioDocument();
  await clickButton("#new-game");
  await fillInput("#new-name", "Browser Generic Two");
  await fillInput("#new-author", "Second author");
  await fillInput("#new-width", 320);
  await fillInput("#new-height", 256);
  await clickButton("#new-create");
  assert.equal(await evaluate(`document.querySelector("#new-confirm").hidden`), false);
  await clickButton("#new-save");
  await waitFor(`!document.querySelector("#new-dialog").open && document.querySelector("#project-name").textContent === "Browser Generic Two"`);
  assert.deepEqual((await (await fetch(`${apiOrigin}/api/projects/${firstEntry.projectId}/maps/${firstEntry.mapId}`)).json()).document, savedOnCreate);
  const secondGeneric = await studioDocument();
  assert.equal(secondGeneric.objects.length, 2);
  const secondEntry = (await (await fetch(`${apiOrigin}/api/projects`)).json()).maps.find(entry => entry.mapId === secondGeneric.id);
  assert.notEqual(firstEntry.projectId, secondEntry.projectId);
  assert.notEqual(firstEntry.mapId, secondEntry.mapId);
  await evaluate(`window.__studioTest.setView({ zoom: 1, cameraX: 0, cameraY: 0 })`);
  await dragFromPalette("generic-marker", 80, 80);
  const editedSecond = await studioDocument();
  await clickButton("#save");
  await waitFor(`document.querySelector("#save-state").textContent.includes("Saved")`);
  let expectedSecond = editedSecond;
  let importedAssets = [];
  let gopherMeasurements = null;

  if (gopherZipPath) {
    const sourceZip = await readFile(gopherZipPath);
    const sourceImport = parseAssetUpload(gopherZipPath, sourceZip);
    assert.equal(sourceImport.images.length, 8);
    assert.equal(sourceImport.animations, 0);
    await clickButton("#import-assets");
    await setFileInput("#asset-import-file", gopherZipPath);
    await waitFor(`!document.querySelector("#asset-import-preview").hidden ||
      document.querySelector("#asset-import-message").textContent.startsWith("Could not preview")`);
    const previewState = await evaluate(`({ hidden: document.querySelector("#asset-import-preview").hidden,
      count: document.querySelectorAll(".asset-preview-item").length,
      message: document.querySelector("#asset-import-message").textContent })`);
    assert.equal(previewState.hidden === false && previewState.count === 8, true,
      `asset preview failed: ${JSON.stringify(previewState)}`);
    const summary = await evaluate(`document.querySelector("#asset-import-summary").textContent`);
    assert.match(summary, /48×48/);
    assert.match(summary, /8 directions/);
    assert.match(summary, /0 animation frames/);
    const directions = await evaluate(`[...document.querySelectorAll(".asset-preview-item span")].map(item => item.textContent.split(" · ")[0])`);
    assert.deepEqual(directions, sourceImport.images.map(image => image.direction));
    await fillInput("#asset-import-name", "Mutant Gopher");
    await fillInput("#asset-import-author", "Supplied artist");
    await fillInput("#asset-import-source", "PixelLab export");
    assert.equal(await evaluate(`document.querySelector("#asset-import-category").value`), "character");
    await clickButton("#asset-import-submit");
    await waitFor(`document.querySelectorAll('.asset-card[data-asset-id^="asset-"]').length === 8 &&
      document.querySelector("#asset-import-dialog").open === false`);
    importedAssets = (await (await fetch(`${apiOrigin}/api/projects/${secondEntry.projectId}/assets`)).json()).assets;
    assert.equal(importedAssets.length, 8);
    assert.deepEqual(importedAssets.map(asset => asset.direction).sort(),
      ["east", "north", "north-east", "north-west", "south", "south-east", "south-west", "west"]);
    assert.ok(importedAssets.every(asset => asset.width === 48 && asset.height === 48 &&
      asset.name.startsWith("Mutant Gopher · ") && asset.category === "character" &&
      asset.author === "Supplied artist" && asset.source === "PixelLab export"));
    assert.deepEqual((await (await fetch(`${apiOrigin}/api/projects/${firstEntry.projectId}/assets`)).json()).assets, [],
      "the other project's catalog remains unchanged");
    const assetsRoot = resolve(gamesPath, secondEntry.projectId, "assets");
    const importDirectory = resolve(assetsRoot, importedAssets[0].importId);
    assert.deepEqual(await readFile(resolve(importDirectory, "source-metadata.json")), sourceImport.metadataBytes);
    for (const asset of importedAssets) {
      const sourceImage = sourceImport.images.find(image => image.path === asset.sourcePath);
      assert.deepEqual(await readFile(resolve(importDirectory, `${asset.assetId}.png`)), sourceImage.bytes);
    }

    for (const view of ["large", "medium", "small", "list"]) {
      await clickButton(`#palette-view button[data-view="${view}"]`);
      await waitFor(`document.querySelector("#asset-list").dataset.view === "${view}"`);
      assert.equal(await evaluate(`document.querySelectorAll('.asset-card[data-asset-id^="asset-"]').length`), 8,
        `all imported directions appear in ${view} palette view`);
    }
    await clickButton('#palette-view button[data-view="medium"]');
    const chosen = importedAssets.find(asset => asset.direction === "south");
    await evaluate(`window.__studioTest.setView({ zoom: 1, cameraX: 0, cameraY: 0 })`);
    await dragFromPalette(chosen.assetId, 184, 184);
    const placedGopher = (await studioDocument()).objects.find(object => object.assetId === chosen.assetId);
    assert.ok(placedGopher, "a selected static gopher direction can be placed");
    assert.equal(placedGopher.type, "prop");
    assert.equal(placedGopher.collision, null, "importing character artwork adds no collision");
    const placedBounds = genericProject.objectBounds(placedGopher, {
      ...genericProject.ASSET_CATALOG,
      [chosen.assetId]: importedAssetDefinition(chosen, "generic-grid-v1")
    });
    const alphaBounds = await evaluate(`(async () => {
      const image = new Image();
      image.src = "data:image/png;base64,${sourceImport.images.find(image => image.direction === "south").bytes.toString("base64")}";
      await image.decode();
      const sample = document.createElement("canvas");
      sample.width = image.naturalWidth;
      sample.height = image.naturalHeight;
      const context = sample.getContext("2d", { willReadFrequently: true });
      context.drawImage(image, 0, 0);
      const { data } = context.getImageData(0, 0, sample.width, sample.height);
      let left = sample.width, top = sample.height, right = -1, bottom = -1;
      for (let y = 0; y < sample.height; y += 1) for (let x = 0; x < sample.width; x += 1) {
        if (data[(y * sample.width + x) * 4 + 3] === 0) continue;
        left = Math.min(left, x); top = Math.min(top, y);
        right = Math.max(right, x); bottom = Math.max(bottom, y);
      }
      return { width: image.naturalWidth, height: image.naturalHeight,
        opaqueBounds: right < left ? null : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 } };
    })()`);
    const editorMeasure = await evaluate(`(() => {
      const canvas = document.querySelector("#map-canvas");
      const rect = canvas.getBoundingClientRect();
      const zoom = Number(canvas.dataset.zoom);
      const backingScale = canvas.width / rect.width;
      const transform = canvas.getContext("2d").getTransform();
      return { zoom, devicePixelRatio: window.devicePixelRatio, backingScale,
        worldWidth: ${chosen.width}, worldHeight: ${chosen.height},
        cssWidth: ${chosen.width} * transform.a * rect.width / canvas.width,
        cssHeight: ${chosen.height} * transform.d * rect.height / canvas.height };
    })()`);
    assert.deepEqual([alphaBounds.width, alphaBounds.height], [48, 48], "decoded source PNG remains 48x48 pixels");
    assert.deepEqual(alphaBounds.opaqueBounds, { x: 7, y: 5, width: 34, height: 37 },
      "the south-facing source artwork has transparent padding inside its 48x48 image");
    assert.deepEqual([placedBounds.width, placedBounds.height], [48, 48],
      "generic object geometry preserves imported source dimensions as world units");
    assert.deepEqual([editorMeasure.zoom, editorMeasure.cssWidth, editorMeasure.cssHeight], [1, 48, 48],
      "a newly placed 48x48 asset occupies 48x48 CSS pixels at 100% editor zoom");
    gopherMeasurements = { source: alphaBounds, assetId: chosen.assetId, placedWorld: placedBounds,
      editor: editorMeasure };
    expectedSecond = await studioDocument();
    await clickButton("#save");
    await waitFor(`document.querySelector("#save-state").textContent.includes("Saved")`);

    await clickButton("#import-assets");
    await setFileInput("#asset-import-file", gopherZipPath);
    await waitFor(`!document.querySelector("#asset-import-preview").hidden ||
      document.querySelector("#asset-import-message").textContent.startsWith("Could not preview")`);
    assert.equal(await evaluate(`!document.querySelector("#asset-import-preview").hidden &&
      document.querySelectorAll(".asset-preview-item").length === 8`), true,
    `duplicate preview failed: ${await evaluate(`document.querySelector("#asset-import-message").textContent`)}`);
    await fillInput("#asset-import-name", "Duplicate Gopher");
    await fillInput("#asset-import-author", "Supplied artist");
    await fillInput("#asset-import-source", "PixelLab export");
    await clickButton("#asset-import-submit");
    await waitFor(`document.querySelector("#asset-import-message").textContent.includes("already contains")`);
    assert.equal((await (await fetch(`${apiOrigin}/api/projects/${secondEntry.projectId}/assets`)).json()).assets.length, 8,
      "duplicate browser import creates no extra assets");
    await clickButton("#asset-import-cancel");

    const oversizedPngPath = join(profile, "oversized-asset.png");
    await writeFile(oversizedPngPath, makeRgbaPng(321, 48));
    await clickButton("#import-assets");
    await setFileInput("#asset-import-file", oversizedPngPath);
    await waitFor(`!document.querySelector("#asset-import-preview").hidden &&
      document.querySelectorAll(".asset-preview-item").length === 1`);
    await fillInput("#asset-import-name", "Too Wide For This Map");
    await fillInput("#asset-import-author", "Disposable test");
    await fillInput("#asset-import-source", "Generated browser test PNG");
    await clickButton("#asset-import-submit");
    const catalogAfterOversizedImport = (await (await fetch(`${apiOrigin}/api/projects/${secondEntry.projectId}/assets`)).json()).assets;
    const oversizedAsset = catalogAfterOversizedImport.find(asset => asset.width === 321 && asset.height === 48);
    assert.ok(oversizedAsset, "a valid image larger than the map remains imported at its original size");
    importedAssets.push(oversizedAsset);
    await waitFor(`document.querySelector('.asset-card[data-asset-id="${oversizedAsset.assetId}"]') !== null &&
      !document.querySelector("#asset-import-dialog").open`);
    const beforeOversizedPlacement = await studioDocument();
    const oversizedPreview = await dragFromPalette(oversizedAsset.assetId, 184, 184);
    assert.match(oversizedPreview, /:invalid$/, "an image wider than the map shows an invalid placement preview");
    await waitFor(`document.querySelector('[data-testid="studio-status"]').textContent.includes("larger than this")`);
    assert.deepEqual(await studioDocument(), beforeOversizedPlacement,
      "an image larger than the map is not silently resized or added to the document");
  }

  // Discard-and-create must retain edits if the server refuses creation.
  await dragFromPalette("generic-block", 48, 48);
  const dirtySecond = await studioDocument();
  await clickButton("#new-game");
  await fillInput("#new-name", "Browser Generic One");
  await fillInput("#new-author", "Disposable");
  await clickButton("#new-create");
  await clickButton("#new-discard");
  await waitFor(`document.querySelector("#new-message").textContent.includes("already exists")`);
  assert.deepEqual(await studioDocument(), dirtySecond, "failed creation never discards edits");
  await clickButton("#new-cancel");
  await clickButton("#undo");
  assert.deepEqual(await studioDocument(), expectedSecond);

  await stopChild(service);
  service = startService();
  await waitForHttp(mapUrl, service, "restarted SQLite service (generic games)");
  await reloadPage();
  await waitFor(`window.__studioTest !== undefined && document.querySelector("#map-canvas").dataset.layerCounts !== undefined`);
  for (const [entry, expected] of [[firstEntry, savedOnCreate], [secondEntry, expectedSecond]]) {
    await selectSaved(entry.projectId, entry.mapId);
    await waitFor(`!document.querySelector("#open-dialog").open && window.__studioTest.document().id === ${JSON.stringify(entry.mapId)}`);
    assert.deepEqual(await studioDocument(), expected, "generic designs reopen in isolation after restart");
    const paletteIds = await evaluate(`[...document.querySelectorAll(".asset-card")].map(card => card.dataset.assetId)`);
    assert.ok(paletteIds.every(id => id.startsWith("generic-") || id.startsWith("asset-")));
    assert.deepEqual(paletteIds.filter(id => id.startsWith("asset-")).sort(),
      (entry.projectId === secondEntry.projectId ? importedAssets.map(asset => asset.assetId) : []).sort(),
      "reopened project palette includes only its project-scoped assets");
    await clickButton("#play");
    await waitFor(`document.querySelector("#studio").dataset.playState === "playing" && document.querySelector('[data-testid="generic-preview"]')?.dataset.position !== undefined`);
    if (entry.projectId === secondEntry.projectId && gopherZipPath) {
      const expectedAssets = importedAssets.map(asset => asset.assetId);
      assert.deepEqual(JSON.parse(await evaluate(`document.querySelector('[data-testid="generic-preview"]').dataset.importedAssetIds`)),
        expectedAssets.filter(assetId => expected.objects.some(object => object.assetId === assetId)),
        "Play renders the placed imported artwork from the reopened project");
      const playMeasure = await evaluate(`(() => {
        const canvas = document.querySelector('[data-testid="generic-preview"]');
        const rect = canvas.getBoundingClientRect();
        const transform = canvas.getContext("2d").getTransform();
        return { backingWidth: canvas.width, cssWidth: rect.width, worldScale: transform.a,
          assetCssWidth: ${gopherMeasurements.placedWorld.width} * transform.a * rect.width / canvas.width,
          assetCssHeight: ${gopherMeasurements.placedWorld.height} * transform.d * rect.height / canvas.height };
      })()`);
      assert.ok(playMeasure.assetCssWidth > 0 && playMeasure.assetCssHeight > 0,
        "Play renders imported artwork with a measurable positive CSS extent");
      gopherMeasurements.play = playMeasure;
    }
    const positionBefore = JSON.parse(await evaluate(`document.querySelector('[data-testid="generic-preview"]').dataset.position`));
    assert.equal(await evaluate(`document.activeElement.dataset.testid`), "generic-preview");
    await key("keyDown", "ArrowRight", "ArrowRight");
    await delay(180);
    await key("keyUp", "ArrowRight", "ArrowRight");
    await delay(60);
    const positionAfter = JSON.parse(await evaluate(`document.querySelector('[data-testid="generic-preview"]').dataset.position`));
    assert.ok(positionAfter.x > positionBefore.x, "generic player moves via the installed public runtime");
    assert.equal(await evaluate(`document.querySelector('[data-testid="astraeum-world"]') === null`), true);
    await clickButton("#stop");
    assert.deepEqual(await studioDocument(), expected, "Stop does not persist movement");
  }
  await selectSaved("astraeum-tower", "astraeum-tower-floor-1");
  await waitFor(`!document.querySelector("#open-dialog").open && window.__studioTest.document().id === "astraeum-tower-floor-1"`);
  assert.deepEqual(await studioDocument(), astraeumBefore.document);
  assert.deepEqual(await (await fetch(mapUrl)).json(), astraeumBefore, "New Game leaves Astraeum content, timestamps and migrations unchanged");
  assert.equal(await evaluate(`document.querySelector('.asset-card[data-asset-id="wall-damp-stone"]') !== null`), true);

  assert.deepEqual(browserExceptions, [], "the Studio browser workflow reports no uncaught exceptions.");
  if (gopherMeasurements) console.log(`Imported gopher dimensions: ${JSON.stringify(gopherMeasurements)}`);
  console.log(`Studio workflow passed: migrated format 1 (${legacy.walls} walls, 1 collision box, backup kept); ` +
    `New Game created two generic projects via browser controls, validated inputs, rejected duplicates, cancelled safely, ` +
    `saved distinct maps, reopened after restart, moved in Play/Stop and returned to unchanged Astraeum; ` +
    `Open Game switched isolated projects, protected unsaved edits including failed saves, reopened after restart, ` +
    `played the selected map and required explicit untyped-model confirmation; ` +
    `unresolved collision labelled, assigned wall artwork / kept / deleted with undo; ` +
    `dragged a wall and a barrel from the palette; moved the wall off-grid without moving the floor; ` +
    `barrel stayed above the wall; snap, 5 px nudge, undo/redo, floor lock; saved and reopened; ` +
    `Play button ran the edited map and Aries stopped at x=${beforeRelease} against the wall at ` +
    `x=${nudged.transform.x}; Stop restored the view; unplayable map showed an actionable error; ` +
    `palette ${paletteViews.join("/")} views dragged-to-place and the view was remembered locally; ` +
    (gopherZipPath
      ? "imported the eight static 48x48 gopher directions with no animations, checked project isolation and duplicates, and verified placement, save/reopen and Play rendering."
      : "asset import browser checks skipped because STUDIO_GOPHER_ZIP was not set."));
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
  await rm(gamesPath, { recursive: true, force: true });
}
