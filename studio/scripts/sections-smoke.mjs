import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { backup, DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import * as generic from "../../games/generic-grid-v1/src/project.js";
import { isTerrainBrushAsset } from "../world-terrain.js";
import { createFloorDocument } from "../../games/astraeum-tower/src/project.js";
import { ASTRAEUM_PROJECT_ID, ASTRAEUM_FLOOR_1_MAP_ID, ASTRAEUM_MODEL } from "../project-identity.js";
import { connectedFixture } from "./connected-play-fixtures.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const dataRoot = resolve(root, "studio", "data");
await mkdir(dataRoot, { recursive: true });
const evidenceDir = await mkdtemp(resolve(dataRoot, "sections-smoke-"));
const database = resolve(evidenceDir, "studio.sqlite");
const games = resolve(evidenceDir, "games");
const children = [];
const diagnostics = { evidenceDir, phases: [], errors: [], network: [], screenshots: [] };
let socket;
let sessionId;
let nextId = 0;
let chromeProfile;
let copiedMapKeys;
const pending = new Map();
const actionsOnly = process.argv.includes("--tools-only") || process.argv.includes("--reproduce-actions");
const playOnly = process.argv.includes("--play-only");
const sectionsOnly = process.argv.includes("--sections-only");
const boundaryOnly = process.argv.includes("--boundary-only");
const applyOnly = process.argv.includes("--apply-only");
const paintOnly = process.argv.includes("--paint-only");
const levelsOnly = process.argv.includes("--levels-only");
const sectionAddOnly = process.argv.includes("--section-add-only");
const connectedPlayOnly = process.argv.includes("--connected-play-only");
if (connectedPlayOnly) {
  diagnostics.unverified = ["connected authored-start loading", "bidirectional seam movement",
    "continuous floor and camera", "collision on both sides and exterior", "connected Play/Stop view and selection"];
}

async function copySavedStorage() {
  const sourcePath = resolve(root, "studio", "data", "studio.sqlite");
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    await backup(source, database);
  } finally {
    source.close();
  }
  const copy = new DatabaseSync(database, { readOnly: true });
  try {
    const projects = copy.prepare("SELECT project_id FROM projects").all();
    for (const { project_id: projectId } of projects) {
      assert.match(projectId, /^[a-z0-9][a-z0-9._:-]{0,127}$/);
      assert.ok(!projectId.includes(":") && projectId !== "." && projectId !== "..");
      const destination = resolve(games, projectId);
      await mkdir(destination, { recursive: true });
      for (const name of ["assets", "project.json"]) {
        const from = resolve(root, "games", projectId, name);
        let stat;
        try { stat = await lstat(from); } catch (error) {
          if (error.code === "ENOENT") continue;
          throw error;
        }
        assert.ok(!stat.isSymbolicLink(), "never follow project-storage links into external data");
        await cp(from, resolve(destination, name), {
          recursive: stat.isDirectory(), errorOnExist: true, force: false,
          filter: async path => {
            assert.ok(!(await lstat(path)).isSymbolicLink(), "never follow nested asset links");
            return true;
          }
        });
      }
    }
    const rows = copy.prepare(`SELECT s.project_id, s.level_map_id, s.grid_x, s.grid_y,
      m.document_json, m.updated_at FROM level_sections s JOIN maps m
      ON m.project_id = s.project_id AND m.map_id = s.map_id ORDER BY m.updated_at DESC`).all();
    const pair = rows.flatMap(left => rows.filter(right =>
      right.project_id === left.project_id && right.level_map_id === left.level_map_id &&
      Math.abs(left.grid_x - right.grid_x) + Math.abs(left.grid_y - right.grid_y) === 1
    ).map(right => [left, right])).find(items => items.every(item => {
      const design = JSON.parse(item.document_json);
      return design.bounds.width === 2048 && design.bounds.height === 2048 &&
        design.objects.some(object => object.type === "terrain-tile");
    }));
    assert.ok(pair, "the disposable copy contains an existing adjacent, authored-floor section pair");
    diagnostics.storageCopy = {
      sourceReadOnly: true, sqliteOnlineBackup: true, assetsCopied: true,
      selectedProject: pair[0].project_id, selectedLevel: pair[0].level_map_id,
      sections: rows.filter(row => row.project_id === pair[0].project_id &&
        row.level_map_id === pair[0].level_map_id).map(row => {
        const design = JSON.parse(row.document_json);
        return { gridX: row.grid_x, gridY: row.grid_y, bounds: design.bounds,
          terrain: design.objects.filter(object => object.type === "terrain-tile").length,
          starts: design.objects.filter(object => object.type === "spawn").map(object => ({
            assetId: object.assetId, transform: object.transform
          })) };
      }),
      savedMapsDigest: savedMapsDigest(copy)
    };
    copiedMapKeys = new Set(copy.prepare("SELECT project_id, map_id FROM maps").all()
      .map(row => JSON.stringify([row.project_id, row.map_id])));
  } finally {
    copy.close();
  }
}

function savedMapsDigest(database) {
  const rows = database.prepare("SELECT * FROM maps ORDER BY project_id, map_id").all()
    .filter(row => !copiedMapKeys || copiedMapKeys.has(JSON.stringify([row.project_id, row.map_id])));
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

async function controls(name) {
  const snapshot = await evaluate(`(() => ({
    status: document.querySelector("#status")?.textContent,
    playState: document.querySelector("#studio")?.dataset.playState,
    playError: document.querySelector("#play-error-message")?.textContent,
    toolHint: document.querySelector("#tool-hint")?.textContent,
    controls: [...document.querySelectorAll(".toolbar button, .toolbar select, #layer-list button, #tool-settings button, #section-placement button")]
      .map(e => ({id:e.id, label:e.textContent, value:e.value, disabled:e.disabled,
        inert:!!e.closest("[inert]"), hidden:!e.getClientRects().length, title:e.title})),
    events: window.repairEvents ?? [],
    images: (window.repairImages ?? []).map(image => ({src:image.src, complete:image.complete,
      width:image.naturalWidth, height:image.naturalHeight})),
    resources: performance.getEntriesByType("resource").map(e => ({name:e.name, duration:e.duration}))
  }))()`);
  diagnostics.phases.push({ name, ...snapshot });
  await screenshot(name);
}

async function port() {
  const listener = createServer();
  await new Promise((ok, fail) => listener.once("error", fail).listen(0, "127.0.0.1", ok));
  const value = listener.address().port;
  await new Promise((ok, fail) => listener.close(error => error ? fail(error) : ok()));
  return value;
}

function launch(file, args, env = {}) {
  const child = spawn(file, args, { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  child.launch = { file, args, cwd: root, shell: false };
  child.output = "";
  child.stdout.on("data", chunk => { child.output += chunk; });
  child.stderr.on("data", chunk => { child.output += chunk; });
  children.push(child);
  return child;
}

async function ready(address, child, allowSuccessfulExit = false) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null && !(allowSuccessfulExit && child.exitCode === 0 && child.signalCode === null)) {
      throw new Error(`Process exited: ${child.output}`);
    }
    try { const response = await fetch(address); if (response.ok) return response; } catch {}
    await delay(100);
  }
  throw new Error(`Not responsive: ${address}\n${child.output}`);
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error("Owned process did not stop.")), 5000);
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
  const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "Browser evaluation failed.");
  return result.result.value;
}

async function waitFor(expression, attempts = 500) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (diagnostics.errors.length) throw new Error(diagnostics.errors[0]);
    if (await evaluate(expression)) return;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${expression}; status: ${await evaluate('document.querySelector("#status")?.textContent')}`);
}

async function mouse(type, x, y, buttons = type === "mouseReleased" ? 0 : 1) {
  await cdp("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons, clickCount: 1 });
}

async function click(selector) {
  if (await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)});
    return e?.closest("#level-menu") && e.tagName !== "SUMMARY" && !document.querySelector("#level-menu").open; })()`)) {
    await click("#level-menu > summary");
  }
  await waitFor(`(() => { const e = document.querySelector(${JSON.stringify(selector)});
    return e && !e.disabled && e.getClientRects().length; })()`);
  const point = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)});
    e.scrollIntoView(); const r = e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  await mouse("mousePressed", point.x, point.y);
  await mouse("mouseReleased", point.x, point.y);
}

