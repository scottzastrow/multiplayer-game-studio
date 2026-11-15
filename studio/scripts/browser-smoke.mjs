import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, readdir, readFile, writeFile } from "node:fs/promises";
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
const attackEvidenceDir = process.env.STUDIO_ATTACK_EVIDENCE_DIR
  ? resolve(process.env.STUDIO_ATTACK_EVIDENCE_DIR)
  : null;
let service;
let web;
let chrome;
let socket;
let targetId;
let sessionId;
const playCameraMeasurements = [];
let smallWorldCameraMeasurements = null;
let multiSelectionEvidence = null;

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

async function clickSelector(selector, modifiers = 0) {
  const point = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error(${JSON.stringify(`Missing UI control: ${selector}`)});
    element.scrollIntoView({ block: "center" });
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  await cdp("Input.dispatchMouseEvent", {
    type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1, modifiers
  }, sessionId);
  await cdp("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1, modifiers
  }, sessionId);
}

async function clickWorld(x, y, modifiers = 0) {
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
    type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1, modifiers
  }, sessionId);
  await cdp("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1, modifiers
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

async function tapKey(code, keyValue) {
  await key("keyDown", code, keyValue);
  await key("keyUp", code, keyValue);
}

async function openPlayerSettings() {
  await clickButton("#player-settings");
  await waitFor(`document.querySelector("#player-settings-dialog").open`);
}

async function setControlModeInOpenSettings(value) {
  if (value === "game-controller") {
    await waitFor(`document.querySelector('[data-testid="player-controller-status"]').textContent.includes("Connected · Standard mapping")`);
  }
  await evaluate(`(() => {
    const select = document.querySelector('[data-testid="player-control-mode"]');
    select.value = ${JSON.stringify(value)};
    select.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await waitFor(`document.querySelector('[data-testid="player-control-mode"]').value === ${JSON.stringify(value)} &&
    document.querySelector("#player-mode-summary").textContent ===
      document.querySelector('[data-testid="player-control-mode"] option:checked').textContent`);
  const bindings = await evaluate(`document.querySelector('[data-testid="player-control-bindings"]').textContent`);
  const bindingPatterns = {
    "keyboard-only": /^WASD: Move · Arrow keys: Dodge · Space: Attack\.$/,
    "keyboard-mouse": /Arrow keys move.*Pointer aims.*Left click attacks.*right mouse \+ arrow/,
    "game-controller": /Left stick moves.*Right stick aims.*RT attacks.*B\/Circle/
  };
  assert.match(bindings, bindingPatterns[value], `${value} bindings are shown in Player Settings.`);
  if (value === "game-controller") {
    assert.match(await evaluate(`document.querySelector('[data-testid="player-controller-status"]').textContent`),
      /Connected · Standard mapping · Studio standard test pad/,
      "Player Settings reports the simulated controller connection and standard mapping.");
  }
  assert.equal(await evaluate(`localStorage.getItem("web-studio.player-control-mode.v1")`), value,
    `${value} is persisted as a local user preference.`);
}

async function closePlayerSettings() {
  await clickButton("#player-settings-close");
  await waitFor(`!document.querySelector("#player-settings-dialog").open &&
    document.activeElement === (document.querySelector("#studio").dataset.playState === "playing"
      ? document.querySelector('[data-testid="astraeum-world"], [data-testid="generic-preview"]')
      : document.querySelector("#player-settings"))`);
}

async function selectControlMode(value) {
  await openPlayerSettings();
  await setControlModeInOpenSettings(value);
  await closePlayerSettings();
}

async function mouseEvent(type, x, y, button = "none", buttons = 0) {
  await cdp("Input.dispatchMouseEvent", { type, x, y, button, buttons }, sessionId);
}

async function canvasPoint() {
  return evaluate(`(() => {
    const rect = document.querySelector('[data-testid="astraeum-world"]').getBoundingClientRect();
    return { x: rect.left + rect.width * 0.75, y: rect.top + rect.height * 0.5 };
  })()`);
}

async function setFakeGamepad({ connected = true, axes = [0, 0, 0, 0], dodge = false, trigger = false } = {}) {
  await evaluate(`(() => {
    const pad = window.__studioFakeGamepad ?? {
      id: "Studio standard test pad", index: 0, connected: true, mapping: "standard",
      axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }))
    };
    pad.connected = ${connected};
    pad.axes = ${JSON.stringify(axes)};
    pad.buttons[1] = { pressed: ${dodge}, value: ${dodge ? 1 : 0} };
    pad.buttons[7] = { pressed: ${trigger}, value: ${trigger ? 1 : 0} };
    window.__studioFakeGamepad = pad;
    Object.defineProperty(navigator, "getGamepads", {
      configurable: true, value: () => pad.connected ? [pad] : [null]
    });
  })()`);
}

async function controllerSnapshot() {
  return evaluate(`(() => {
    const canvas = document.querySelector('[data-testid="astraeum-world"]');
    const pad = window.__studioFakeGamepad;
    return {
      input: {
        axes: [...pad.axes],
        dodge: { pressed: pad.buttons[1].pressed, value: pad.buttons[1].value },
        trigger: { pressed: pad.buttons[7].pressed, value: pad.buttons[7].value }
      },
      position: { x: Number(canvas.dataset.x), y: Number(canvas.dataset.y) },
      stick: { x: Number(canvas.dataset.controllerMoveX), y: Number(canvas.dataset.controllerMoveY) },
      dodgeDirection: { x: Number(canvas.dataset.dodgeDirectionX), y: Number(canvas.dataset.dodgeDirectionY) },
      facing: canvas.dataset.facing,
      remainingDuration: Number(canvas.dataset.dodgeFrames),
      stamina: Number(canvas.dataset.stamina),
      cooldown: Number(canvas.dataset.dodgeCooldownFrames),
      simulationTick: Number(canvas.dataset.simulationTick),
      dodgesStarted: Number(canvas.dataset.dodgesStarted)
    };
  })()`);
}

async function captureAttackEvidence(direction, phase) {
  const dataUrl = await evaluate(`document.querySelector('[data-testid="astraeum-world"]').toDataURL("image/png")`);
  assert.match(dataUrl, /^data:image\/png;base64,/);
  const image = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
  assert.equal(image.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.ok(image.readUInt32BE(16) > 400 && image.readUInt32BE(20) > 300,
    "the attack evidence captures the rendered Play canvas.");
  if (!attackEvidenceDir) return null;
  await mkdir(attackEvidenceDir, { recursive: true });
  const path = join(attackEvidenceDir, `astraeum-attack-${phase}-${direction}.png`);
  await writeFile(path, image);
  return path;
}

async function setViewport(width, height) {
  await cdp("Emulation.setDeviceMetricsOverride", {
    width, height, deviceScaleFactor: 1, mobile: false
  }, sessionId);
  await waitFor(`window.innerWidth === ${width} && window.innerHeight === ${height}`);
}

const canvasData = name => evaluate(`document.querySelector("#map-canvas").dataset.${name}`);
const studioDocument = () => evaluate(`window.__studioTest.document()`);
const objectById = async id => (await studioDocument()).objects.find(object => object.id === id);
const studioView = () => evaluate(`window.__studioTest.view()`);
const saveState = () => evaluate(`document.querySelector("#save-state").textContent`);

async function worldPoint(x, y) {
  return evaluate(`window.__studioTest.worldToClient(${x}, ${y})`);
}

async function mouse(type, point, buttons = type === "mouseReleased" ? 0 : 1, modifiers = 0) {
  await cdp("Input.dispatchMouseEvent", {
    type, x: point.x, y: point.y, button: "left", buttons, clickCount: 1, modifiers
  }, sessionId);
}

async function dragPath(from, to, check, modifiers = 0) {
  await mouse("mousePressed", from, 1, modifiers);
  for (let step = 1; step <= 6; step += 1) {
    await mouse("mouseMoved", {
      x: from.x + (to.x - from.x) * step / 6,
      y: from.y + (to.y - from.y) * step / 6
    }, 1, modifiers);
  }
  if (check) await check();
  await mouse("mouseReleased", to, 0, modifiers);
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

async function dragWorld(from, to, check, modifiers = 0) {
  await dragPath(await worldPoint(from.x, from.y), await worldPoint(to.x, to.y), check, modifiers);
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
  for (const id of ["item-chest", "item-herb", "item-mushroom", "item-amethyst", "item-sapphire"]) {
    assert.equal(initial.badges[id], "editor-only:Editor only", `${id} is marked as having no gameplay.`);
  }
  assert.equal(initial.badges["spawn-slime"], "implemented:In Play",
    "Floor 1 slime markers are represented in Play.");
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
  assert.equal(await evaluate(`document.querySelector("#player-settings").hidden`), false,
    "Player Settings is available before Play.");
  assert.equal(await evaluate(`document.querySelector("#player-mode-summary").textContent`), "Keyboard + Mouse",
    "the toolbar shows the current player mode.");
  await selectControlMode("keyboard-only");
  assert.equal(await evaluate(`localStorage.getItem("web-studio.player-control-mode.v1")`), "keyboard-only",
    "the control preference persists locally before Play.");
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
  await selectControlMode("keyboard-only");
  assert.match(await evaluate(`document.querySelector('[data-testid="astraeum-controls"]').textContent`),
    /WASD: Move · Arrow keys: Dodge · Space: Attack\./, "Play controls show Keyboard Only bindings.");
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

  // Run the authored Floor 1 slime encounter through Studio's actual Play button.
  await evaluate(`window.__studioTest.setView({ zoom: 1, cameraX: 0, cameraY: 0 })`);
  await clickWorld(180, 144);
  assert.equal(await canvasData("selectedId"), wallId, "the nearby test wall is selected for temporary repositioning.");
  await dragWorld({ x: 180, y: 144 }, { x: 320, y: 144 });
  const encounterWall = await objectById(wallId);
  assert.ok(encounterWall.transform.x > 240, "the disposable encounter route no longer has the test wall in front of Aries.");
  await clickButton("#play");
  await waitFor(`document.querySelector("#studio").dataset.playState === "playing" &&
    Number(document.querySelector('[data-testid="astraeum-world"]')?.dataset.slimeCount) > 0`);
  await selectControlMode("keyboard-only");
  const encounterStart = await evaluate(`(() => {
    const canvas = document.querySelector('[data-testid="astraeum-world"]');
    return {
      x: Number(canvas.dataset.x), y: Number(canvas.dataset.y),
      hp: Number(canvas.dataset.playerHp),
      slimes: JSON.parse(canvas.dataset.slimes)
    };
  })()`);
  assert.equal(encounterStart.x, 144);
  assert.ok(encounterStart.slimes.some(slime => slime.hp === 36 && slime.state === "idle"),
    "Floor 1 slime markers spawn full-health enemies.");
  await key("keyDown", "KeyS", "s");
  await waitFor(`Number(document.querySelector('[data-testid="astraeum-world"]').dataset.y) >= 172`);
  await key("keyUp", "KeyS", "s");
  await key("keyDown", "KeyD", "d");
  await waitFor(`Number(document.querySelector('[data-testid="astraeum-world"]').dataset.x) >= 360`);
  await key("keyUp", "KeyD", "d");
  const nearestSlime = encounterStart.slimes.filter(slime => slime.x > encounterStart.x).reduce((nearest, slime) =>
    Math.hypot(slime.x - encounterStart.x, slime.y - encounterStart.y) <
      Math.hypot(nearest.x - encounterStart.x, nearest.y - encounterStart.y) ? slime : nearest);
  await waitFor(`JSON.parse(document.querySelector('[data-testid="astraeum-world"]').dataset.slimes)
    .some(slime => slime.id === ${JSON.stringify(nearestSlime.id)} && slime.state === "chase" &&
      slime.x !== ${nearestSlime.x})`, 5000);
  await waitFor(`Number(document.querySelector('[data-testid="astraeum-world"]').dataset.damageTaken) >= 12`, 10000);
  const slimeAttack = await evaluate(`(() => {
    const canvas = document.querySelector('[data-testid="astraeum-world"]');
    return {
      hp: Number(canvas.dataset.playerHp),
      damageTaken: Number(canvas.dataset.damageTaken),
      slimes: JSON.parse(canvas.dataset.slimes)
    };
  })()`);
  assert.ok(slimeAttack.hp < encounterStart.hp && slimeAttack.damageTaken >= 12,
    "slime contact attacks apply damage to Aries.");
  await tapKey("Space", " ");
  await waitFor(`Number(document.querySelector('[data-testid="astraeum-world"]').dataset.damageDealt) >= 30`, 5000);
  await waitFor(`Number(document.querySelector('[data-testid="astraeum-world"]').dataset.attackFrame) === 0 &&
    Number(document.querySelector('[data-testid="astraeum-world"]').dataset.attackCooldownFrames) === 0`, 5000);
  await tapKey("Space", " ");
  await waitFor(`Number(document.querySelector('[data-testid="astraeum-world"]').dataset.slimesDefeated) >= 1`, 5000);
  const encounterResult = await evaluate(`(() => {
    const canvas = document.querySelector('[data-testid="astraeum-world"]');
    return {
      defeated: Number(canvas.dataset.slimesDefeated),
      damageDealt: Number(canvas.dataset.damageDealt),
      remaining: Number(canvas.dataset.slimeCount),
      lastEvent: canvas.dataset.lastEvent,
      hud: document.querySelector('[data-testid="astraeum-hud"]').textContent
    };
  })()`);
  assert.equal(encounterResult.defeated, 1, "the Halberd defeats a slime.");
  assert.ok(encounterResult.damageDealt >= 36, "Halberd damage is capped at the slime's remaining HP.");
  assert.equal(encounterResult.lastEvent, "slime-defeated");
  assert.match(encounterResult.hud, /HP.*Stamina.*Slimes/i);
  await clickButton("#stop");
  await waitFor(`document.querySelector("#studio").dataset.playState === "idle"`);
  await clickButton("#undo");
  assert.equal(JSON.stringify(await studioDocument()), savedDocument,
    "the encounter and its temporary route change do not alter the saved project.");

  const slimeMarkers = (await studioDocument()).objects
    .filter(object => object.assetId === "spawn-slime");
  assert.ok(slimeMarkers.length > 0, "directional attack visuals use the authored Floor 1 map.");
  for (const marker of slimeMarkers) {
    await clickWorld(marker.transform.x, marker.transform.y);
    assert.equal(await canvasData("selectedId"), marker.id, `slime marker ${marker.id} is selected for the visual-only run.`);
    await clickButton("#delete-object");
    await waitFor(`!window.__studioTest.document().objects.some(object => object.id === ${JSON.stringify(marker.id)})`);
  }
  await clickButton("#play");
  await waitFor(`document.querySelector("#studio").dataset.playState === "playing" &&
    document.querySelector('[data-testid="astraeum-world"]') !== null`);
  assert.equal(await evaluate(`document.activeElement === document.querySelector('[data-testid="astraeum-world"]')`),
    true, "Studio focuses the Play canvas automatically.");
  await selectControlMode("keyboard-only");
  assert.match(await evaluate(`document.querySelector('[data-testid="astraeum-controls"]').textContent`),
    /Space: Attack/, "Keyboard Only instructions show Space as attack.");
  const keyboardMoveStart = await evaluate(`(() => {
    const canvas = document.querySelector('[data-testid="astraeum-world"]');
    return { x: Number(canvas.dataset.x), dodges: Number(canvas.dataset.dodgesStarted) };
  })()`);
  await key("keyDown", "KeyD", "d");
  await delay(180);
  await key("keyUp", "KeyD", "d");
  const keyboardMoveEnd = await evaluate(`(() => {
    const canvas = document.querySelector('[data-testid="astraeum-world"]');
    return { x: Number(canvas.dataset.x), y: Number(canvas.dataset.y), dodges: Number(canvas.dataset.dodgesStarted) };
  })()`);
  assert.ok(keyboardMoveEnd.x > keyboardMoveStart.x, "Keyboard Only WASD moves the player.");
  assert.equal(keyboardMoveEnd.dodges, keyboardMoveStart.dodges, "WASD movement does not dodge.");
  await key("keyDown", "KeyS", "s");
  await waitFor(`Number(document.querySelector('[data-testid="astraeum-world"]').dataset.y) > ${keyboardMoveEnd.y + 2}`);
  await openPlayerSettings();
  const settingsPausePosition = Number(await evaluate(`document.querySelector('[data-testid="astraeum-world"]').dataset.y`));
  await delay(200);
  assert.equal(Number(await evaluate(`document.querySelector('[data-testid="astraeum-world"]').dataset.y`)),
    settingsPausePosition, "opening Player Settings neutralizes held gameplay movement.");
  await setControlModeInOpenSettings("keyboard-mouse");
  await closePlayerSettings();
  const modeSwitchPosition = Number(await evaluate(`document.querySelector('[data-testid="astraeum-world"]').dataset.y`));
  await delay(200);
  assert.equal(Number(await evaluate(`document.querySelector('[data-testid="astraeum-world"]').dataset.y`)),
    modeSwitchPosition, "closing Player Settings does not restore stale held keyboard movement.");
  await key("keyUp", "KeyS", "s");
  await selectControlMode("keyboard-only");
  const shortcutPosition = Number(await evaluate(`document.querySelector('[data-testid="astraeum-world"]').dataset.y`));
  await key("keyDown", "KeyS", "s", 2);
  await key("keyUp", "KeyS", "s", 2);
  await delay(50);
  assert.equal(Number(await evaluate(`document.querySelector('[data-testid="astraeum-world"]').dataset.y`)),
    shortcutPosition, "Ctrl+S does not become gameplay movement.");
  assert.deepEqual((await (await fetch(mapUrl)).json()).document, JSON.parse(savedDocument),
    "the editor save shortcut does not intercept keyboard input while Play is active.");
  const directionalAttackEvidence = [];
  for (const { facing, code, keyValue } of [
    { facing: "north", code: "KeyW", keyValue: "w" },
    { facing: "east", code: "KeyD", keyValue: "d" },
    { facing: "south", code: "KeyS", keyValue: "s" },
    { facing: "west", code: "KeyA", keyValue: "a" }
  ]) {
    await key("keyDown", code, keyValue);
    await waitFor(`document.querySelector('[data-testid="astraeum-world"]').dataset.facing === ${JSON.stringify(facing)}`);
    await key("keyUp", code, keyValue);
    await tapKey("Space", " ");
    await waitFor(`(() => {
      const frame = Number(document.querySelector('[data-testid="astraeum-world"]').dataset.attackFrame);
      return frame >= 4 && frame <= 6;
    })()`, 3000);
    const thrustFrame = Number(await evaluate(`document.querySelector('[data-testid="astraeum-world"]').dataset.attackFrame`));
    const thrustPath = await captureAttackEvidence(facing, "thrust");
    await waitFor(`(() => {
      const frame = Number(document.querySelector('[data-testid="astraeum-world"]').dataset.attackFrame);
      return frame >= 10 && frame <= 20;
    })()`, 3000);
    const sweepFrame = Number(await evaluate(`document.querySelector('[data-testid="astraeum-world"]').dataset.attackFrame`));
    const sweepPath = await captureAttackEvidence(facing, "sweep");
    directionalAttackEvidence.push({ facing, thrustFrame, thrustPath, sweepFrame, sweepPath });
    await waitFor(`Number(document.querySelector('[data-testid="astraeum-world"]').dataset.attackFrame) === 0 &&
      Number(document.querySelector('[data-testid="astraeum-world"]').dataset.attackCooldownFrames) === 0`, 3000);
  }

  const uiFocusPosition = Number(await evaluate(`document.querySelector('[data-testid="astraeum-world"]').dataset.x`));
  await evaluate(`document.querySelector('[data-setting="ambientBrightness"]').focus()`);
  await key("keyDown", "ArrowRight", "ArrowRight");
  await key("keyUp", "ArrowRight", "ArrowRight");
  assert.equal(Number(await evaluate(`document.querySelector('[data-testid="astraeum-world"]').dataset.x`)),
    uiFocusPosition, "Play input is inactive while a UI control has focus.");

  await selectControlMode("keyboard-mouse");
  assert.match(await evaluate(`document.querySelector('[data-testid="astraeum-controls"]').textContent`),
    /arrows move.*pointer aims.*left click attacks.*right mouse \+ arrow to dodge/,
    "Keyboard + Mouse instructions show its movement, aim, attack, and dodge bindings.");
  assert.equal(await evaluate(`(() => {
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    document.querySelector('[data-testid="astraeum-world"]').dispatchEvent(event);
    return event.defaultPrevented;
  })()`), true, "context menus are suppressed over gameplay.");
  const keyboardMouseStart = await evaluate(`(() => {
    const canvas = document.querySelector('[data-testid="astraeum-world"]');
    return { x: Number(canvas.dataset.x), y: Number(canvas.dataset.y),
      dodges: Number(canvas.dataset.dodgesStarted) };
  })()`);
  await key("keyDown", "ArrowRight", "ArrowRight");
  await delay(250);
  await key("keyUp", "ArrowRight", "ArrowRight");
  await delay(80);
  const arrowMove = await evaluate(`(() => {
    const canvas = document.querySelector('[data-testid="astraeum-world"]');
    return { x: Number(canvas.dataset.x), dodges: Number(canvas.dataset.dodgesStarted) };
  })()`);
  assert.ok(arrowMove.x > keyboardMouseStart.x, "Keyboard + Mouse arrows move the player.");
  assert.equal(arrowMove.dodges, keyboardMouseStart.dodges, "arrows alone do not dodge.");
  const mouseDodgeStartY = Number(await evaluate(`document.querySelector('[data-testid="astraeum-world"]').dataset.y`));
  const mousePoint = await canvasPoint();
  await mouseEvent("mouseMoved", mousePoint.x, mousePoint.y);
  await mouseEvent("mousePressed", mousePoint.x, mousePoint.y, "right", 2);
  await key("keyDown", "ArrowUp", "ArrowUp");
  await waitFor(`Number(document.querySelector('[data-testid="astraeum-world"]').dataset.dodgesStarted) === ${arrowMove.dodges + 1}`);
  const mouseDodge = await evaluate(`(() => {
    const canvas = document.querySelector('[data-testid="astraeum-world"]');
    return { y: Number(canvas.dataset.y), frames: Number(canvas.dataset.dodgeFrames) };
  })()`);
  assert.ok(mouseDodge.frames > 0 && mouseDodge.y < mouseDodgeStartY - 1,
    "right mouse plus an arrow begins a directional dash.");
  await key("keyUp", "ArrowUp", "ArrowUp");
  await mouseEvent("mouseReleased", mousePoint.x, mousePoint.y, "right", 0);
  await delay(500);
  const noRepeatMouse = Number(await evaluate(`document.querySelector('[data-testid="astraeum-world"]').dataset.dodgesStarted`));
  assert.equal(noRepeatMouse, arrowMove.dodges + 1, "holding right mouse does not repeat a dodge.");
  await mouseEvent("mousePressed", mousePoint.x, mousePoint.y, "left", 1);
  await waitFor(`Number(document.querySelector('[data-testid="astraeum-world"]').dataset.attackFrame) > 0`);
  await mouseEvent("mouseReleased", mousePoint.x, mousePoint.y, "left", 0);
  await waitFor(`Number(document.querySelector('[data-testid="astraeum-world"]').dataset.attackCooldownFrames) === 0 &&
    Number(document.querySelector('[data-testid="astraeum-world"]').dataset.attackFrame) === 0`);
  await selectControlMode("keyboard-only");
  await waitFor(`Number(document.querySelector('[data-testid="astraeum-world"]').dataset.stamina) >= 100`, 5000);
  const keyDodgeCount = Number(await evaluate(`document.querySelector('[data-testid="astraeum-world"]').dataset.dodgesStarted`));
  await key("keyDown", "ArrowLeft", "ArrowLeft");
  await waitFor(`Number(document.querySelector('[data-testid="astraeum-world"]').dataset.dodgesStarted) === ${keyDodgeCount + 1}`);
  await key("keyUp", "ArrowLeft", "ArrowLeft");
  await key("keyDown", "ArrowRight", "ArrowRight");
  await key("keyUp", "ArrowRight", "ArrowRight");
  await delay(80);
  assert.equal(Number(await evaluate(`document.querySelector('[data-testid="astraeum-world"]').dataset.dodgesStarted`)),
    keyDodgeCount + 1, "dodge cooldown blocks an immediate second keyboard press.");
  await waitFor(`Number(document.querySelector('[data-testid="astraeum-world"]').dataset.dodgeFrames) === 0 &&
    Number(document.querySelector('[data-testid="astraeum-world"]').dataset.dodgeCooldownFrames) === 0`);
  await key("keyDown", "ArrowDown", "ArrowDown");
  await waitFor(`Number(document.querySelector('[data-testid="astraeum-world"]').dataset.dodgesStarted) === ${keyDodgeCount + 2}`);
  await delay(400);
  assert.equal(Number(await evaluate(`document.querySelector('[data-testid="astraeum-world"]').dataset.dodgesStarted`)),
    keyDodgeCount + 2, "a held Keyboard Only dodge key does not repeat.");
  await key("keyUp", "ArrowDown", "ArrowDown");
  await waitFor(`Number(document.querySelector('[data-testid="astraeum-world"]').dataset.dodgeFrames) === 0 &&
    Number(document.querySelector('[data-testid="astraeum-world"]').dataset.dodgeCooldownFrames) === 0`);
  const insufficientKeyboardDodgeCount = Number(await evaluate(`document.querySelector('[data-testid="astraeum-world"]').dataset.dodgesStarted`));
  assert.ok(Number(await evaluate(`document.querySelector('[data-testid="astraeum-world"]').dataset.stamina`)) < 34,
    "two quick dodges leave insufficient stamina for another.");
  await key("keyDown", "ArrowRight", "ArrowRight");
  await key("keyUp", "ArrowRight", "ArrowRight");
  await delay(100);
  assert.equal(Number(await evaluate(`document.querySelector('[data-testid="astraeum-world"]').dataset.dodgesStarted`)),
    insufficientKeyboardDodgeCount, "insufficient stamina rejects a real keyboard dodge.");
  await waitFor(`Number(document.querySelector('[data-testid="astraeum-world"]').dataset.stamina) >= 100`, 5000);
  await setFakeGamepad({ axes: [0, 0, 0, 0] });
  await selectControlMode("game-controller");
  assert.match(await evaluate(`document.querySelector('[data-testid="astraeum-controls"]').textContent`),
    /left stick moves.*right stick aims.*RT attacks.*B\/Circle.*dodge/,
    "controller instructions show the standard bindings.");
  await waitFor(`document.querySelector('[data-testid="astraeum-controller-status"]').textContent.includes("connected")`);
  const controllerMoveStart = Number(await evaluate(`document.querySelector('[data-testid="astraeum-world"]').dataset.x`));
  const controllerDodgeBeforeMovement = Number(await evaluate(`document.querySelector('[data-testid="astraeum-world"]').dataset.dodgesStarted`));
  await setFakeGamepad({ axes: [0.55, 0, 0.8, 0] });
  await waitFor(`Number(document.querySelector('[data-testid="astraeum-world"]').dataset.x) > ${controllerMoveStart + 3}`);
  const analogMove = await evaluate(`(() => {
    const canvas = document.querySelector('[data-testid="astraeum-world"]');
    return { x: Number(canvas.dataset.controllerMoveX), facing: canvas.dataset.facing,
      dodges: Number(canvas.dataset.dodgesStarted) };
  })()`);
  assert.ok(analogMove.x > 0.45 && analogMove.x < 0.49, `left-stick analog magnitude is preserved (${analogMove.x}).`);
  assert.equal(analogMove.facing, "east", "right stick supplies independent aim.");
  assert.equal(analogMove.dodges, controllerDodgeBeforeMovement, "controller stick movement alone does not dodge.");
  const neutralStickDodges = analogMove.dodges;
  await setFakeGamepad({ axes: [0, 0, 0, 0] });
  await delay(80);
  await setFakeGamepad({ axes: [0, 0, 0, 0], dodge: true });
  await delay(150);
  assert.equal(Number(await evaluate(`document.querySelector('[data-testid="astraeum-world"]').dataset.dodgesStarted`)),
    neutralStickDodges, "controller dodge at neutral stick does nothing.");
  await setFakeGamepad({ axes: [0, 0, 0, 0] });
  await delay(80);
  const controllerDodgeStart = await controllerSnapshot();
  const controllerMap = await evaluate(`window.__studioTest.document()`);
  await setFakeGamepad({ axes: [0.75, 0, 0.8, 0], dodge: true });
  const controllerDodgeInput = await controllerSnapshot();
  await waitFor(`Number(document.querySelector('[data-testid="astraeum-world"]').dataset.dodgesStarted) === ${neutralStickDodges + 1}`);
  const controllerDodge = await controllerSnapshot();
  const controllerDodgeEvidence = {
    start: controllerDodgeStart,
    input: controllerDodgeInput,
    after: controllerDodge,
    sampledAfterDodgeFinished: controllerDodge.remainingDuration === 0 && controllerDodge.cooldown > 0
  };
  assert.ok(controllerDodge.remainingDuration > 0,
    `the standard gamepad starts a dodge before it finishes; evidence=${JSON.stringify(controllerDodgeEvidence)}`);
  assert.ok(controllerDodge.position.x > controllerDodgeStart.position.x + 3,
    `the standard left stick moves the player east during the dodge; evidence=${JSON.stringify(controllerDodgeEvidence)}`);
  await delay(400);
  const controllerDodgeEnd = await controllerSnapshot();
  const left = Math.min(controllerDodgeStart.position.x, controllerDodgeEnd.position.x) - 9;
  const right = Math.max(controllerDodgeStart.position.x, controllerDodgeEnd.position.x) + 9;
  const top = Math.min(controllerDodgeStart.position.y, controllerDodgeEnd.position.y) - 8;
  const bottom = Math.max(controllerDodgeStart.position.y, controllerDodgeEnd.position.y) + 8;
  const nearbyCollisions = controllerMap.objects
    .filter(object => object.collision)
    .map(object => ({ id: object.id, ...project.collisionRect(object) }))
    .map(collision => {
      const dx = Math.max(collision.x - right, left - collision.x - collision.width, 0);
      const dy = Math.max(collision.y - bottom, top - collision.y - collision.height, 0);
      return { ...collision, distance: Math.hypot(dx, dy) };
    })
    .filter(collision => collision.distance <= 96)
    .sort((nearer, farther) => nearer.distance - farther.distance)
    .slice(0, 6);
  Object.assign(controllerDodgeEvidence, { end: controllerDodgeEnd, nearbyCollisions });
  console.log("Standard gamepad directional-dodge evidence:", JSON.stringify(controllerDodgeEvidence));
  assert.ok(controllerDodgeEnd.remainingDuration === 0 &&
    controllerDodgeEnd.dodgeDirection.x > 0 &&
    controllerDodgeEnd.position.x > controllerDodgeStart.position.x + 30,
  `the standard left stick completes a meaningful eastward dodge; evidence=${JSON.stringify(controllerDodgeEvidence)}`);
  assert.equal(Number(await evaluate(`document.querySelector('[data-testid="astraeum-world"]').dataset.dodgesStarted`)),
    neutralStickDodges + 1, "holding B/Circle does not repeat a controller dodge.");
  const controllerReleaseTick = Number(await evaluate(`document.querySelector('[data-testid="astraeum-world"]').dataset.simulationTick`));
  await setFakeGamepad({ axes: [0, 0, 0, 0], dodge: false });
  await waitFor(`Number(document.querySelector('[data-testid="astraeum-world"]').dataset.attackCooldownFrames) === 0 &&
    Number(document.querySelector('[data-testid="astraeum-world"]').dataset.attackFrame) === 0 &&
    Number(document.querySelector('[data-testid="astraeum-world"]').dataset.dodgeFrames) === 0 &&
    Number(document.querySelector('[data-testid="astraeum-world"]').dataset.dodgeCooldownFrames) === 0 &&
    Number(document.querySelector('[data-testid="astraeum-world"]').dataset.simulationTick) > ${controllerReleaseTick}`);
  const controllerRearmStart = await controllerSnapshot();
  await setFakeGamepad({ axes: [-0.75, 0, 0.8, 0], dodge: true });
  await waitFor(`Number(document.querySelector('[data-testid="astraeum-world"]').dataset.dodgesStarted) === ${neutralStickDodges + 2}`);
  const controllerRearm = await controllerSnapshot();
  assert.ok(controllerRearm.remainingDuration > 0 &&
    controllerRearm.position.x < controllerRearmStart.position.x - 3,
  `releasing and pressing B/Circle re-arms a leftward dodge; before=${JSON.stringify(controllerRearmStart)} after=${JSON.stringify(controllerRearm)}`);
  await setFakeGamepad({ axes: [0, 0, 0, 0], dodge: false });
  await waitFor(`Number(document.querySelector('[data-testid="astraeum-world"]').dataset.dodgeFrames) === 0 &&
    Number(document.querySelector('[data-testid="astraeum-world"]').dataset.dodgeCooldownFrames) === 0`);
  await setFakeGamepad({ axes: [0, 0, 0, 0], dodge: false, trigger: true });
  await waitFor(`Number(document.querySelector('[data-testid="astraeum-world"]').dataset.attackFrame) > 0`);
  await setFakeGamepad({ axes: [0, 0, 0, 0], dodge: false, trigger: false });
  await setFakeGamepad({ axes: [0.8, 0, 0, 0], dodge: false });
  const movingControllerX = Number(await evaluate(`document.querySelector('[data-testid="astraeum-world"]').dataset.x`));
  await waitFor(`Number(document.querySelector('[data-testid="astraeum-world"]').dataset.x) > ${movingControllerX + 3}`);
  await setFakeGamepad({ connected: false });
  await waitFor(`document.querySelector('[data-testid="astraeum-controller-status"]').textContent.includes("disconnected")`);
  const disconnectTick = Number(await evaluate(`document.querySelector('[data-testid="astraeum-world"]').dataset.simulationTick`));
  await waitFor(`Number(document.querySelector('[data-testid="astraeum-world"]').dataset.simulationTick) > ${disconnectTick} &&
    Number(document.querySelector('[data-testid="astraeum-world"]').dataset.controllerMoveX) === 0`);
  const disconnectX = Number(await evaluate(`document.querySelector('[data-testid="astraeum-world"]').dataset.x`));
  await delay(200);
  assert.equal(Number(await evaluate(`document.querySelector('[data-testid="astraeum-world"]').dataset.x`)),
    disconnectX, "gamepad disconnect clears movement.");
  await evaluate(`window.dispatchEvent(new Event("blur"))`);
  await setFakeGamepad({ axes: [0.8, 0, 0, 0] });
  await delay(150);
  const blurX = Number(await evaluate(`document.querySelector('[data-testid="astraeum-world"]').dataset.x`));
  assert.equal(blurX, disconnectX, "window blur prevents stale controller movement.");
  await evaluate(`window.dispatchEvent(new Event("focus"))`);
  await setFakeGamepad({ connected: false });
  await clickButton("#stop");
  for (let index = 0; index < slimeMarkers.length; index += 1) await clickButton("#undo");
  assert.equal(JSON.stringify(await studioDocument()), savedDocument,
    "directional attack visual checks do not persist changes to the authored project.");

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
    const selector = `.open-entry[data-project-id="${projectId}"] input`;
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
  assert.equal(await evaluate(`document.querySelector("#new-width") === null &&
    document.querySelector("#new-height") === null`), true, "New Game has no editable world dimensions.");
  assert.equal(await evaluate(`document.querySelector("#new-world-size").textContent.includes("2048 × 2048")`),
    true, "New Game states the fixed world size.");
  await fillInput("#new-name", "   ");
  await fillInput("#new-author", "Disposable credits");
  await clickButton("#new-create");
  assert.match(await evaluate(`document.querySelector("#new-message").textContent`), /nonblank/);
  await fillInput("#new-name", "Browser Generic One");
  await clickButton("#new-create");
  await waitFor(`!document.querySelector("#new-dialog").open && document.querySelector("#project-name").textContent === "Browser Generic One"`);
  const firstGeneric = await studioDocument();
  assert.equal(firstGeneric.objects.length, 2, "generic starter contains only safe player spawns");
  assert.deepEqual(firstGeneric.bounds, { width: 2048, height: 2048 });
  await assertStableHierarchy();
  const wallsInitiallyOpen = await evaluate(`document.querySelector('.tree-group[data-layer="walls"]').open`);
  await clickButton('.tree-group[data-layer="walls"] > summary');
  assert.equal(await evaluate(`document.querySelector('.tree-group[data-layer="walls"]').open`), !wallsInitiallyOpen);
  await clickButton('.tree-group[data-layer="walls"] > summary');
  assert.equal(await evaluate(`document.querySelector('.tree-group[data-layer="walls"]').open`), wallsInitiallyOpen);
  await assertStableHierarchy();
  const listing = (await (await fetch(`${apiOrigin}/api/projects`)).json()).maps;
  const firstEntry = listing.find(entry => entry.mapId === firstGeneric.id);
  assert.equal(firstEntry.model, "generic-grid-v1");
  assert.deepEqual((await (await fetch(`${apiOrigin}/api/projects/${firstEntry.projectId}/maps/${firstEntry.mapId}`)).json())
    .document.bounds, { width: 2048, height: 2048 }, "the created map is saved at the fixed world size.");
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
  await dragFromPalette("generic-marker", 240, 80);
  let savedOnCreate = await studioDocument();
  let markerObjects = savedOnCreate.objects.filter(object => object.assetId === "generic-marker")
    .sort((left, right) => left.transform.x - right.transform.x);
  assert.equal(markerObjects.length, 2);
  const markerIds = markerObjects.map(object => object.id);
  const markerCenters = markerObjects.map(object => ({
    x: object.transform.x + 16,
    y: object.transform.y + 16
  }));
  await clickWorld(markerCenters[0].x, markerCenters[0].y);
  await clickWorld(markerCenters[1].x, markerCenters[1].y, 8);
  const shiftedSelection = JSON.parse(await canvasData("selectedIds")).sort();
  assert.deepEqual(shiftedSelection, [...markerIds].sort(), "Shift-click adds the second object.");
  assert.equal(await evaluate(`document.querySelectorAll(".tree-item.selected").length`), 2,
    "map selection is reflected in the hierarchy.");
  assert.equal(await evaluate(`!document.querySelector("#selection-inspector").hidden &&
    document.querySelector("#selection-count").textContent === "2" &&
    document.querySelector("#selection-layer").textContent === "Markers" &&
    document.querySelector("#selection-position").textContent === "Mixed" &&
    document.querySelector("#selection-position").dataset.mixed === "true"`), true,
  "the Inspector shows common properties and clearly marks mixed values.");
  const beforeTypingShortcut = await studioDocument();
  await evaluate(`document.querySelector("#selection-delta-x").focus()`);
  await key("keyDown", "KeyA", "a", 2);
  await key("keyUp", "KeyA", "a", 2);
  assert.deepEqual(await studioDocument(), beforeTypingShortcut,
    "Ctrl+A while typing does not edit the document.");
  await evaluate(`document.querySelector("#map-canvas").focus()`);
  await clickWorld(markerCenters[1].x, markerCenters[1].y, 8);
  assert.deepEqual(JSON.parse(await canvasData("selectedIds")), [markerIds[0]],
    "Shift-click toggles an already selected object out.");
  await clickWorld(markerCenters[1].x, markerCenters[1].y, 8);

  await clickSelector('.layer-row[data-layer="walls"] [data-action="lock"]');
  await clickSelector('.layer-row[data-layer="props"] [data-action="visible"]');
  await evaluate(`document.querySelector("#map-canvas").focus()`);
  await key("keyDown", "KeyA", "a", 2);
  await key("keyUp", "KeyA", "a", 2);
  const visibleUnlocked = await evaluate(`(() => {
    const prefs = Object.fromEntries([...document.querySelectorAll(".layer-row")].map(row => [
      row.dataset.layer,
      { hidden: row.classList.contains("hidden-layer"), locked: row.classList.contains("locked") }
    ]));
    return window.__studioTest.document().objects
      .filter(object => !prefs[object.layer].hidden && !prefs[object.layer].locked)
      .map(object => object.id).sort();
  })()`);
  assert.deepEqual(JSON.parse(await canvasData("selectedIds")).sort(), visibleUnlocked,
    "Ctrl+A selects visible, unlocked objects only.");
  const marqueeObjects = (await studioDocument()).objects.map(object => genericProject.objectBounds(object));
  const marqueeBounds = {
    left: Math.min(...marqueeObjects.map(bounds => bounds.x)) - 4,
    top: Math.min(...marqueeObjects.map(bounds => bounds.y)) - 4,
    right: Math.max(...marqueeObjects.map(bounds => bounds.x + bounds.width)) + 4,
    bottom: Math.max(...marqueeObjects.map(bounds => bounds.y + bounds.height)) + 4
  };
  const viewBeforeMarquee = await studioView();
  await evaluate(`(() => {
    const rect = document.querySelector("#map-canvas").getBoundingClientRect();
    window.__studioTest.setView({
      zoom: Math.min(1, (rect.width - 8) / ${marqueeBounds.right - marqueeBounds.left},
        (rect.height - 8) / ${marqueeBounds.bottom - marqueeBounds.top}),
      cameraX: ${marqueeBounds.left - 4}, cameraY: ${marqueeBounds.top - 4}
    });
  })()`);
  await dragWorld({ x: marqueeBounds.left, y: marqueeBounds.top },
    { x: marqueeBounds.right, y: marqueeBounds.bottom });
  assert.deepEqual(JSON.parse(await canvasData("selectedIds")).sort(), visibleUnlocked,
    "the marquee excludes hidden and locked objects.");
  await evaluate(`window.__studioTest.setView(${JSON.stringify(viewBeforeMarquee)})`);
  await clickSelector('.layer-row[data-layer="props"] [data-action="visible"]');
  await clickSelector('.layer-row[data-layer="walls"] [data-action="lock"]');

  await clickSelector(`.tree-item[data-object-id="${markerIds[0]}"]`);
  await clickSelector(`.tree-item[data-object-id="${markerIds[1]}"]`, 8);
  assert.deepEqual(JSON.parse(await canvasData("selectedIds")).sort(), [...markerIds].sort(),
    "hierarchy selection remains synchronized with the map.");
  const beforeGroupMove = Object.fromEntries(markerObjects.map(object =>
    [object.id, structuredClone(object.transform)]));
  await dragWorld(markerCenters[0], { x: markerCenters[0].x + 40, y: markerCenters[0].y });
  markerObjects = (await studioDocument()).objects.filter(object => markerIds.includes(object.id));
  const groupDisplacements = markerObjects.map(object => ({
    x: object.transform.x - beforeGroupMove[object.id].x,
    y: object.transform.y - beforeGroupMove[object.id].y
  }));
  assert.deepEqual(groupDisplacements, [{ x: 32, y: 0 }, { x: 32, y: 0 }],
    "group snapping applies one shared displacement without distorting spacing.");
  assert.ok(markerObjects.every(object => object.layer === "props" && object.order >= 0),
    "group movement preserves layers and draw order.");
  const movedMarkers = structuredClone(markerObjects);
  await evaluate(`(() => {
    document.querySelector("#selection-delta-x").value = String(window.__studioTest.document().bounds.width);
    document.querySelector("#selection-delta-y").value = "0";
  })()`);
  await clickButton("#apply-selection-offset");
  assert.deepEqual((await studioDocument()).objects.filter(object => markerIds.includes(object.id)), movedMarkers,
    "an out-of-bounds group operation is rejected atomically.");
  await evaluate(`(() => {
    document.querySelector("#selection-delta-x").value = "0";
    document.querySelector("#selection-delta-y").value = "0";
    document.querySelector("#map-canvas").focus();
  })()`);
  await clickButton("#undo");
  assert.deepEqual((await studioDocument()).objects.filter(object => markerIds.includes(object.id))
    .map(object => object.transform), markerObjects.map(object => beforeGroupMove[object.id]),
  "one undo restores the entire group drag.");
  await clickButton("#redo");
  assert.deepEqual((await studioDocument()).objects.filter(object => markerIds.includes(object.id))
    .map(object => object.transform), movedMarkers.map(object => object.transform));
  await clickButton("#undo");

  await evaluate(`document.querySelector("#map-canvas").focus()`);
  await key("keyDown", "ArrowRight", "ArrowRight");
  await key("keyUp", "ArrowRight", "ArrowRight");
  const nudgedMarkers = (await studioDocument()).objects.filter(object => markerIds.includes(object.id));
  const nudgeDisplacements = nudgedMarkers.map(object => ({
    x: object.transform.x - beforeGroupMove[object.id].x,
    y: object.transform.y - beforeGroupMove[object.id].y
  }));
  assert.deepEqual(nudgeDisplacements, [{ x: 5, y: 0 }, { x: 5, y: 0 }],
    "one arrow nudge moves the group by 5 world pixels.");
  await clickButton("#undo");
  await clickButton("#redo");
  await clickButton("#undo");

  await evaluate(`document.querySelector("#map-canvas").focus()`);
  await key("keyDown", "KeyD", "d", 2);
  await key("keyUp", "KeyD", "d", 2);
  const duplicatedMarkers = (await studioDocument()).objects.filter(object =>
    !markerIds.includes(object.id) && object.assetId === "generic-marker");
  assert.equal(duplicatedMarkers.length, 2);
  assert.equal(new Set(duplicatedMarkers.map(object => object.id)).size, 2, "duplicate IDs are unique.");
  assert.deepEqual(duplicatedMarkers.map(object => object.transform.x).sort((a, b) => a - b),
    Object.values(beforeGroupMove).map(transform => transform.x + 32).sort((a, b) => a - b),
    "duplicates use one shared snapped offset.");
  const duplicateIds = duplicatedMarkers.map(object => object.id);
  await clickButton("#undo");
  assert.equal((await studioDocument()).objects.filter(object => duplicateIds.includes(object.id)).length, 0,
    "undo removes the full duplicate group.");
  await clickButton("#redo");
  assert.equal((await studioDocument()).objects.filter(object => duplicateIds.includes(object.id)).length, 2);
  await evaluate(`document.querySelector("#map-canvas").focus()`);
  await key("keyDown", "Delete", "Delete");
  await key("keyUp", "Delete", "Delete");
  assert.equal((await studioDocument()).objects.filter(object => duplicateIds.includes(object.id)).length, 0,
    "Delete removes the full selected group.");
  await clickButton("#undo");
  assert.equal((await studioDocument()).objects.filter(object => duplicateIds.includes(object.id)).length, 2);
  await clickButton("#redo");
  assert.equal((await studioDocument()).objects.filter(object => duplicateIds.includes(object.id)).length, 0,
    "delete redo removes the group.");

  await evaluate(`document.querySelector("#map-canvas").focus()`);
  const viewBeforePan = await studioView();
  await key("keyDown", "Space", " ");
  await dragWorld({ x: 500, y: 400 }, { x: 520, y: 410 });
  await key("keyUp", "Space", " ");
  const viewAfterPan = await studioView();
  assert.deepEqual(
    { x: viewAfterPan.cameraX - viewBeforePan.cameraX, y: viewAfterPan.cameraY - viewBeforePan.cameraY },
    { x: -20, y: -10 }, "Space-drag pan remains available."
  );
  await evaluate(`window.__studioTest.setView({ zoom: 1, cameraX: 0, cameraY: 0 })`);
  const beforeBulkSave = await studioDocument();
  await clickButton("#save");
  await waitFor(`document.querySelector("#save-state").textContent === "✓ Saved"`);
  await stopChild(service);
  service = startService();
  await waitForHttp(mapUrl, service, "SQLite service (bulk edit reopen)");
  await reloadPage();
  await waitFor(`window.__studioTest !== undefined && document.querySelector("#map-canvas").dataset.layerCounts !== undefined`);
  await clickButton("#open-game");
  const firstEntrySelector = `.open-entry[data-project-id="${firstEntry.projectId}"] input`;
  await waitFor(`document.querySelector(${JSON.stringify(firstEntrySelector)}) !== null`);
  await clickSelector(firstEntrySelector);
  await clickButton("#open-selected");
  await waitFor(`!document.querySelector("#open-dialog").open && window.__studioTest.document().id === ${JSON.stringify(firstGeneric.id)}`);
  const reopenedBulk = await studioDocument();
  assert.deepEqual(reopenedBulk, beforeBulkSave, "group edits save and reopen from SQLite exactly.");

  await clickSelector('.layer-row[data-layer="walls"] [data-action="lock"]');
  await clickButton("#clear-level-contents");
  for (const category of ["terrain", "walls", "props", "items", "collision", "spawns"]) {
    await clickSelector(`[data-clear-category="${category}"]`);
  }
  const clearSummary = await evaluate(`({
    summary: document.querySelector("#clear-contents-summary").textContent,
    walls: document.querySelector("#clear-count-walls").textContent,
    props: document.querySelector("#clear-count-props").textContent,
    items: document.querySelector("#clear-count-items").textContent,
    spawns: document.querySelector("#clear-count-spawns").textContent
  })`);
  assert.match(clearSummary.summary, /4 objects will be removed; 1 locked object will be skipped/);
  assert.match(clearSummary.walls, /0 affected · 1 locked skipped/);
  assert.match(clearSummary.props, /2 affected/);
  assert.match(clearSummary.items, /0 affected/);
  assert.match(clearSummary.spawns, /2 affected/);
  const beforeClear = await studioDocument();
  await clickButton("#clear-contents-confirm");
  assert.equal((await studioDocument()).objects.length, 1, "clear removes selected unlocked categories only.");
  assert.equal((await studioDocument()).objects[0].type, "wall", "locked wall content remains.");
  await clickButton("#undo");
  assert.deepEqual(await studioDocument(), beforeClear, "one undo restores all cleared categories.");
  await clickButton("#redo");
  assert.equal((await studioDocument()).objects.length, 1, "one redo reapplies the clear.");
  await clickButton("#undo");
  await clickSelector('.layer-row[data-layer="walls"] [data-action="lock"]');

  await clickButton("#clear-level-contents");
  await clickSelector('[data-clear-category="spawns"]');
  assert.match(await evaluate(`document.querySelector("#clear-contents-summary").textContent`),
    /2 objects will be removed; 0 locked objects will be skipped/);
  await clickButton("#clear-contents-confirm");
  const noSpawnDocument = await studioDocument();
  assert.equal(noSpawnDocument.objects.some(object => object.type === "spawn"), false,
    "clearing spawns does not create replacement objects.");
  const noSpawnProblems = genericProject.playStartProblems(noSpawnDocument);
  assert.ok(noSpawnProblems.length && noSpawnProblems.every(problem =>
    /add it from the palette|undo clearing spawns/i.test(problem)),
  `missing starts produce actionable validation: ${JSON.stringify(noSpawnProblems)}`);
  await clickButton("#save");
  await waitFor(`document.querySelector("#save-state").classList.contains("saved")`);
  await clickButton("#play");
  assert.equal(await evaluate(`document.querySelector("#studio").dataset.playState`), "error");
  const noSpawnPlayMessage = await evaluate(`document.querySelector("#play-error-message").textContent`);
  assert.match(noSpawnPlayMessage, /player start is missing/i);
  assert.match(noSpawnPlayMessage, /add a player start from the palette|undo clearing spawns/i);
  await clickButton("#play-error-close");
  await stopChild(service);
  service = startService();
  await waitForHttp(mapUrl, service, "SQLite service (saved draft without starts)");
  await reloadPage();
  await waitFor(`window.__studioTest !== undefined && document.querySelector("#map-canvas").dataset.layerCounts !== undefined`);
  await clickButton("#open-game");
  await waitFor(`document.querySelector(${JSON.stringify(firstEntrySelector)}) !== null`);
  await clickSelector(firstEntrySelector);
  await clickButton("#open-selected");
  await waitFor(`!document.querySelector("#open-dialog").open && window.__studioTest.document().id === ${JSON.stringify(firstGeneric.id)}`);
  assert.deepEqual(await studioDocument(), noSpawnDocument, "the spawn-free draft saves and reopens unchanged.");
  await clickButton("#play");
  assert.equal(await evaluate(`document.querySelector("#studio").dataset.playState`), "error");
  const reopenedNoSpawnPlayMessage = await evaluate(`document.querySelector("#play-error-message").textContent`);
  assert.match(reopenedNoSpawnPlayMessage, /player start is missing/i,
    "Play stays blocked after reopening a spawn-free draft.");
  await clickButton("#play-error-close");
  await evaluate(`window.__studioTest.setView({ zoom: 1, cameraX: 0, cameraY: 0 })`);
  await dragFromPalette("generic-player", 320, 224);
  await dragFromPalette("generic-player-2", 288, 224);
  savedOnCreate = await studioDocument();
  assert.deepEqual(genericProject.playStartProblems(savedOnCreate), [],
    "restoring authored player starts returns the disposable draft to Play-valid state.");
  await clickButton("#save");
  await waitFor(`document.querySelector("#save-state").textContent === "✓ Saved"`);
  multiSelectionEvidence = {
    shiftSelection: { actual: shiftedSelection, expected: [...markerIds].sort() },
    selectAllExclusions: { actual: visibleUnlocked, expected: [...visibleUnlocked] },
    groupMove: { actualDisplacements: groupDisplacements, expectedDisplacements: [{ x: 32, y: 0 }, { x: 32, y: 0 }] },
    groupNudge: { actualDisplacements: nudgeDisplacements, expectedDisplacements: [{ x: 5, y: 0 }, { x: 5, y: 0 }] },
    duplicateIds: { actual: duplicateIds, expectedCount: 2 },
    clear: { actual: clearSummary, expectedRemoved: 4, expectedLockedSkipped: 1 },
    spawnFreeDraft: {
      actualProblems: noSpawnProblems,
      actualPlayMessage: reopenedNoSpawnPlayMessage,
      expectedSaved: true,
      expectedPlayBlocked: true
    },
    saveReopen: { actualObjects: reopenedBulk.objects.length, expectedObjects: beforeBulkSave.objects.length }
  };
  savedOnCreate = await studioDocument();

  await clickButton("#new-game");
  await fillInput("#new-name", "Browser Generic Two");
  await fillInput("#new-author", "Second author");
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
  assert.deepEqual(expectedSecond.bounds, { width: 2048, height: 2048 });
  assert.deepEqual((await (await fetch(`${apiOrigin}/api/projects/${secondEntry.projectId}/maps/${secondEntry.mapId}`)).json())
    .document.bounds, { width: 2048, height: 2048 }, "the saved map keeps the fixed world size.");
  let importedAssets = [];
  let oversizedAsset = null;
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
    await evaluate(`window.__studioTest.setView({ zoom: 1, cameraX: 700, cameraY: 700 })`);
    await dragFromPalette(chosen.assetId, 1100, 1040);
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

    await selectSaved(firstEntry.projectId, firstEntry.mapId);
    await waitFor(`!document.querySelector("#open-dialog").open && window.__studioTest.document().id === ${JSON.stringify(firstEntry.mapId)}`);
    const oversizedPngPath = join(profile, "oversized-asset.png");
    await writeFile(oversizedPngPath, makeRgbaPng(641, 48));
    await clickButton("#import-assets");
    await setFileInput("#asset-import-file", oversizedPngPath);
    await waitFor(`!document.querySelector("#asset-import-preview").hidden &&
      document.querySelectorAll(".asset-preview-item").length === 1`);
    await fillInput("#asset-import-name", "Too Wide For This Map");
    await fillInput("#asset-import-author", "Disposable test");
    await fillInput("#asset-import-source", "Generated browser test PNG");
    await clickButton("#asset-import-submit");
    const catalogAfterOversizedImport = (await (await fetch(`${apiOrigin}/api/projects/${firstEntry.projectId}/assets`)).json()).assets;
    oversizedAsset = catalogAfterOversizedImport.find(asset => asset.width === 641 && asset.height === 48);
    assert.ok(oversizedAsset, "a valid image larger than the map remains imported at its original size");
    await waitFor(`document.querySelector('.asset-card[data-asset-id="${oversizedAsset.assetId}"]') !== null &&
      !document.querySelector("#asset-import-dialog").open`);
    await evaluate(`window.__studioTest.setView({ zoom: 1, cameraX: 0, cameraY: 0 })`);
    const beforeOversizedPlacement = await studioDocument();
    const oversizedPreview = await dragFromPalette(oversizedAsset.assetId, 184, 184);
    assert.match(oversizedPreview, /:invalid$/, "an image wider than the map shows an invalid placement preview");
    await waitFor(`document.querySelector('[data-testid="studio-status"]').textContent.includes("larger than this")`);
    assert.deepEqual(await studioDocument(), beforeOversizedPlacement,
      "an image larger than the map is not silently resized or added to the document");
    await selectSaved(secondEntry.projectId, secondEntry.mapId);
    await waitFor(`!document.querySelector("#open-dialog").open && window.__studioTest.document().id === ${JSON.stringify(secondEntry.mapId)}`);
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
      (entry.projectId === secondEntry.projectId ? importedAssets.map(asset => asset.assetId) :
        entry.projectId === firstEntry.projectId && oversizedAsset ? [oversizedAsset.assetId] : []).sort(),
      "reopened project palette includes only its project-scoped assets");
    const editorViewBeforePlay = entry.projectId === secondEntry.projectId && gopherZipPath
      ? { zoom: 1.65, cameraX: 123, cameraY: 87 } : null;
    if (editorViewBeforePlay) await evaluate(`window.__studioTest.setView(${JSON.stringify(editorViewBeforePlay)})`);
    await clickButton("#play");
    await waitFor(`document.querySelector("#studio").dataset.playState === "playing" && document.querySelector('[data-testid="generic-preview"]')?.dataset.position !== undefined`);
    assert.deepEqual(await evaluate(`(() => {
      const canvas = document.querySelector('[data-testid="generic-preview"]');
      return { width: Number(canvas.dataset.worldWidth), height: Number(canvas.dataset.worldHeight) };
    })()`), { width: 2048, height: 2048 }, "the public runtime receives the fixed world size.");
    const beforePlayShortcuts = await studioDocument();
    await key("keyDown", "KeyA", "a", 2);
    await key("keyUp", "KeyA", "a", 2);
    await key("keyDown", "KeyD", "d", 2);
    await key("keyUp", "KeyD", "d", 2);
    await key("keyDown", "Delete", "Delete");
    await key("keyUp", "Delete", "Delete");
    assert.deepEqual(await studioDocument(), beforePlayShortcuts,
      "editor selection and deletion shortcuts are ignored during Play.");
    if (entry.projectId === secondEntry.projectId && gopherZipPath) {
      const expectedAssets = importedAssets.map(asset => asset.assetId);
      assert.deepEqual(JSON.parse(await evaluate(`document.querySelector('[data-testid="generic-preview"]').dataset.importedAssetIds`)),
        expectedAssets.filter(assetId => expected.objects.some(object => object.assetId === assetId)),
        "Play renders the placed imported artwork from the reopened project");
      const readPlayCamera = () => evaluate(`(() => {
        const canvas = document.querySelector('[data-testid="generic-preview"]');
        const rect = canvas.getBoundingClientRect();
        const ratio = Number(canvas.dataset.pixelRatio);
        const position = JSON.parse(canvas.dataset.position);
        const cameraX = Number(canvas.dataset.cameraX);
        const cameraY = Number(canvas.dataset.cameraY);
        return { backingWidth: canvas.width, backingHeight: canvas.height, cssWidth: rect.width, cssHeight: rect.height,
          pixelRatio: ratio, worldScale: Number(canvas.dataset.worldScale), cameraX, cameraY, position,
          playerCssX: position.x - cameraX, playerCssY: position.y - cameraY,
          assetCssWidth: ${gopherMeasurements.placedWorld.width} * Number(canvas.dataset.worldScale),
          assetCssHeight: ${gopherMeasurements.placedWorld.height} * Number(canvas.dataset.worldScale) };
      })()`);
      await waitFor(`(() => { const canvas = document.querySelector('[data-testid="generic-preview"]');
        return canvas.width === Math.round(canvas.clientWidth * window.devicePixelRatio) &&
          canvas.height === Math.round(canvas.clientHeight * window.devicePixelRatio); })()`);
      let playMeasure = await readPlayCamera();
      assert.equal(playMeasure.worldScale, 1, "generic Play renders one world pixel per CSS pixel");
      assert.equal(playMeasure.assetCssWidth, 48, "the imported gopher remains 48 CSS pixels wide in Play");
      assert.equal(playMeasure.assetCssHeight, 48, "the imported gopher remains 48 CSS pixels high in Play");
      assert.ok(Math.abs(playMeasure.playerCssX - playMeasure.cssWidth / 2) <= 1 &&
        Math.abs(playMeasure.playerCssY - playMeasure.cssHeight / 2) <= 1,
      "the active player is followed at the center of the large-world viewport");
      assert.ok(playMeasure.cameraX >= 0 && playMeasure.cameraY >= 0 &&
        playMeasure.cameraX <= 2048 - playMeasure.cssWidth &&
        playMeasure.cameraY <= 2048 - playMeasure.cssHeight,
      "large-world camera stays clamped to world boundaries");
      await waitFor(`(() => { const canvas = document.querySelector('[data-testid="generic-preview"]');
        return canvas.width === Math.round(canvas.clientWidth * window.devicePixelRatio) &&
          canvas.height === Math.round(canvas.clientHeight * window.devicePixelRatio); })()`);
      playMeasure = await readPlayCamera();
      await setViewport(1200, 800);
      await waitFor(`(() => { const canvas = document.querySelector('[data-testid="generic-preview"]');
        return canvas && canvas.clientWidth !== ${playMeasure.cssWidth} &&
          canvas.width === Math.round(canvas.clientWidth * window.devicePixelRatio) &&
          Math.abs(Number(canvas.dataset.cameraX) -
            (Number(JSON.parse(canvas.dataset.position).x) - canvas.clientWidth / 2)) <= 1; })()`);
      const resizedMeasure = await readPlayCamera();
      assert.equal(resizedMeasure.worldScale, 1, "resizing preserves 1:1 world-to-CSS scale");
      assert.ok(Math.abs(resizedMeasure.playerCssX - resizedMeasure.cssWidth / 2) <= 1 &&
        Math.abs(resizedMeasure.playerCssY - resizedMeasure.cssHeight / 2) <= 1,
      "resized large-world viewport continues following the active player");
      assert.ok(resizedMeasure.cameraX >= 0 && resizedMeasure.cameraY >= 0 &&
        resizedMeasure.cameraX <= 2048 - resizedMeasure.cssWidth &&
        resizedMeasure.cameraY <= 2048 - resizedMeasure.cssHeight,
      "resized camera remains clamped to world boundaries");
      await setViewport(1600, 1000);
      await waitFor(`(() => { const canvas = document.querySelector('[data-testid="generic-preview"]');
        return canvas.clientWidth === ${playMeasure.cssWidth} &&
          canvas.width === Math.round(canvas.clientWidth * window.devicePixelRatio) &&
          Math.abs(Number(canvas.dataset.cameraX) -
            (Number(JSON.parse(canvas.dataset.position).x) - canvas.clientWidth / 2)) <= 1; })()`);
      playMeasure = await readPlayCamera();
      playCameraMeasurements.push({ largeWorld: playMeasure, resized: resizedMeasure });
    }
    const positionBefore = JSON.parse(await evaluate(`document.querySelector('[data-testid="generic-preview"]').dataset.position`));
    assert.equal(await evaluate(`document.activeElement.dataset.testid`), "generic-preview");
    await key("keyDown", "ArrowRight", "ArrowRight");
    await delay(180);
    await key("keyUp", "ArrowRight", "ArrowRight");
    await delay(60);
    const positionAfter = JSON.parse(await evaluate(`document.querySelector('[data-testid="generic-preview"]').dataset.position`));
    assert.ok(positionAfter.x > positionBefore.x, "generic player moves via the installed public runtime");
    if (entry.projectId === secondEntry.projectId && gopherZipPath) {
      const afterMove = await evaluate(`(() => {
        const canvas = document.querySelector('[data-testid="generic-preview"]');
        const position = JSON.parse(canvas.dataset.position);
        return { position, cameraX: Number(canvas.dataset.cameraX), cameraY: Number(canvas.dataset.cameraY),
          worldScale: Number(canvas.dataset.worldScale), cssWidth: canvas.clientWidth, cssHeight: canvas.clientHeight };
      })()`);
      assert.ok(afterMove.position.x > positionBefore.x && afterMove.position.x > positionAfter.x - 1);
      assert.equal(afterMove.worldScale, 1);
      assert.ok(Math.abs(afterMove.position.x - afterMove.cameraX - afterMove.cssWidth / 2) <= 1,
        "player movement advances through the world while the camera follows");
      await key("keyDown", "ArrowRight", "ArrowRight");
      await delay(9000);
      await key("keyUp", "ArrowRight", "ArrowRight");
      await delay(100);
      const atEastBoundary = await evaluate(`(() => {
        const canvas = document.querySelector('[data-testid="generic-preview"]');
        const position = JSON.parse(canvas.dataset.position);
        return { position, cameraX: Number(canvas.dataset.cameraX), maxCameraX: 2048 - canvas.clientWidth,
          cssWidth: canvas.clientWidth, worldScale: Number(canvas.dataset.worldScale) };
      })()`);
      assert.equal(atEastBoundary.position.x, 2040, "player radius remains inside the east world edge");
      assert.equal(atEastBoundary.cameraX, atEastBoundary.maxCameraX, "camera clamps at the east world boundary");
      assert.equal(atEastBoundary.worldScale, 1);
      playCameraMeasurements.push({ eastBoundary: atEastBoundary });
    }
    assert.equal(await evaluate(`document.querySelector('[data-testid="astraeum-world"]') === null`), true);
    await clickButton("#stop");
    assert.deepEqual(await studioDocument(), expected, "Stop does not persist movement");
    if (editorViewBeforePlay) assert.deepEqual(await studioView(), editorViewBeforePlay,
      "Stop restores the independent editor pan and zoom");
  }
  await selectSaved("astraeum-tower", "astraeum-tower-floor-1");
  await waitFor(`!document.querySelector("#open-dialog").open && window.__studioTest.document().id === "astraeum-tower-floor-1"`);
  assert.deepEqual(await studioDocument(), astraeumBefore.document);
  assert.deepEqual(await (await fetch(mapUrl)).json(), astraeumBefore, "New Game leaves Astraeum content, timestamps and migrations unchanged");
  assert.equal(await evaluate(`document.querySelector('.asset-card[data-asset-id="wall-damp-stone"]') !== null`), true);

  await clickButton("#new-game");
  await fillInput("#new-name", "Browser Small World");
  await fillInput("#new-author", "Disposable camera test");
  await clickButton("#new-create");
  await waitFor(`!document.querySelector("#new-dialog").open && document.querySelector("#project-name").textContent === "Browser Small World"`);
  const smallWorldEntry = (await (await fetch(`${apiOrigin}/api/projects`)).json()).maps
    .find(entry => entry.project.name === "Browser Small World");
  assert.ok(smallWorldEntry);
  const legacySmallWorld = structuredClone((await (await fetch(
    `${apiOrigin}/api/projects/${smallWorldEntry.projectId}/maps/${smallWorldEntry.mapId}`)).json()).document);
  assert.deepEqual(legacySmallWorld.bounds, { width: 2048, height: 2048 });
  legacySmallWorld.bounds = { width: 64, height: 64 };
  legacySmallWorld.objects.find(object => object.assetId === "generic-player").transform = { x: 32, y: 32 };
  legacySmallWorld.objects.find(object => object.assetId === "generic-player-2").transform = { x: 0, y: 32 };
  const legacySmallWorldSave = await fetch(`${apiOrigin}/api/projects/${smallWorldEntry.projectId}/maps/${smallWorldEntry.mapId}`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: smallWorldEntry.projectId, model: "generic-grid-v1", document: legacySmallWorld })
  });
  assert.equal(legacySmallWorldSave.status, 200, "an existing custom-size saved map remains valid.");
  await selectSaved(smallWorldEntry.projectId, smallWorldEntry.mapId);
  await waitFor(`!document.querySelector("#open-dialog").open && window.__studioTest.document().id === ${JSON.stringify(smallWorldEntry.mapId)}`);
  const smallWorld = await studioDocument();
  assert.deepEqual(smallWorld, legacySmallWorld, "opening a saved custom-size map preserves its data.");
  assert.deepEqual(smallWorld.bounds, { width: 64, height: 64 });
  const smallEntry = (await (await fetch(`${apiOrigin}/api/projects`)).json()).maps
    .find(entry => entry.mapId === smallWorld.id);
  assert.ok(smallEntry);
  const smallEditorView = { zoom: 1.4, cameraX: 19, cameraY: 23 };
  await evaluate(`window.__studioTest.setView(${JSON.stringify(smallEditorView)})`);
  await clickButton("#play");
  await waitFor(`document.querySelector("#studio").dataset.playState === "playing" &&
    document.querySelector('[data-testid="generic-preview"]')?.dataset.position !== undefined &&
    document.querySelector('[data-testid="generic-preview"]').width === Math.round(
      document.querySelector('[data-testid="generic-preview"]').clientWidth * window.devicePixelRatio)`);
  const readSmallCamera = () => evaluate(`(() => {
    const canvas = document.querySelector('[data-testid="generic-preview"]');
    const position = JSON.parse(canvas.dataset.position);
    const rect = canvas.getBoundingClientRect();
    const cameraX = Number(canvas.dataset.cameraX);
    const cameraY = Number(canvas.dataset.cameraY);
    return { worldScale: Number(canvas.dataset.worldScale), width: canvas.clientWidth, height: canvas.clientHeight,
      cameraX, cameraY, position, playerCssX: position.x - cameraX, playerCssY: position.y - cameraY,
      smoothing: canvas.getContext("2d").imageSmoothingEnabled };
  })()`);
  const smallInitial = await readSmallCamera();
  assert.deepEqual(await evaluate(`(() => {
    const canvas = document.querySelector('[data-testid="generic-preview"]');
    return { width: Number(canvas.dataset.worldWidth), height: Number(canvas.dataset.worldHeight) };
  })()`), { width: 64, height: 64 }, "the runtime preserves the saved custom-size world.");
  assert.equal(smallInitial.worldScale, 1, "small worlds stay at 1:1 scale");
  assert.ok(smallInitial.width > 64 && smallInitial.height > 64, "small map fits inside the Play viewport");
  assert.ok(Math.abs(smallInitial.cameraX - (64 - smallInitial.width) / 2) < 0.01 &&
    Math.abs(smallInitial.cameraY - (64 - smallInitial.height) / 2) < 0.01,
  "small worlds are centered in the viewport without scaling");
  assert.equal(smallInitial.smoothing, false, "Play keeps pixel-art interpolation disabled");
  await setViewport(1200, 800);
  await waitFor(`(() => {
    const canvas = document.querySelector('[data-testid="generic-preview"]');
    return canvas.clientWidth !== ${smallInitial.width} &&
      canvas.width === Math.round(canvas.clientWidth * window.devicePixelRatio) &&
      Math.abs(Number(canvas.dataset.cameraX) - (64 - canvas.clientWidth) / 2) < 0.01;
  })()`);
  const smallResized = await readSmallCamera();
  assert.equal(smallResized.worldScale, 1, "resizing a small-world viewport preserves pixel scale");
  assert.ok(Math.abs(smallResized.cameraX - (64 - smallResized.width) / 2) < 0.01 &&
    Math.abs(smallResized.cameraY - (64 - smallResized.height) / 2) < 0.01,
  "small world remains centered after resizing");
  await key("keyDown", "ArrowRight", "ArrowRight");
  await delay(240);
  await key("keyUp", "ArrowRight", "ArrowRight");
  await delay(80);
  const smallMoved = await readSmallCamera();
  assert.ok(smallMoved.position.x > smallResized.position.x, "small-world player moves in Play");
  assert.equal(smallMoved.cameraX, smallResized.cameraX, "the camera stays centered instead of following within a fully visible small world");
  assert.ok(smallMoved.position.x <= 56, "player movement remains clamped inside the small world");
  smallWorldCameraMeasurements = { initial: smallInitial, resized: smallResized, moved: smallMoved };
  await clickButton("#stop");
  assert.deepEqual(await studioView(), smallEditorView, "Stop restores small-world editor pan and zoom");
  await setViewport(1600, 1000);
  await selectSaved("astraeum-tower", "astraeum-tower-floor-1");
  await waitFor(`!document.querySelector("#open-dialog").open && window.__studioTest.document().id === "astraeum-tower-floor-1"`);
  assert.deepEqual(await (await fetch(mapUrl)).json(), astraeumBefore, "the Play camera checks do not alter Astraeum");

  assert.deepEqual(browserExceptions, [], "the Studio browser workflow reports no uncaught exceptions.");
  if (gopherMeasurements) console.log(`Imported gopher dimensions: ${JSON.stringify(gopherMeasurements)}`);
  if (playCameraMeasurements.length) console.log(`Generic Play camera: ${JSON.stringify(playCameraMeasurements)}`);
  if (smallWorldCameraMeasurements) console.log(`Small-world Play camera: ${JSON.stringify(smallWorldCameraMeasurements)}`);
  if (multiSelectionEvidence) console.log(`Multi-selection actual-vs-expected evidence: ${JSON.stringify(multiSelectionEvidence)}`);
  console.log(`Directional Halberd visual captures (separate from combat assertions): ${JSON.stringify(directionalAttackEvidence)}`);
  console.log(`Studio workflow passed: migrated format 1 (${legacy.walls} walls, 1 collision box, backup kept); ` +
    `New Game created two generic projects via browser controls, validated inputs, rejected duplicates, cancelled safely, ` +
    `saved distinct maps, reopened after restart, moved in Play/Stop and returned to unchanged Astraeum; ` +
    `Open Game switched isolated projects, protected unsaved edits including failed saves, reopened after restart, ` +
    `played the selected map and required explicit untyped-model confirmation; ` +
    `generic Play kept small worlds centered at 1:1 scale through resize; ` +
    (gopherZipPath ? `large-world camera followed the player and clamped at the east edge; ` : "") +
    `unresolved collision labelled, assigned wall artwork / kept / deleted with undo; ` +
    `dragged a wall and a barrel from the palette; moved the wall off-grid without moving the floor; ` +
    `barrel stayed above the wall; snap, 5 px nudge, undo/redo, floor lock; saved and reopened; ` +
    `Shift/marquee/Ctrl+A selection, group movement/nudging, duplicate/delete IDs, undo/redo, locked-aware category clear, ` +
    `save/reopen and spawn-free Play validation passed; ` +
    `Play button ran the edited map and Aries stopped at x=${beforeRelease} against the wall at ` +
    `x=${nudged.transform.x}; Stop restored the view; the Floor 1 slime chased, dealt contact damage, and died to the Halberd; ` +
    `Space, left-click, and right-trigger attacks plus directional dodge were exercised in all control modes; ` +
    `simulated standard-gamepad movement/aim, analog magnitude, neutral-stick, held input, disconnect and blur passed; ` +
    `keyboard/mouse movement-only, dodge stamina/cooldown and UI-focus checks passed; ` +
    `Halberd thrust/sweep visuals appeared facing north/east/south/west; ` +
    `unplayable map showed an actionable error; ` +
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