async function key(key, code, modifiers = 0) {
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key, code, modifiers });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers });
}

async function chooseTool(value) {
  const index = ["select", "paint", "fill", "boundary"].indexOf(value);
  assert.ok(index >= 0);
  await click("#editor-tool");
  for (const [key, number] of [["Home", 36], ...Array.from({ length: index }, () => ["ArrowDown", 40]), ["Enter", 13]]) {
    for (const type of ["keyDown", "keyUp"]) {
      await cdp("Input.dispatchKeyEvent", { type, key, code: key, windowsVirtualKeyCode: number });
    }
  }
  await waitFor(`document.querySelector("#map-canvas").dataset.tool === ${JSON.stringify(value)}`);
}

async function verifyPlay(testId) {
  const before = await evaluate("window.__studioTest.sections()");
  const view = await evaluate("window.__studioTest.view()");
  const selection = await evaluate("window.__studioTest.selection()");
  await click("#play");
  await waitFor('["playing","error"].includes(document.querySelector("#studio").dataset.playState)');
  await controls(`${testId}-play-result`);
  assert.equal(await evaluate('document.querySelector("#studio").dataset.playState'), "playing",
    await evaluate('document.querySelector("#play-error-message").textContent'));
  const positionExpression = testId === "generic-preview"
    ? `JSON.parse(document.querySelector('[data-testid="${testId}"]').dataset.position)`
    : `(() => { const d = document.querySelector('[data-testid="${testId}"]').dataset;
      return { x:Number(d.x), y:Number(d.y) }; })()`;
  await waitFor(`document.querySelector('[data-testid="${testId}"]')?.dataset.${testId === "generic-preview" ? "position" : "y"}`);
  const position = await evaluate(positionExpression);
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 });
  await delay(300);
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 });
  const moved = await evaluate(positionExpression);
  assert.ok(moved.y > position.y, "single-section Play accepts movement");
  await click("#stop");
  await waitFor('document.querySelector("#studio").dataset.playState === "idle"');
  assert.deepEqual(await evaluate("window.__studioTest.sections()"), before);
  assert.deepEqual(await evaluate("window.__studioTest.view()"), view);
  assert.deepEqual(await evaluate("window.__studioTest.selection()"), selection);
}

async function openLevel(projectId, mapId) {
  await openProject(projectId);
  await evaluate(`(() => { const select = document.querySelector("#level-select");
    select.value = ${JSON.stringify(mapId)}; select.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await waitFor(`window.__studioTest.identity().mapId === ${JSON.stringify(mapId)} &&
    !document.querySelector("#level-select").disabled`);
}

async function seedConnectedLevel(projectId, parentMapId, model) {
  const levels = `${api}/api/projects/${projectId}/levels`;
  const added = await fetch(levels, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "add", mapId: parentMapId, name: "Disposable connected acceptance" }) });
  const level = await added.json();
  assert.equal(added.status, 200, level.error);
  const address = `${levels}/${level.mapId}/sections`;
  const baseline = await (await fetch(address)).json();
  const expanded = await fetch(address, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ gridX: 1, gridY: 0, revision: baseline.revision }) });
  const current = await expanded.json();
  assert.equal(expanded.status, 201, current.error);
  const fixture = connectedFixture(model);
  const sections = current.sections.map(section => {
    const design = structuredClone(fixture[section.gridX].document);
    design.id = section.mapId;
    return { sectionId: section.sectionId, revision: section.revision, document: design };
  });
  const saved = await fetch(address, { method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ operationId: randomUUID(), revision: current.revision, sections }) });
  assert.equal(saved.status, 200, await saved.text());
  return { projectId, mapId: level.mapId, model, address };
}

async function verifyConnectedPlay(fixture) {
  await openLevel(fixture.projectId, fixture.mapId);
  await chooseTool("select");
  await evaluate("window.__studioTest.setView({cameraX:1700,cameraY:800,zoom:0.75})");
  const authored = await evaluate("window.__studioTest.worldToClient(2000,1040)");
  await mouse("mousePressed", authored.x, authored.y);
  await mouse("mouseReleased", authored.x, authored.y);
  const before = await evaluate("window.__studioTest.sections()");
  const view = await evaluate("window.__studioTest.view()");
  const selection = await evaluate("window.__studioTest.selection()");
  assert.ok(selection.ids.includes("authored-primary"), "acceptance starts with an actual selected object");
  const saved = await (await fetch(fixture.address)).json();
  assert.equal(await evaluate('document.querySelector("#play").disabled'), false);
  await click("#play");
  await waitFor('["playing","error"].includes(document.querySelector("#studio").dataset.playState)');
  assert.equal(await evaluate('document.querySelector("#studio").dataset.playState'), "playing",
    await evaluate('document.querySelector("#play-error-message").textContent'));
  const selector = '[data-testid="connected-preview"]';
  const position = `JSON.parse(document.querySelector('${selector}').dataset.position)`;
  await waitFor(`document.querySelector('${selector}')?.dataset.position`);
  assert.deepEqual(await evaluate(position), { x: 2000, y: 1040 }, "authored position, not a default start");
  assert.equal(await evaluate(`document.querySelector('${selector}').dataset.sectionCount`), "2");
  const camera = await evaluate(`Number(document.querySelector('${selector}').dataset.cameraX)`);
  const heldUntil = async (code, condition, attempts = 500) => {
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: code, code });
    try { await waitFor(condition, attempts); } finally {
      await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: code, code });
    }
  };
  await heldUntil("ArrowRight", `${position}.x >= 2080`);
  const east = await evaluate(position);
  const cameraEast = await evaluate(`Number(document.querySelector('${selector}').dataset.cameraX)`);
  assert.ok(Math.abs((cameraEast - camera) - (east.x - 2000)) <= 8,
    "camera follows continuously across the seam");
  await heldUntil("ArrowRight", `${position}.x >= 2160`);
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowRight", code: "ArrowRight" });
  await delay(350);
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowRight", code: "ArrowRight" });
  assert.ok((await evaluate(position)).x <= 2172.01, "collision on the adjacent side");
  const floor = await evaluate(`(() => {
    const canvas = document.querySelector('${selector}'), d = canvas.dataset;
    const context = canvas.getContext("2d");
    const pixel = (x,y) => [...context.getImageData(
      Math.round((x-Number(d.cameraX))*Number(d.cameraZoom)*canvas.width/canvas.clientWidth),
      Math.round((y-Number(d.cameraY))*Number(d.cameraZoom)*canvas.height/canvas.clientHeight),1,1).data];
    return [pixel(2032,1008), pixel(2064,1008)];
  })()`);
  assert.deepEqual(floor[0], floor[1], "repeating authored floor matches at both sides of the seam");
  assert.equal(floor[0][3], 255);
  await screenshot(`connected-${fixture.model}-east`);
  await heldUntil("ArrowLeft", `${position}.x <= 2000`);
  await heldUntil("ArrowLeft", `${position}.x <= 1932`);
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowLeft", code: "ArrowLeft" });
  await delay(350);
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowLeft", code: "ArrowLeft" });
  assert.ok((await evaluate(position)).x >= 1924 - 0.01, "collision on the original side after returning");
  await heldUntil("ArrowUp", `${position}.y <= 1000`);
  await heldUntil("ArrowRight", `${position}.x >= 4080`, 1000);
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowRight", code: "ArrowRight" });
  await delay(350);
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowRight", code: "ArrowRight" });
  assert.ok((await evaluate(position)).x <= 4092.01, "outer boundary stays enforced");
  await controls(`connected-${fixture.model}-outer`);
  await click("#stop");
  await waitFor('document.querySelector("#studio").dataset.playState === "idle"');
  assert.deepEqual(await evaluate("window.__studioTest.sections()"), before);
  assert.deepEqual(await evaluate("window.__studioTest.view()"), view);
  assert.deepEqual(await evaluate("window.__studioTest.selection()"), selection);
  assert.deepEqual(await (await fetch(fixture.address)).json(), saved);
  diagnostics.phases.push(`connected ${fixture.model}: authored start, both seam directions, floor, camera, both collisions, exterior, Stop selection/view and unchanged saved designs passed`);
}

async function openProject(projectId) {
  await click("#open-game");
  await click(`.open-entry[data-project-id="${projectId}"] input`);
  await click("#open-selected");
  await waitFor(`window.__studioTest.identity().projectId === ${JSON.stringify(projectId)} &&
    !document.querySelector("#open-dialog").open`);
}

async function boundaryDrag() {
  const start = await evaluate("window.__studioTest.worldToClient(976,976)");
  const end = await evaluate("window.__studioTest.worldToClient(1072,1072)");
  await mouse("mousePressed", start.x, start.y);
  await mouse("mouseMoved", end.x, end.y, 1);
  await mouse("mouseReleased", end.x, end.y);
  await waitFor('document.querySelector("#boundary-apply") && !document.querySelector("#boundary-apply").disabled');
}

async function screenshot(name) {
  const result = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const path = resolve(evidenceDir, `${name}.png`);
  await writeFile(path, Buffer.from(result.data, "base64"));
  diagnostics.screenshots.push(path);
}

const apiPort = await port();
const webPort = await port();
const debugPort = await port();
const api = `http://127.0.0.1:${apiPort}`;
const webUrl = `http://127.0.0.1:${webPort}`;
let service;
let web;
let failure;

try {
  if (connectedPlayOnly) await copySavedStorage();
  service = launch(process.execPath, ["--no-warnings", resolve(root, "studio", "server.mjs")], {
    STUDIO_API_PORT: String(apiPort), STUDIO_DATABASE_PATH: relative(root, database),
    STUDIO_GAMES_PATH: relative(root, games)
  });
  await ready(`${api}/api/projects`, service);
  const towerFixture = createFloorDocument();
  towerFixture.objects = towerFixture.objects.filter(object => object.type !== "terrain-tile" ||
    ![[256, 256], [288, 288]].some(([x, y]) => object.transform.x === x && object.transform.y === y));
  const towerSave = !connectedPlayOnly && await fetch(`${api}/api/projects/${ASTRAEUM_PROJECT_ID}/maps/${ASTRAEUM_FLOOR_1_MAP_ID}`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: ASTRAEUM_PROJECT_ID, model: ASTRAEUM_MODEL, document: towerFixture })
  });
  if (!connectedPlayOnly) assert.equal(towerSave.status, 200);
  const create = async name => {
    const response = await fetch(`${api}/api/projects`, { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, author: "Disposable section test", model: generic.MODEL, ...generic.DEFAULT_DIMENSIONS }) });
    const result = await response.json();
    assert.equal(response.status, 201, result.error);
    return result;
  };
  const first = await create("Section Editing");
  const second = await create("Isolated Stage");
  if (paintOnly || levelsOnly) {
    const address = `${api}/api/projects/${first.projectId}/levels/${first.mapId}/sections`;
    const baseline = await (await fetch(address)).json();
    const added = await fetch(address, { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gridX: 1, gridY: 0, revision: baseline.revision }) });
    assert.equal(added.status, 201, "seed an adjacent disposable section without exercising section UI");
  }
  const siblingResponse = await fetch(`${api}/api/projects/${first.projectId}/levels`, { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "add", mapId: first.mapId, name: "Untouched sibling" }) });
  const sibling = await siblingResponse.json();
  assert.equal(siblingResponse.status, 200, sibling.error);
  const siblingUrl = `${api}/api/projects/${first.projectId}/maps/${sibling.mapId}`;
  const siblingBaselineResponse = await fetch(siblingUrl);
  assert.equal(siblingBaselineResponse.status, 200);
  const baselineSibling = await siblingBaselineResponse.json();
  const terrainAsset = Object.entries(generic.ASSET_CATALOG).find(([, asset]) => isTerrainBrushAsset(asset))?.[0];
  assert.ok(terrainAsset);
  const baselineSecond = structuredClone(second.document);
  diagnostics.fixtures = { first: first.mapId, firstProject: first.projectId, second: second.mapId,
    secondProject: second.projectId, sibling: sibling.mapId, terrainAsset };
  if (connectedPlayOnly) {
    diagnostics.connectedFixtures = [];
    for (const [projectId, parentMapId, model] of [
      [first.projectId, first.mapId, generic.MODEL],
      [ASTRAEUM_PROJECT_ID, ASTRAEUM_FLOOR_1_MAP_ID, ASTRAEUM_MODEL]
    ]) diagnostics.connectedFixtures.push(await seedConnectedLevel(projectId, parentMapId, model));
    const response = await fetch(`${api}/api/projects/${ASTRAEUM_PROJECT_ID}/levels`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "add", mapId: ASTRAEUM_FLOOR_1_MAP_ID, name: "Disposable single-section Play" })
    });
    const level = await response.json();
    assert.equal(response.status, 200, level.error);
    const document = createFloorDocument();
    document.id = level.mapId;
    const saved = await fetch(`${api}/api/projects/${ASTRAEUM_PROJECT_ID}/maps/${level.mapId}`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: ASTRAEUM_PROJECT_ID, model: ASTRAEUM_MODEL, document })
    });
    assert.equal(saved.status, 200, await saved.text());
    diagnostics.singleTowerFixture = { projectId: ASTRAEUM_PROJECT_ID, mapId: level.mapId };
  }

  web = launch(process.execPath,
    [process.env.STUDIO_VITE_BIN ?? resolve(root, "games", "sample", "node_modules", "vite", "bin", "vite.js"),
      "--config", "studio/vite.config.js", "--port", String(webPort), "--strictPort"],
    { STUDIO_API_PORT: String(apiPort) });
  await ready(webUrl, web);
  chromeProfile = await mkdtemp(resolve(tmpdir(), "studio-sections-chrome-"));
  const chrome = launch(process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", [
    "--headless=new", "--disable-gpu", `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${chromeProfile}`, "--window-size=1600,1000", "about:blank"
  ]);
  const version = await (await ready(`http://127.0.0.1:${debugPort}/json/version`, chrome, true)).json();
  socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((ok, failOpen) => {
    socket.addEventListener("open", ok, { once: true });
    socket.addEventListener("error", failOpen, { once: true });
  });
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === "Runtime.exceptionThrown") {
      diagnostics.errors.push(message.params.exceptionDetails.exception?.description ?? "Uncaught browser exception");
    }
    if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
      diagnostics.errors.push(message.params.args.map(item => item.value ?? item.description ?? "").join(" "));
    }
    if (message.method === "Network.responseReceived" && message.params.response.url.includes("/api/")) {
      diagnostics.network.push({ url: message.params.response.url, status: message.params.response.status });
    }
    if (message.method === "Network.loadingFailed") diagnostics.network.push(message.params);
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    clearTimeout(call.timer);
    if (message.error) call.fail(new Error(message.error.message)); else call.ok(message.result);
  });
  const target = await cdp("Target.createTarget", { url: "about:blank" }, true);
  sessionId = (await cdp("Target.attachToTarget", { targetId: target.targetId, flatten: true }, true)).sessionId;
  await cdp("Runtime.enable");
  await cdp("Page.enable");
  await cdp("Network.enable");
  await cdp("Page.addScriptToEvaluateOnNewDocument", { source: `
    window.repairImages = [];
    const NativeImage = window.Image;
    window.Image = class extends NativeImage {
      constructor(...args) { super(...args); window.repairImages.push(this); }
    };
  ` });
  await cdp("Page.bringToFront");
  await cdp("Page.navigate", { url: webUrl });
  await waitFor('window.__studioTest && window.__studioTest.document() && !document.querySelector("#open-game").disabled');

  await evaluate(`window.repairEvents = [];
      for (const type of ["click", "pointerdown", "pointerup", "change"])
        document.addEventListener(type, e => window.repairEvents.push({
          type, id:e.target.id, value:e.target.value, trusted:e.isTrusted
        }), true);`);
  if (connectedPlayOnly) {
    for (const fixture of diagnostics.connectedFixtures) await verifyConnectedPlay(fixture);
    await openProject(first.projectId);
    await verifyPlay("generic-preview");
    await openLevel(diagnostics.singleTowerFixture.projectId, diagnostics.singleTowerFixture.mapId);
    await verifyPlay("astraeum-world");
    diagnostics.unverified = [];
  } else if (sectionAddOnly) {
    for (const [projectId, sourceId, markerAsset] of [
      [ASTRAEUM_PROJECT_ID, ASTRAEUM_FLOOR_1_MAP_ID, "prop-barrel"],
      [first.projectId, first.mapId, "generic-marker"]
    ]) {
      await openProject(projectId);
      assert.equal(await evaluate('document.querySelector("#level-menu").open'), false);
      assert.equal(await evaluate('document.querySelector("#section-select").nextElementSibling.id'), "section-add");
      const source = await evaluate("window.__studioTest.sections()");
      const view = await evaluate("window.__studioTest.view()");
      const address = `${api}/api/projects/${projectId}/levels/${sourceId}/sections`;
      const saved = await (await fetch(address)).json();
      await click("#section-add");
      assert.equal(await evaluate('document.querySelector("#section-confirm").disabled'), true);
      await click('[data-direction="east"]');
      assert.equal(await evaluate('document.querySelector(\'[data-direction="east"]\').getAttribute("aria-pressed")'), "true");
      assert.deepEqual(await evaluate("window.__studioTest.sections()"), source);
      assert.deepEqual(await (await fetch(address)).json(), saved, "side selection creates nothing");
      await click("#section-cancel");
      assert.deepEqual(await (await fetch(address)).json(), saved, "Cancel creates nothing");
      await click("#section-add");
      assert.equal(await evaluate('document.querySelector("#section-confirm").disabled'), true);
      await click('[data-direction="east"]');
      await click("#section-confirm");
      await waitFor('window.__studioTest.sections().length === 2 && !document.querySelector("#section-add").disabled');
      const expanded = await evaluate("window.__studioTest.sections()");
      assert.deepEqual(expanded[0], source[0]);
      assert.deepEqual(expanded[1].document.objects, []);
      assert.deepEqual([expanded[1].gridX, expanded[1].gridY], [1, 0]);
      assert.deepEqual(await evaluate("window.__studioTest.view()"), view);
      await click("#section-add");
      assert.equal(await evaluate('document.querySelector(\'[data-direction="east"]\').disabled'), true);
      await click("#section-cancel");
      await click("#section-select");
      for (const [key, number] of [["End", 35], ["Enter", 13]]) {
        for (const type of ["keyDown", "keyUp"]) {
          await cdp("Input.dispatchKeyEvent", { type, key, code: key, windowsVirtualKeyCode: number });
        }
      }
      await waitFor(`document.querySelector("#section-select").value === ${JSON.stringify(expanded[1].sectionId)}`);
      await evaluate("window.__studioTest.setView({cameraX:2048,cameraY:0,zoom:1})");
      await click(`.asset-card[data-asset-id="${markerAsset}"]`);
      const point = await evaluate("window.__studioTest.worldToClient(2176,128)");
      await mouse("mousePressed", point.x, point.y);
      await mouse("mouseReleased", point.x, point.y);
      await chooseTool("select");
      const dirty = await evaluate("window.__studioTest.sections()");
      assert.equal(dirty[1].document.objects.length, 1);
      await click("#section-add");
      assert.equal(await evaluate('document.querySelector(\'[data-direction="west"]\').disabled'), true);
      await click('[data-direction="north"]');
      assert.match(await evaluate('document.querySelector("#section-placement-preview").textContent'), /\(1, -1\)/);
      await click("#section-cancel");
      assert.deepEqual(await evaluate("window.__studioTest.sections()"), dirty);
      await click("#section-add");
      await click('[data-direction="north"]');
      await click("#section-confirm");
      await waitFor('window.__studioTest.sections().length === 3 && !document.querySelector("#section-add").disabled');
      const final = await evaluate("window.__studioTest.sections()");
      assert.deepEqual(final.slice(0, 2), dirty, "creation preserves every existing saved and unsaved section");
      assert.deepEqual([final[2].gridX, final[2].gridY], [1, -1]);
      assert.deepEqual(final[2].document.objects, []);
      await controls(`direct-section-add-${projectId}`);
      await click("#save");
      await waitFor('document.querySelector("#save-state").classList.contains("saved")');
      const reopened = await (await fetch(address)).json();
      for (const section of final) {
        assert.deepEqual(reopened.sections.find(s => s.sectionId === section.sectionId).document, section.document);
      }
    }
    assert.deepEqual((await (await fetch(`${api}/api/projects/${second.projectId}/maps/${second.mapId}`)).json()).document,
      baselineSecond);
    assert.deepEqual(await (await fetch(siblingUrl)).json(), baselineSibling);
    diagnostics.phases.push("Direct Add Section, selected anchor, disabled occupied sides, Cancel, Confirm, empty creation and unsaved preservation passed in both models");
  } else if (levelsOnly) {
    const snapshots = [];
    const selectLevel = async mapId => {
      await waitFor(`!document.querySelector("#level-select").disabled &&
        [...document.querySelector("#level-select").options].some(option => option.value === ${JSON.stringify(mapId)})`);
      const index = await evaluate(`[...document.querySelector("#level-select").options]
        .findIndex(option => option.value === ${JSON.stringify(mapId)})`);
      await click("#level-select");
      for (const [key, number] of [["Home", 36], ...Array.from({ length: index }, () => ["ArrowDown", 40]), ["Enter", 13]]) {
        for (const type of ["keyDown", "keyUp"]) {
          await cdp("Input.dispatchKeyEvent", { type, key, code: key, windowsVirtualKeyCode: number });
        }
      }
    };
    const opened = mapId => waitFor(`window.__studioTest.identity().mapId === ${JSON.stringify(mapId)} &&
      !document.querySelector("#open-dialog").open && !document.querySelector("#level-select").disabled`);
    const fillName = async name => {
      await click("#level-name");
      await key("a", "KeyA", 2);
      await cdp("Input.insertText", { text: name });
    };
    for (const [projectId, sourceId, model, markerAsset] of [
      [ASTRAEUM_PROJECT_ID, ASTRAEUM_FLOOR_1_MAP_ID, ASTRAEUM_MODEL, "prop-barrel"],
      [first.projectId, first.mapId, generic.MODEL, "generic-marker"]
    ]) {
      await openProject(projectId);
      const sourceSections = await evaluate("window.__studioTest.sections()");
      const levelAddress = `${api}/api/projects/${projectId}/levels`;
      const sourceAddress = `${levelAddress}/${sourceId}/sections`;
      const sourcePayload = await (await fetch(sourceAddress)).json();
      const levelMetadata = await (await fetch(levelAddress)).json();
      await click("#section-add");
      assert.equal(await evaluate('document.querySelector("#section-placement").hidden'), false,
        "Add Section below the section dropdown opens the existing directional flow");
      assert.deepEqual(await evaluate("window.__studioTest.sections()"), sourceSections);
      await click("#section-cancel");
      await click("#level-add");
      assert.equal(await evaluate('document.querySelector("#level-title").textContent'), "Add Level");
      await click("#level-cancel");
      assert.deepEqual(await evaluate("window.__studioTest.sections()"), sourceSections);
      await click("#level-add");
      await fillName(`Empty ${model}`);
      await click("#level-submit");
      await waitFor(`!document.querySelector("#level-dialog").open &&
        window.__studioTest.identity().mapId !== ${JSON.stringify(sourceId)} && !document.querySelector("#level-select").disabled`);
      const empty = await evaluate("window.__studioTest.sections()");
      const newId = await evaluate("window.__studioTest.identity().mapId");
      assert.equal(empty.length, 1);
      assert.deepEqual(empty[0].document.objects, []);
      assert.deepEqual(empty[0].document.bounds, { width: 2048, height: 2048 });
      assert.deepEqual([empty[0].gridX, empty[0].gridY], [0, 0]);
      assert.equal((await (await fetch(levelAddress)).json()).startingMapId, levelMetadata.startingMapId);
      assert.deepEqual(await (await fetch(sourceAddress)).json(), sourcePayload);
      await selectLevel(sourceId);
      await opened(sourceId);
      assert.deepEqual(await evaluate("window.__studioTest.sections()"), sourceSections);
      await selectLevel(newId);
      await opened(newId);
      assert.deepEqual(await evaluate("window.__studioTest.sections()"), empty);
      await evaluate("window.__studioTest.setView({cameraX:0,cameraY:0,zoom:1})");
      await click(`.asset-card[data-asset-id="${markerAsset}"]`);
      const point = await evaluate("window.__studioTest.worldToClient(128,128)");
      await mouse("mousePressed", point.x, point.y);
      await mouse("mouseReleased", point.x, point.y);
      await chooseTool("select");
      const unsaved = await evaluate("window.__studioTest.sections()");
      assert.equal(unsaved[0].document.objects.length, 1);
      await click("#level-add");
      assert.equal(await evaluate('document.querySelector("#level-unsaved").hidden'), false);
      await click("#level-cancel");
      assert.deepEqual(await evaluate("window.__studioTest.sections()"), unsaved,
        "cancel Add Level preserves the current unsaved design");
      await selectLevel(sourceId);
      await waitFor('!document.querySelector("#open-confirm").hidden');
      await click("#switch-cancel");
      await click("#open-cancel");
      assert.deepEqual(await evaluate("window.__studioTest.sections()"), unsaved);
      await selectLevel(sourceId);
      await click("#switch-save");
      await opened(sourceId);
      assert.deepEqual(await evaluate("window.__studioTest.sections()"), sourceSections);
      await selectLevel(newId);
      await opened(newId);
      assert.deepEqual(await evaluate("window.__studioTest.sections()"), unsaved);
      await controls(`level-created-${model}`);
      snapshots.push({ projectId, sourceId, newId, sourcePayload,
        saved: unsaved, startingMapId: levelMetadata.startingMapId });
      diagnostics.phases.push({ name: `level-lifecycle-${model}`, newId, emptySectionCount: empty.length,
        emptyObjectCount: empty[0].document.objects.length, cancelAndSaveSwitch: "passed" });
    }
    await stop(service);
    service = launch(process.execPath, ["--no-warnings", resolve(root, "studio", "server.mjs")], {
      STUDIO_API_PORT: String(apiPort), STUDIO_DATABASE_PATH: relative(root, database),
      STUDIO_GAMES_PATH: relative(root, games)
    });
    await ready(`${api}/api/projects`, service);
    for (const saved of snapshots) {
      await openProject(saved.projectId);
      await selectLevel(saved.newId);
      await opened(saved.newId);
      assert.deepEqual(await evaluate("window.__studioTest.sections()"), saved.saved,
        "UI reopen after service restart preserves the exact new-level design");
      const levels = `${api}/api/projects/${saved.projectId}/levels`;
      assert.equal((await (await fetch(levels)).json()).startingMapId, saved.startingMapId);
      assert.deepEqual(await (await fetch(`${levels}/${saved.sourceId}/sections`)).json(), saved.sourcePayload,
        "existing source contents and section membership remain unchanged");
    }
    assert.deepEqual((await (await fetch(`${api}/api/projects/${second.projectId}/maps/${second.mapId}`)).json()).document,
      baselineSecond, "other project remains unchanged");
    assert.deepEqual(await (await fetch(siblingUrl)).json(), baselineSibling, "existing sibling level remains unchanged");
    diagnostics.phases.push("Level-menu creation, switching, save/restart/reopen, starting metadata and isolation passed in both models");
  } else if (paintOnly) {
    await openProject(first.projectId);
    await evaluate("window.__studioTest.setView({cameraX:1536,cameraY:0,zoom:1})");
    await chooseTool("paint");
    assert.equal(await evaluate('document.querySelector("#paint-asset-name").textContent'),
      "Choose a Paint asset from the palette");
    await click(`.asset-card[data-asset-id="${terrainAsset}"]`);
    assert.equal(await evaluate('document.querySelector("#paint-asset-name").textContent'),
      generic.ASSET_CATALOG[terrainAsset].label);
    assert.equal(await evaluate('document.querySelector("#paint-asset-thumbnail").hidden'), false);
    const before = await evaluate("window.__studioTest.sections()");
    const point = async (x, y) => evaluate(`window.__studioTest.worldToClient(${x},${y})`);
    const stroke = async () => {
      const start = await point(2017, 337), end = await point(2081, 337);
      await mouse("mousePressed", start.x, start.y);
      await mouse("mouseMoved", end.x, end.y, 1);
      await mouse("mouseReleased", end.x, end.y);
    };
    const hover = await point(2017, 337);
    await mouse("mouseMoved", hover.x, hover.y, 0);
    assert.match(await evaluate('JSON.parse(document.querySelector("#map-canvas").dataset.paintFootprint).problem'), /locked/);
    await stroke();
    assert.deepEqual(await evaluate("window.__studioTest.sections()"), before);
    assert.match(await evaluate('document.querySelector("#status").textContent'), /locked/);
    await click('.layer-row[data-layer="terrain"] button[data-action="lock"]');
    const sizes = [1, 2, 4, 8];
    for (const [index, size] of sizes.entries()) {
      await click("#paint-brush-size");
      for (const [key, number] of [["Home", 36], ...Array.from({ length: index }, () => ["ArrowDown", 40]), ["Enter", 13]]) {
        for (const type of ["keyDown", "keyUp"]) {
          await cdp("Input.dispatchKeyEvent", { type, key, code: key, windowsVirtualKeyCode: number });
        }
      }
      await waitFor(`document.querySelector("#paint-brush-size").value === "${size}"`);
      await mouse("mouseMoved", hover.x, hover.y, 0);
      const footprint = await evaluate('JSON.parse(document.querySelector("#map-canvas").dataset.paintFootprint)');
      assert.equal(footprint.width, size * 32);
      assert.equal(footprint.height, size * 32);
      assert.equal(footprint.problem, null);
      assert.deepEqual(await evaluate("window.__studioTest.sections()"), before, "hover does not paint");
      await screenshot(`paint-${size}-cursor`);
      await stroke();
      const after = await evaluate("window.__studioTest.sections()");
      const painted = after.map(section => section.document.objects.filter(object => object.type === "terrain-tile"));
      assert.equal(painted.flat().length, (size + 2) * size);
      assert.ok(painted.every(objects => objects.length > 0), "the sized stroke paints both sections");
      await click("#undo");
      assert.deepEqual(await evaluate("window.__studioTest.sections()"), before, "one native Undo restores the entire stroke");
      await click("#redo");
      assert.deepEqual(await evaluate("window.__studioTest.sections()"), after);
      await click("#undo");
      diagnostics.phases.push({ name: `paint-${size}-cross-section`, footprint,
        paintedPerSection: painted.map(objects => objects.length), undoRedo: "passed" });
    }
    await click('.layer-row[data-layer="terrain"] button[data-action="visible"]');
    await stroke();
    assert.deepEqual(await evaluate("window.__studioTest.sections()"), before);
    assert.match(await evaluate('document.querySelector("#status").textContent'), /hidden/);
    await click('.layer-row[data-layer="terrain"] button[data-action="visible"]');
    await click('.asset-card[data-asset-id="generic-marker"]');
    assert.equal(await evaluate('document.querySelector("#paint-asset-name").textContent'), "Marker");
    assert.equal(await evaluate('document.querySelector("#paint-brush-size").disabled'), true);
    assert.match(await evaluate('document.querySelector("#paint-support").textContent'), /not terrain/);
    await controls("paint-unsupported-asset");
    assert.equal(await evaluate("window.repairEvents.filter(e => ['pointerdown','pointerup','change'].includes(e.type)).every(e => e.trusted)"),
      true, "Paint controls and canvas use native editor input");
    diagnostics.phases.push("Paint-only native asset selection, all sizes, cursor screenshots, locks and one-stroke Undo passed");
  } else if (applyOnly) {
    await openProject(first.projectId);
    await evaluate("window.__studioTest.setView({cameraX:0,cameraY:0,zoom:1})");
    const before = await evaluate("window.__studioTest.sections()");
    const drag = async (x1, y1, x2, y2) => {
      const start = await evaluate(`window.__studioTest.worldToClient(${x1},${y1})`);
      const end = await evaluate(`window.__studioTest.worldToClient(${x2},${y2})`);
      await mouse("mousePressed", start.x, start.y);
      await mouse("mouseMoved", end.x, end.y, 1);
      await mouse("mouseReleased", end.x, end.y);
    };
    const pixel = (x, y) => evaluate(`(() => {
      const canvas = document.querySelector("#map-canvas");
      const rect = canvas.getBoundingClientRect();
      const point = window.__studioTest.worldToClient(${x},${y});
      return [...canvas.getContext("2d").getImageData(
        Math.floor((point.x-rect.left)*canvas.width/rect.width),
        Math.floor((point.y-rect.top)*canvas.height/rect.height),1,1).data];
    })()`);
    const activate = async (selector, code) => {
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
      const key = code === "Space" ? " " : "Enter";
      for (const type of ["keyDown", "keyUp"]) {
        await cdp("Input.dispatchKeyEvent", { type, key, code,
          windowsVirtualKeyCode: code === "Space" ? 32 : 13 });
      }
    };
    const plainPixel = await pixel(64, 96);
    await chooseTool("boundary");
    await drag(64, 64, 160, 160);
    assert.deepEqual(await evaluate("window.__studioTest.sections()"), before);
    await activate("#boundary-cancel", "Space");
    assert.deepEqual(await evaluate("window.__studioTest.sections()"), before);
    await drag(64, 64, 160, 160);
    await activate("#boundary-apply", "Enter");
    await waitFor('document.querySelector("#editor-tool").value === "select"');
    assert.equal(await evaluate('document.querySelector("#tool-settings").hidden'), true);
    assert.equal(await evaluate('document.querySelector("#save-state").classList.contains("dirty")'), true);
    const boundaryApplied = await evaluate("window.__studioTest.sections()");
    const outlinePixel = await pixel(64, 96);
    assert.notDeepEqual(outlinePixel, plainPixel, "applied outline remains rendered in Select");
    await controls("apply-boundary-select-outline");
    await click("#undo");
    assert.deepEqual(await evaluate("window.__studioTest.sections()"), before);
    assert.deepEqual(await pixel(64, 96), plainPixel);
    await click("#redo");
    assert.deepEqual(await evaluate("window.__studioTest.sections()"), boundaryApplied);
    assert.deepEqual(await pixel(64, 96), outlinePixel);
    await click("#undo");

    const fillSnapshot = () => evaluate(`JSON.parse(document.querySelector("#fill-diagnostic-report").value
      .split("\\n").find(line => line.startsWith("current ")).slice(8))`);
    await chooseTool("fill");
    assert.equal(await evaluate('document.querySelector("#fill-asset-name").textContent'),
      "Choose a fill asset from the palette");
    assert.equal((await fillSnapshot()).asset, null, "entering Fill never selects a default asset");
    assert.equal(await evaluate('document.querySelector("#fill-asset-thumbnail").hidden'), true);
    await drag(256, 256, 320, 320);
    assert.equal((await fillSnapshot()).preview.exists, false, "missing asset rejects before preview creation");
    assert.equal(await evaluate('document.querySelector("#status").textContent'),
      "Choose a fill asset from the palette");
    await click("#fill-cancel");
    assert.equal(await evaluate('document.querySelector("#editor-tool").value'), "select");
    assert.deepEqual(await evaluate("window.__studioTest.sections()"), before);

    await chooseTool("paint");
    await click(`.asset-card[data-asset-id="${terrainAsset}"]`);
    await chooseTool("fill");
    assert.equal((await fillSnapshot()).asset, terrainAsset,
      "switching from Paint to Fill preserves the eligible palette selection");
    assert.equal(await evaluate('document.querySelector("#fill-asset-name").textContent'),
      generic.ASSET_CATALOG[terrainAsset].label);
    await controls("fill-preserved-palette-selection");
    await click('.asset-card[data-asset-id="generic-marker"]');
    assert.equal((await fillSnapshot()).asset, "generic-marker", "actual palette pointer input updates Fill state");
    assert.equal(await evaluate('document.querySelector("#editor-tool").value'), "fill");
    assert.equal(await evaluate('document.querySelector("#fill-asset-name").textContent'),
      generic.ASSET_CATALOG["generic-marker"].label);
    assert.equal(await evaluate('document.querySelector("#fill-asset-thumbnail").dataset.assetId'), "generic-marker");
    assert.equal(await evaluate(`(() => {
      const thumb = document.querySelector("#fill-asset-thumbnail canvas");
      return !thumb.parentElement.hidden && thumb.getContext("2d").getImageData(0,0,48,48).data
        .some((value, index) => index % 4 === 3 && value > 0);
    })()`), true, "selected asset thumbnail contains rendered artwork");
    assert.deepEqual(await evaluate("window.__studioTest.sections()"), before, "palette clicks never place a Fill object");
    await drag(256, 256, 320, 320);
    const selectedFill = await fillSnapshot();
    assert.equal(selectedFill.gestureAsset, selectedFill.asset,
      "the real Fill pointer handler consumes the exact asset selected by the palette");
    assert.equal(selectedFill.gestureAsset, "generic-marker");
    assert.equal(selectedFill.preview.count, 4);
    assert.equal(selectedFill.applyEnabled, true);
    await controls("fill-palette-click-pointer-preview");
    assert.deepEqual(await evaluate("window.__studioTest.sections()"), before);
    await activate("#fill-cancel", "Enter");
    assert.deepEqual(await evaluate("window.__studioTest.sections()"), before);
    await chooseTool("fill");
    await drag(256, 256, 320, 320);
    await activate("#fill-apply", "Space");
    await waitFor('document.querySelector("#fill-apply").disabled && !document.querySelector("#undo").disabled');
    const filled = await evaluate("window.__studioTest.sections()");
    assert.equal(filled[0].document.objects.length, before[0].document.objects.length + 4);
    assert.deepEqual(await pixel(272, 272), [207, 156, 66, 255],
      "actual marker artwork replaces the translucent preview");
    await controls("apply-fill-actual-objects");
    await click("#undo");
    assert.deepEqual(await evaluate("window.__studioTest.sections()"), before);
    assert.notDeepEqual(await pixel(272, 272), [207, 156, 66, 255]);
    await click("#redo");
    assert.deepEqual(await evaluate("window.__studioTest.sections()"), filled);
    assert.deepEqual(await pixel(272, 272), [207, 156, 66, 255]);
    const historyBeforeCancel = await fillSnapshot();
    await drag(384, 256, 448, 320);
    await click("#fill-cancel");
    assert.deepEqual(await evaluate("window.__studioTest.sections()"), filled,
      "Cancel preserves existing unsaved edits");
    assert.equal(await evaluate('document.querySelector("#save-state").classList.contains("dirty")'), true);
    await chooseTool("fill");
    const historyAfterCancel = await fillSnapshot();
    assert.equal(historyAfterCancel.asset, "generic-marker", "Cancel does not discard the palette selection");
    assert.equal(historyAfterCancel.undo, historyBeforeCancel.undo);
    assert.equal(historyAfterCancel.redo, historyBeforeCancel.redo);
    await click("#undo");

    await evaluate("window.__studioTest.setView({cameraX:1900,cameraY:0,zoom:1})");
    await drag(1952, 256, 2112, 320);
    assert.match(await evaluate('document.querySelector("#tool-hint").textContent'), /missing or unloaded/);
    assert.deepEqual(await evaluate("window.__studioTest.sections()"), before);
    await controls("apply-fill-validation-rejected");
    await click("#fill-cancel");
    assert.deepEqual(await evaluate("window.__studioTest.sections()"), before);
    diagnostics.phases.push("main-editor Boundary/Fill native Apply/Cancel, pixels and one-step Undo/Redo passed");
  } else if (boundaryOnly) {
    await openProject(first.projectId);
    await evaluate("window.__studioTest.setView({cameraX:0,cameraY:0,zoom:0.4})");
    const before = await evaluate("window.__studioTest.sections()");
    await chooseTool("boundary");
    await boundaryDrag();
    assert.deepEqual(await evaluate("window.__studioTest.sections()"), before,
      "boundary preview does not edit the document");
    await key("Escape", "Escape");
    assert.deepEqual(await evaluate("window.__studioTest.sections()"), before,
      "Escape cancels the boundary draft");
    assert.equal(await evaluate('document.querySelector("#boundary-apply").disabled'), true);

    await boundaryDrag();
    await controls("boundary-grid-preview");
    await click("#boundary-apply");
    const applied = await evaluate("window.__studioTest.sections()");
    const boundary = applied[0].document.playableBoundary;
    assert.equal(boundary.version, 1);
    assert.equal(boundary.type, "grid");
    assert.deepEqual(boundary.sections.map(({ gridX, gridY }) => ({ gridX, gridY })),
      [{ gridX: 0, gridY: 0 }]);
    assert.deepEqual(await evaluate("window.__studioTest.boundary()"), boundary);
    await click("#undo");
    assert.equal(Object.hasOwn((await evaluate("window.__studioTest.sections()"))[0].document,
      "playableBoundary"), false);
    await click("#redo");
    assert.deepEqual(await evaluate("window.__studioTest.sections()"), applied,
      "one Redo restores the applied boundary");
    await click("#save");
    await waitFor('document.querySelector("#save-state").classList.contains("saved")');
    await click("#play");
    await waitFor('document.querySelector("#studio").dataset.playState === "playing"');
    const positionExpression = `JSON.parse(document.querySelector('[data-testid="generic-preview"]').dataset.position)`;
    const initial = await evaluate(positionExpression);
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
    await delay(800);
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
    const blocked = await evaluate(positionExpression);
    assert.ok(blocked.x > initial.x && blocked.x <= 1080.01,
      `single-section Play is blocked at the custom boundary (got ${blocked.x})`);
    await click("#stop");
    await waitFor('document.querySelector("#studio").dataset.playState === "idle"');
    assert.deepEqual(await evaluate("window.__studioTest.sections()"), applied,
      "Play movement does not change the saved design");
    diagnostics.phases.push("boundary preview/cancel/apply/Undo/Redo/save and single-section authoritative Play passed");
  } else if (actionsOnly) {
    await evaluate("window.__studioTest.setView({cameraX:0,cameraY:128,zoom:1})");
    await controls("tower-initial-controls");
    await chooseTool("paint");
    assert.match(await evaluate('document.querySelector("#tool-hint").textContent'), /Choose an asset/);
    await click('.asset-card[data-asset-id="floor-cobblestone"]');
    assert.equal(await evaluate('document.querySelector("#editor-tool").value'), "paint");
    const point = await evaluate("window.__studioTest.worldToClient(256,256)");
    const before = await evaluate("window.__studioTest.sections()");
    await mouse("mousePressed", point.x, point.y);
    await mouse("mouseReleased", point.x, point.y);
    assert.deepEqual(await evaluate("window.__studioTest.sections()"), before);
    assert.match(await evaluate('document.querySelector("#status").textContent'), /locked/);
    await controls("tower-paint-locked");
    await click('.layer-row[data-layer="terrain"] button[data-action="lock"]');
    await mouse("mousePressed", point.x, point.y);
    await mouse("mouseReleased", point.x, point.y);
    assert.equal((await evaluate("window.__studioTest.document().objects.length")), towerFixture.objects.length + 1);
    assert.deepEqual(await evaluate("window.__studioTest.document().bounds"), towerFixture.bounds);
    await controls("tower-paint-unlocked");
    await click("#undo");
    assert.deepEqual(await evaluate("window.__studioTest.sections()"), before);
    await chooseTool("fill");
    await click('.asset-card[data-asset-id="floor-cobblestone"]');
    assert.equal(await evaluate('document.querySelector("#editor-tool").value'), "fill", "palette selection preserves Fill");
    await mouse("mousePressed", point.x, point.y);
    await mouse("mouseMoved", point.x + 32, point.y + 32, 1);
    await mouse("mouseReleased", point.x + 32, point.y + 32);
    assert.deepEqual(await evaluate("window.__studioTest.sections()"), before, "fill preview does not edit");
    assert.equal(await evaluate('document.querySelector("#play").disabled'), true);
    await controls("tower-fill-preview");
    await click("#fill-apply");
    assert.equal(await evaluate("window.__studioTest.document().objects.length"), towerFixture.objects.length + 2);
    await controls("tower-fill-apply");
    await click("#undo");
    assert.deepEqual(await evaluate("window.__studioTest.sections()"), before);
    await mouse("mousePressed", point.x, point.y);
    await mouse("mouseReleased", point.x + 32, point.y + 32);
    await click("#fill-cancel");
    assert.deepEqual(await evaluate("window.__studioTest.sections()"), before);
    diagnostics.phases.push("focused main-editor tools checks passed");
  } else if (playOnly) {
    await verifyPlay("astraeum-world");
    await openProject(first.projectId);
    await verifyPlay("generic-preview");
    diagnostics.phases.push("single-section Play movement/Stop passed in both models");
  } else {
  await openProject(first.projectId);
  assert.equal((await evaluate("window.__studioTest.sections().length")), 1);
  assert.deepEqual(await evaluate("window.__studioTest.document()"), first.document,
    "opening an existing level preserves its complete document");
  assert.equal(await evaluate('document.querySelectorAll("#world-workspace, #world-dialog").length'), 0,
    "sections use the main editor without a separate Worlds chooser or editor");
  const originalCanvas = await evaluate('document.querySelector("#map-canvas") === document.querySelector("canvas")');
  assert.equal(originalCanvas, true);
  const originalView = await evaluate("window.__studioTest.view()");
  await click("#section-add");
  await click('#section-placement [data-direction="east"]');
  await click("#section-confirm");
  await waitFor("window.__studioTest.sections().length === 2");
  assert.deepEqual(await evaluate("window.__studioTest.view()"), originalView, "adding a section preserves pan and zoom");
  assert.deepEqual((await evaluate("window.__studioTest.sections()"))[0].document, first.document,
    "adding a section preserves the existing section document");
  assert.deepEqual((await evaluate("window.__studioTest.sections()"))[1].document.objects, []);
  await click("#section-add");
  assert.equal(await evaluate('document.querySelector(\'#section-placement [data-direction="east"]\').disabled'), true);
  await controls("occupied-placement-preview");
  await click("#section-cancel");
  diagnostics.phases.push("existing level opened; adjacent section added without changing view");

  if (!sectionsOnly) {
  await evaluate("window.__studioTest.setView({cameraX:0,cameraY:0,zoom:0.4})");
  const canvas = await evaluate(`(() => { const r=document.querySelector("#map-canvas").getBoundingClientRect();
    return {x:r.left,y:r.top}; })()`);
  const client = (x, y) => ({ x: canvas.x + (x * 0.4), y: canvas.y + (y * 0.4) });
  await click('.asset-card[data-asset-id="generic-marker"]');
  const markerPoint = client(2176, 192);
  await mouse("mousePressed", markerPoint.x, markerPoint.y);
  await mouse("mouseReleased", markerPoint.x, markerPoint.y);
  const placedSections = await evaluate("window.__studioTest.sections()");
  const marker = placedSections[1].document.objects.find(object => object.assetId === "generic-marker");
  assert.ok(marker, "palette placement targets the adjacent section in the main editor");
  assert.deepEqual(marker.transform, { x: 128, y: 192 });
  await chooseTool("select");
  await mouse("mousePressed", markerPoint.x + 4, markerPoint.y + 4);
  await mouse("mouseReleased", markerPoint.x + 4, markerPoint.y + 4);
  assert.equal(await evaluate('document.querySelector("#object-id").value'), marker.id,
    "main Inspector displays the selected section-local object");
  assert.equal(await evaluate('document.querySelector(".tree-item.selected")?.dataset.objectId'), marker.id,
    "existing hierarchy follows canvas selection");
  assert.deepEqual(await evaluate("window.__studioTest.sections()"), placedSections,
    "selection does not mutate section documents");
  diagnostics.phases.push("main-editor palette placement, canvas selection, hierarchy and Inspector passed");

  await click(`.asset-card[data-asset-id="${terrainAsset}"]`);
  await chooseTool("paint");
  await click('.layer-row[data-layer="terrain"] button[data-action="lock"]');
  const beforeBrush = await evaluate("window.__studioTest.sections()");
  const start = client(2016, 320), end = client(2080, 320);
  await mouse("mousePressed", start.x, start.y);
  await mouse("mouseMoved", end.x, end.y, 1);
  await mouse("mouseReleased", end.x, end.y);
  const afterBrush = await evaluate("window.__studioTest.sections()");
  const addedTerrain = afterBrush.map(section =>
    section.document.objects.filter(object => object.type === "terrain-tile").length -
    beforeBrush.find(item => item.sectionId === section.sectionId).document.objects.filter(object => object.type === "terrain-tile").length);
  assert.deepEqual(addedTerrain, [1, 2], "continuous brush places terrain on both sides of the seam");
  await key("z", "KeyZ", 2);
  assert.deepEqual(await evaluate("window.__studioTest.sections()"), beforeBrush, "one Undo restores both sides of the seam");
  await key("y", "KeyY", 2);
  assert.deepEqual(await evaluate("window.__studioTest.sections()"), afterBrush, "one Redo restores both sides of the seam");
  diagnostics.phases.push("cross-seam terrain brush and atomic Undo/Redo passed");
  await screenshot("brush-seam");

  await chooseTool("fill");
  const fillStart = client(2016, 512), fillEnd = client(2080, 544);
  await mouse("mousePressed", fillStart.x, fillStart.y);
  await mouse("mouseMoved", fillEnd.x, fillEnd.y, 1);
  await mouse("mouseReleased", fillEnd.x, fillEnd.y);
  await waitFor('document.querySelector("#fill-apply") && !document.querySelector("#fill-apply").disabled');
  await click("#fill-apply");
  const afterFill = await evaluate("window.__studioTest.sections()");
  assert.ok(afterFill[0].document.objects.some(object => object.type === "terrain-tile" &&
    object.transform.y >= 512 && object.transform.y <= 544));
  assert.ok(afterFill[1].document.objects.some(object => object.type === "terrain-tile" &&
    object.transform.y >= 512 && object.transform.y <= 544));
  diagnostics.phases.push("rectangle fill applied across the seam");
  await click("#save");
  await waitFor('document.querySelector("#save-state").classList.contains("saved")');
  diagnostics.phases.push("transactional level save completed");

  await openProject(second.projectId);
  assert.deepEqual(await evaluate("window.__studioTest.document()"), baselineSecond, "other project remains unchanged");
  assert.equal(await evaluate('document.querySelector("#play").disabled'), false, "single-section Play remains enabled");
  await verifyPlay("generic-preview");
  diagnostics.phases.push("project isolation and single-section Play/Stop passed");

  await openProject(first.projectId);
  const reopened = await evaluate("window.__studioTest.sections()");
  assert.deepEqual(reopened, afterFill, "saved section designs reopen exactly");
  }
  assert.equal(await evaluate('document.querySelector("#play").disabled'), false,
    "multi-section movement Play is available through the public connected runtime");
  assert.match(await evaluate('document.querySelector("#play").title'), /all sections/);
  assert.equal(await evaluate('document.querySelector("#play-limitation").hidden'), false);
  diagnostics.phases.push("section transaction reopened; connected movement-only Play scope is explained");
  const siblingAfterResponse = await fetch(siblingUrl);
  assert.equal(siblingAfterResponse.status, 200);
  assert.deepEqual(await siblingAfterResponse.json(), baselineSibling, "other levels remain unchanged");
  diagnostics.phases.push("same-project sibling level remains unchanged");
  assert.deepEqual(diagnostics.errors, []);
  }
  assert.deepEqual(diagnostics.errors, []);
} catch (error) {
  failure = error;
  diagnostics.failure = error.stack ?? error.message;
  if (socket?.readyState === WebSocket.OPEN) {
    try { await controls("stopping-controls"); } catch (captureError) {
      diagnostics.captureFailure = captureError.message;
    }
    try { await screenshot("failure"); } catch (screenshotError) {
      diagnostics.screenshotFailure = screenshotError.message;
    }
  }
} finally {
  diagnostics.chromeProfile = chromeProfile;
  if (socket?.readyState === WebSocket.OPEN) {
    try { await cdp("Browser.close", {}, true); } catch (error) { diagnostics.browserClose = error.message; }
  }
  socket?.close();
  for (const child of [...children].reverse()) await stop(child).catch(error => {
    diagnostics.stopFailure = error.message;
  });
  if (copiedMapKeys) {
    const copy = new DatabaseSync(database, { readOnly: true });
    try {
      diagnostics.storageCopy.savedMapsUnchanged =
        savedMapsDigest(copy) === diagnostics.storageCopy.savedMapsDigest;
      if (!diagnostics.storageCopy.savedMapsUnchanged) {
        const error = new Error("Copied saved maps changed during connected-Play verification.");
        failure ??= error;
        diagnostics.preservationFailure = error.message;
      }
    } finally {
      copy.close();
    }
  }
  diagnostics.processes = children.map(child => ({ pid: child.pid, exitCode: child.exitCode,
    signalCode: child.signalCode, launch: child.launch, output: child.output }));
  await Promise.all(children.map((child, index) => writeFile(resolve(evidenceDir, `process-${index}.log`), child.output)));
  await writeFile(resolve(evidenceDir, "diagnostics.json"), JSON.stringify(diagnostics, null, 2));
}

if (failure) {
  console.error(`Section editor CDP flow failed once. Evidence retained: ${evidenceDir}`);
  throw failure;
}
console.log(`Section editor CDP flow passed. Evidence retained: ${evidenceDir}`);
