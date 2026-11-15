import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { worldToSection, sectionToWorld, sectionOrigin } from "../world-coordinates.js";
import * as generic from "../../games/generic-grid-v1/src/project.js";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const dataRoot = resolve(root, "studio", "data");
await mkdir(dataRoot, { recursive: true });
const directory = await mkdtemp(resolve(dataRoot, "world-workspace-"));
const database = resolve(directory, "world.sqlite");
const reuseArgument = process.argv.indexOf("--reuse-data");
const pendingOnly = process.argv.includes("--pending-ui-only");
const terrainOnly = process.argv.includes("--terrain-only");
const reusedDirectory = reuseArgument >= 0
  ? resolve(dataRoot, process.argv[reuseArgument + 1] ?? "") : null;
if (pendingOnly && !reusedDirectory) throw new Error("--pending-ui-only requires --reuse-data.");
if (terrainOnly && (pendingOnly || reusedDirectory)) throw new Error("--terrain-only requires fresh disposable data.");
if (reusedDirectory) {
  const relativeSource = relative(dataRoot, reusedDirectory);
  if (!relativeSource || relativeSource.startsWith("..")) throw new Error("Reuse data must be a retained directory under studio/data.");
  for (const name of await readdir(reusedDirectory)) {
    if (name.startsWith("world.sqlite")) {
      await writeFile(resolve(directory, name), await readFile(resolve(reusedDirectory, name)));
    }
  }
  await cp(resolve(reusedDirectory, "games"), resolve(directory, "games"), { recursive: true });
}
const children = [];
const exceptions = [];
const browserErrors = [];
const network = [];
const networkRequests = new Map();
const evidence = [];
let failure;
let socket;
let sessionId;
let nextId = 0;
const pending = new Map();

async function port() {
  const server = createServer();
  await new Promise((ok, fail) => server.once("error", fail).listen(0, "127.0.0.1", ok));
  const value = server.address().port;
  await new Promise((ok, fail) => server.close(error => error ? fail(error) : ok()));
  return value;
}
const apiPort = await port();
const webPort = await port();
const debugPort = await port();
const api = `http://127.0.0.1:${apiPort}`;
const webUrl = `http://127.0.0.1:${webPort}`;
function launch(file, args, env = {}) {
  const child = spawn(file, args, { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  child.output = "";
  child.stdout.on("data", data => { child.output += data; });
  child.stderr.on("data", data => { child.output += data; });
  children.push(child);
  return child;
}
function service() {
  return launch(process.execPath, ["--no-warnings", resolve(root, "studio", "server.mjs")], {
    STUDIO_API_PORT: String(apiPort), STUDIO_DATABASE_PATH: relative(root, database),
    STUDIO_GAMES_PATH: relative(root, resolve(directory, "games"))
  });
}
async function ready(address, child, allowSuccessfulExit = false) {
  for (let i = 0; i < 150; i++) {
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
async function request(path, method = "GET", body) {
  const response = await fetch(api + path, { method, ...(body ? {
    headers: { "content-type": "application/json" }, body: JSON.stringify(body)
  } : {}) });
  return { status: response.status, body: await response.json() };
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
async function waitFor(expression) {
  for (let i = 0; i < 500; i++) {
    assert.deepEqual(exceptions, []);
    if (await evaluate(expression)) return;
    await delay(25);
  }
  const status = await evaluate(`document.querySelector("#world-status")?.textContent ||
    document.querySelector("#world-dialog-status")?.textContent || document.querySelector("#status")?.textContent`);
  throw new Error(`UI timed out: ${expression}; ${status}`);
}
async function mouse(type, x, y, button = "left") {
  await cdp("Input.dispatchMouseEvent", {
    type, x, y, button, buttons: type === "mouseReleased" ? 0 : button === "middle" ? 4 : 1, clickCount: 1
  });
}
async function click(selector) {
  await waitFor(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); return e && !e.disabled && e.getClientRects().length; })()`);
  const p = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView(); const r = e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  await mouse("mousePressed", p.x, p.y);
  await mouse("mouseReleased", p.x, p.y);
}

try {
  if (!pendingOnly && !terrainOnly) {
    for (const x of [-2049, -2048, -1, 0, 2047, 2048]) {
      const coordinate = worldToSection(x, x);
      assert.equal(coordinate.gridX, Math.floor(x / 2048));
      assert.equal(coordinate.x, x - Math.floor(x / 2048) * 2048);
      assert.deepEqual(sectionToWorld(coordinate.gridX, coordinate.gridY, coordinate.x, coordinate.y), { x, y: x });
    }
    assert.throws(() => sectionOrigin(Number.MAX_SAFE_INTEGER, 0), RangeError);
  }
  let server = service();
  await ready(`${api}/api/projects`, server);
  let projectId;
  let mapId;
  let initialLevel;
  let original;
  let address;
  let saved;
  if (terrainOnly) {
    const created = await request("/api/projects", "POST", {
      name: "Terrain fixture", author: "Disposable brush verification", width: 2048, height: 2048, model: generic.MODEL
    });
    assert.equal(created.status, 201);
    ({ projectId, mapId } = created.body);
    initialLevel = (await request(`/api/projects/${projectId}/maps/${mapId}`)).body.document;
    const creation = await request(`/api/projects/${projectId}/worlds`, "POST", {
      name: "Terrain seam", sourceMapId: mapId,
      positions: [{ gridX: -1, gridY: 0 }, { gridX: 0, gridY: 0 }]
    });
    assert.equal(creation.status, 201);
    const fixture = creation.body;
    fixture.sections[0].document.objects.push(
      generic.createDesignObject("existing-tile", "generic-tile", { x: 2016, y: 320 }, 37),
      generic.createDesignObject("terrain-brush-1", "generic-marker", { x: 2016, y: 320 }, 7));
    fixture.sections[1].document.objects.push(
      generic.createDesignObject("existing-tile", "generic-tile", { x: 0, y: 320 }, 37),
      generic.createDesignObject("unrelated-block", "generic-block", { x: 0, y: 320 }, 7));
    const seeded = await request(`/api/projects/${projectId}/worlds/${fixture.worldId}`, "PUT", {
      operationId: "seed-terrain", revision: fixture.revision,
      sections: fixture.sections.map(item => ({
        sectionId: item.sectionId, revision: item.revision, document: item.document
      }))
    });
    assert.equal(seeded.status, 200);
    original = seeded.body;
    saved = seeded;
    evidence.push({ terrainBaseline: original, independentLevel: initialLevel });
  } else if (reusedDirectory) {
    const db = new DatabaseSync(database, { readOnly: true });
    const fixture = db.prepare(`SELECT p.project_id AS projectId, pl.starting_map_id AS mapId, w.world_id AS worldId
      FROM projects p JOIN project_levels pl ON pl.project_id = p.project_id
      JOIN worlds w ON w.project_id = p.project_id`).get();
    assert.ok(fixture, "retained database contains the world fixture");
    ({ projectId, mapId } = fixture);
    original = {
      worldId: fixture.worldId,
      sections: db.prepare(`SELECT s.section_id AS sectionId, s.map_id AS mapId, s.grid_x AS gridX,
        s.grid_y AS gridY, s.revision, m.document_json AS document
        FROM world_sections s JOIN maps m ON m.project_id = s.project_id AND m.map_id = s.map_id
        WHERE s.project_id = ? AND s.world_id = ? ORDER BY s.grid_x`).all(projectId, fixture.worldId)
        .map(section => ({ ...section, document: JSON.parse(section.document) }))
    };
    initialLevel = JSON.parse(db.prepare("SELECT document_json FROM maps WHERE project_id = ? AND map_id = ?")
      .get(projectId, mapId).document_json);
    db.close();
    saved = { body: original };
    evidence.push({ apiWorld: original.worldId, sectionIds: original.sections.map(section => section.sectionId),
      apiChecks: "reused retained evidence" });
  } else {
    const created = await request("/api/projects", "POST", {
      name: "World fixture", author: "Disposable fixture", width: 2048, height: 2048, model: "generic-grid-v1"
    });
    assert.equal(created.status, 201);
    ({ projectId, mapId } = created.body);
    const base = `/api/projects/${projectId}/worlds`;
    initialLevel = (await request(`/api/projects/${projectId}/maps/${mapId}`)).body.document;
    const invalid = await request(base, "POST", { name: "Duplicate", sourceMapId: mapId,
      positions: [{ gridX: -1, gridY: 0 }, { gridX: -1, gridY: 0 }] });
    assert.equal(invalid.status, 400);
    assert.deepEqual((await request(base)).body.worlds, []);
    const creation = await request(base, "POST", { name: "API world", sourceMapId: mapId,
      positions: [{ gridX: -1, gridY: 0 }, { gridX: 0, gridY: 0 }] });
    assert.equal(creation.status, 201);
    original = creation.body;
    assert.equal(original.sections.length, 2);
    assert.notEqual(original.sections[0].sectionId, original.sections[1].sectionId);
    assert.equal((await request(`/api/projects/${projectId}/maps/${original.sections[0].mapId}`)).status, 409);
    address = `/api/projects/${projectId}/worlds/${original.worldId}`;
    const input = { operationId: "test-save-1", revision: original.revision,
      sections: original.sections.map(section => ({ sectionId: section.sectionId, revision: section.revision,
        document: structuredClone(section.document) })) };
    input.sections[0].document.objects[0].transform.x += 32;
    input.sections[1].document.objects[0].transform.y += 32;
    const invalidSave = structuredClone(input);
    invalidSave.operationId = "test-invalid";
    invalidSave.sections[1].document.bounds.width = 64;
    assert.notEqual((await request(address, "PUT", invalidSave)).status, 200);
    assert.deepEqual((await request(address)).body, original);
    const db = new DatabaseSync(database);
    db.exec(`CREATE TRIGGER fail_second_section BEFORE UPDATE ON maps
      WHEN NEW.map_id = '${original.sections[1].mapId}'
      BEGIN SELECT RAISE(ABORT, 'injected second-section failure'); END`);
    const failingSave = structuredClone(input);
    failingSave.operationId = "test-rollback";
    assert.equal((await request(address, "PUT", failingSave)).status, 500);
    assert.deepEqual((await request(address)).body, original);
    db.exec("DROP TRIGGER fail_second_section");
    db.close();
    saved = await request(address, "PUT", input);
    assert.equal(saved.status, 200);
    assert.deepEqual((await request(address, "PUT", input)).body, saved.body);
    const stale = structuredClone(input);
    stale.operationId = "test-stale";
    assert.equal((await request(address, "PUT", stale)).status, 409);
    assert.deepEqual((await request(`/api/projects/${projectId}/maps/${mapId}`)).body.document, initialLevel);
    await stop(server);
    server = service();
    await ready(`${api}/api/projects`, server);
    assert.deepEqual((await request(address)).body, saved.body);
    evidence.push({ apiWorld: saved.body.worldId, sectionIds: saved.body.sections.map(s => s.sectionId), apiChecks: "passed" });
  }
  address = `/api/projects/${projectId}/worlds/${original.worldId}`;

  const web = launch(process.execPath, [process.env.STUDIO_VITE_BIN ??
    resolve(root, "games", "sample", "node_modules", "vite", "bin", "vite.js"),
    "--config", "studio/vite.config.js", "--port", String(webPort), "--strictPort"], { STUDIO_API_PORT: String(apiPort) });
  await ready(webUrl, web);
  const chrome = launch(process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", [
    "--headless=new", "--disable-gpu", `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${resolve(directory, "chrome")}`, "--window-size=1600,1000", "about:blank"
  ]);
  const version = await (await ready(`http://127.0.0.1:${debugPort}/json/version`, chrome, true)).json();
  socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((ok, fail) => { socket.addEventListener("open", ok, { once: true }); socket.addEventListener("error", fail, { once: true }); });
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails);
    if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
      browserErrors.push(message.params.args.map(item => item.value ?? item.description ?? "").join(" "));
    }
    if (message.method === "Network.requestWillBeSent") {
      networkRequests.set(message.params.requestId, {
        url: message.params.request.url, method: message.params.request.method, postData: message.params.request.postData
      });
    }
    if (message.method === "Network.responseReceived" && message.params.response.url.includes("/api/")) {
      network.push({ url: message.params.response.url, status: message.params.response.status });
    }
    if (message.method === "Network.loadingFailed") {
      network.push({ url: networkRequests.get(message.params.requestId)?.url, error: message.params.errorText,
        canceled: message.params.canceled });
    }
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    clearTimeout(call.timer);
    if (message.error) call.fail(new Error(message.error.message)); else call.ok(message.result);
  });
  const target = await cdp("Target.createTarget", { url: webUrl }, true);
  sessionId = (await cdp("Target.attachToTarget", { targetId: target.targetId, flatten: true }, true)).sessionId;
  await cdp("Runtime.enable");
  await cdp("Page.enable");
  await cdp("Network.enable");
  await waitFor('window.__studioTest && window.__studioTest.document() && !document.querySelector("#open-game").disabled');
  await evaluate(`(() => {
    window.__worldWorkspaceTrace = [];
    for (const type of ["pointerdown", "mousedown", "click"]) {
      document.addEventListener(type, event => {
        const target = event.target.closest("#world-open");
        if (target) window.__worldWorkspaceTrace.push({ action: type, disabled: target.disabled,
          trusted: event.isTrusted, x: event.clientX, y: event.clientY });
      }, true);
    }
  })()`);
  await click("#open-game");
  await click(`.open-entry[data-project-id="${projectId}"] input`);
  await click("#open-selected");
  await waitFor(`window.__studioTest.identity().projectId === ${JSON.stringify(projectId)} && !document.querySelector("#open-dialog").open`);
  await click("#worlds-button");
  await waitFor(`document.querySelector("#world-dialog").open &&
    document.querySelector("#world-list").value === ${JSON.stringify(original.worldId)} &&
    !document.querySelector("#world-open").disabled`);
  await click("#world-open");
  if (pendingOnly) await waitFor('document.querySelector("#world-workspace").open');
  else await waitFor('document.querySelector("#world-workspace").open && document.querySelector("#world-status").textContent.includes("opened")');
  if (!pendingOnly && !terrainOnly) assert.match(await evaluate('document.querySelector("#world-play-note").textContent'), /Play is unavailable/);
  const canvas = await evaluate(`(() => { const r = document.querySelector("#world-canvas").getBoundingClientRect();
    const c = document.querySelector("#world-canvas");
    return {x:r.x,y:r.y,width:r.width,height:r.height,clientWidth:c.clientWidth,clientHeight:c.clientHeight}; })()`);
  assert.ok(canvas.width > 1024 && canvas.height > 300);
  if (terrainOnly) {
    const inspect = () => evaluate("window.__studioTest.worldWorkspace()");
    const docs = value => value.world.sections.map(item => item.document);
    const baselineDocuments = original.sections.map(item => item.document);
    const client = (x, y) => ({ x: canvas.x + (x + 2048) * 0.25, y: canvas.y + y * 0.25 });
    const drag = async (start, end, retrace = false) => {
      const a = client(start.x, start.y), b = client(end.x, end.y);
      await mouse("mousePressed", a.x, a.y);
      await mouse("mouseMoved", b.x, b.y);
      if (retrace) {
        await mouse("mouseMoved", a.x, a.y);
        await mouse("mouseMoved", b.x, b.y);
      }
      const preview = await inspect();
      assert.deepEqual(docs(preview), baselineDocuments, "the complete preview cannot mutate section documents");
      assert.equal(preview.gesture, "brush");
      assert.equal(await evaluate('document.querySelector("#world-save").disabled'), true);
      await mouse("mouseReleased", b.x, b.y);
    };
    const assertUnchanged = async message => {
      const state = await inspect();
      assert.deepEqual(docs(state), baselineDocuments, message);
      assert.equal(state.undoCount, 0);
      assert.equal(state.redoCount, 0);
      assert.equal(state.dirty, false);
    };
    assert.deepEqual(docs(await inspect()), baselineDocuments, "workspace loads exact fixture documents");
    const selected = client(-1008, 1040);
    await mouse("mousePressed", selected.x, selected.y);
    await mouse("mouseReleased", selected.x, selected.y);
    const initialSelection = (await inspect()).selection;
    assert.deepEqual(initialSelection, { sectionId: original.sections[0].sectionId, objectId: "player-start" });
    await click("#world-brush-tool");
    assert.equal(await evaluate('document.querySelector("#world-brush-asset").value'), "generic-tile");
    assert.equal(await evaluate('document.querySelector("#world-terrain-locked").checked'), true);
    const start = { x: -81, y: 337 }, end = { x: 80, y: 337 };
    await drag(start, end);
    assert.match(await evaluate('document.querySelector("#world-status").textContent'), /rejected.*locked/);
    await assertUnchanged("locked terrain rejects the whole seam stroke");
    await click("#world-terrain-locked");
    await click("#world-terrain-visible");
    await drag(start, end);
    assert.match(await evaluate('document.querySelector("#world-status").textContent'), /rejected.*hidden/);
    await assertUnchanged("hidden terrain rejects the whole seam stroke");
    await click("#world-terrain-visible");

    const cancelStart = client(-81, 369), cancelEnd = client(80, 369);
    await mouse("mousePressed", cancelStart.x, cancelStart.y);
    await mouse("mouseMoved", cancelEnd.x, cancelEnd.y);
    assert.deepEqual(docs(await inspect()), baselineDocuments);
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
    await mouse("mouseReleased", cancelEnd.x, cancelEnd.y);
    assert.match(await evaluate('document.querySelector("#world-status").textContent'), /cancelled/);
    assert.equal(await evaluate('document.querySelector("#world-workspace").open'), true);
    await assertUnchanged("Escape cancels without closing the workspace or adding history");
    await drag({ x: 1984, y: 337 }, { x: 2096, y: 337 });
    assert.match(await evaluate('document.querySelector("#world-status").textContent'), /rejected.*Section \(1, 0\).*missing/);
    await assertUnchanged("missing adjacent section leaves both loaded documents unchanged");

    const expected = structuredClone(baselineDocuments);
    expected[0].objects.push(
      generic.createDesignObject("terrain-brush-2", "generic-tile", { x: 1952, y: 320 }, 38),
      generic.createDesignObject("terrain-brush-3", "generic-tile", { x: 1984, y: 320 }, 39));
    expected[1].objects.push(
      generic.createDesignObject("terrain-brush-1", "generic-tile", { x: 32, y: 320 }, 38),
      generic.createDesignObject("terrain-brush-2", "generic-tile", { x: 64, y: 320 }, 39));
    evidence.push({ terrainExpected: expected });
    await drag(start, end, true);
    let state = await inspect();
    evidence.push({ terrainActualAfterStroke: state });
    assert.deepEqual(docs(state), expected, "fast retraced seam stroke paints exactly six gap-free cells");
    assert.deepEqual(state.selection, initialSelection);
    assert.equal(state.undoCount, 1, "the whole cross-section stroke is one command");
    assert.equal(state.dirty, true);
    for (const document of docs(state)) {
      const terrain = document.objects.filter(object => object.type === "terrain-tile");
      assert.equal(terrain.length, 3);
      assert.equal(new Set(terrain.map(object => `${object.transform.x},${object.transform.y}`)).size, 3);
    }
    const painted = await cdp("Page.captureScreenshot");
    await writeFile(resolve(directory, "terrain-painted.png"), Buffer.from(painted.data, "base64"));

    await click("#world-terrain-locked");
    await click("#world-undo");
    state = await inspect();
    assert.deepEqual(docs(state), baselineDocuments, "one Undo restores both sections even while terrain is locked");
    assert.deepEqual(state.selection, initialSelection);
    assert.equal(state.dirty, false);
    assert.equal(state.undoCount, 0);
    assert.equal(state.redoCount, 1);
    await click("#world-redo");
    state = await inspect();
    assert.deepEqual(docs(state), expected, "one Redo restores both complete painted documents");
    assert.equal(state.undoCount, 1);
    assert.deepEqual(state.selection, initialSelection);
    await click("#world-terrain-locked");
    const a = client(start.x, start.y), b = client(end.x, end.y);
    await mouse("mousePressed", a.x, a.y);
    await mouse("mouseMoved", b.x, b.y);
    await mouse("mouseReleased", b.x, b.y);
    assert.match(await evaluate('document.querySelector("#world-status").textContent'), /unchanged/);
    state = await inspect();
    assert.deepEqual(docs(state), expected);
    assert.equal(state.undoCount, 1, "identical repaint does not stack terrain or add history");
    await click("#world-save");
    await waitFor('document.querySelector("#world-status").textContent.includes("saved transactionally")');
    state = await inspect();
    assert.deepEqual(docs(state), expected);
    assert.equal(state.dirty, false);
    const putRequests = [...networkRequests.values()].filter(item => item.url === webUrl + address && item.method === "PUT");
    assert.equal(putRequests.length, 1, "UI submits both dirty sections in one workspace PUT");
    const submitted = JSON.parse(putRequests[0].postData);
    assert.deepEqual(submitted.sections.map(item => item.document), expected);
    assert.deepEqual(submitted.sections.map(item => item.sectionId), original.sections.map(item => item.sectionId));
    assert.equal(state.world.revision, original.revision + 1);
    for (let index = 0; index < 2; index++) assert.equal(state.world.sections[index].revision, original.sections[index].revision + 1);
    const db = new DatabaseSync(database, { readOnly: true });
    const receipt = db.prepare("SELECT result_json FROM world_save_receipts WHERE operation_id = ?").get(submitted.operationId);
    assert.ok(receipt, "the transaction records the exact save receipt");
    assert.deepEqual(JSON.parse(receipt.result_json).sections.map(item => item.document), expected);
    const stored = db.prepare(`SELECT m.document_json FROM world_sections s JOIN maps m
      ON m.project_id = s.project_id AND m.map_id = s.map_id
      WHERE s.project_id = ? AND s.world_id = ? ORDER BY s.grid_x`).all(projectId, original.worldId);
    db.close();
    assert.deepEqual(stored.map(item => JSON.parse(item.document_json)), expected);
    evidence.push({ transactionalPut: submitted, savedWorkspace: state, sqliteDocuments: expected });
    await click("#world-undo");
    assert.deepEqual(docs(await inspect()), baselineDocuments);
    assert.equal((await inspect()).dirty, true, "Undo after save retains history and becomes dirty");
    await click("#world-redo");
    assert.deepEqual(docs(await inspect()), expected);
    assert.equal((await inspect()).dirty, false, "Redo to the saved baseline becomes clean");
    await click("#world-close");
    await stop(server);
    server = service();
    await ready(`${api}/api/projects`, server);
    await click("#worlds-button");
    await waitFor(`document.querySelector("#world-dialog").open &&
      document.querySelector("#world-list").value === ${JSON.stringify(original.worldId)} &&
      !document.querySelector("#world-open").disabled`);
    await click("#world-open");
    await waitFor('document.querySelector("#world-workspace").open && document.querySelector("#world-status").textContent.includes("opened")');
    const reopened = await inspect();
    evidence.push({ terrainReopened: reopened });
    assert.deepEqual(docs(reopened), expected, "UI reopen after owned service restart restores both exact documents");
    assert.equal(reopened.dirty, false);
    assert.equal(reopened.undoCount, 0);
    assert.deepEqual(await evaluate("window.__studioTest.document()"), initialLevel);
    assert.deepEqual((await request(`/api/projects/${projectId}/maps/${mapId}`)).body.document, initialLevel);
    assert.deepEqual(exceptions, []);
    assert.deepEqual(browserErrors, []);
    console.log("Disposable direct-CDP terrain paint/save/reopen flow passed.");
  } else if (pendingOnly) {
    const storedDocuments = () => {
      const db = new DatabaseSync(database, { readOnly: true });
      try {
        return db.prepare(`SELECT s.section_id AS sectionId, m.document_json AS document
          FROM world_sections s JOIN maps m ON m.project_id = s.project_id AND m.map_id = s.map_id
          WHERE s.project_id = ? AND s.world_id = ? ORDER BY s.grid_x`).all(projectId, original.worldId)
          .map(section => ({ sectionId: section.sectionId, document: JSON.parse(section.document) }));
      } finally { db.close(); }
    };
    const baselineDocuments = original.sections.map(section => ({
      sectionId: section.sectionId, document: section.document
    }));
    const storedBefore = storedDocuments();
    assert.deepEqual(storedBefore, baselineDocuments);

    let camera = { x: -2048, y: 0, zoom: 0.25 };
    const zoomAt = (value, x, y) => {
      const worldX = camera.x + x / camera.zoom;
      const worldY = camera.y + y / camera.zoom;
      camera = { x: worldX - x / value, y: worldY - y / value, zoom: value };
    };
    await click("#world-zoom-in");
    zoomAt(camera.zoom * 1.2, canvas.clientWidth / 2, canvas.clientHeight / 2);
    await waitFor('document.querySelector("#world-zoom-label").textContent === "30%"');
    const marker = original.sections.find(section => section.gridX === 0).document.objects
      .find(object => object.id === "player-start");
    const markerWorld = { x: marker.transform.x + 16, y: marker.transform.y + 16 };
    const wheelX = (markerWorld.x - camera.x) * camera.zoom;
    const wheelY = (markerWorld.y - camera.y) * camera.zoom;
    const sample = (x, y) => evaluate(`(() => {
      const canvas = document.querySelector("#world-canvas");
      const rect = canvas.getBoundingClientRect();
      const px = Math.floor(${JSON.stringify(x)} * canvas.width / rect.width);
      const py = Math.floor(${JSON.stringify(y)} * canvas.height / rect.height);
      return [...canvas.getContext("2d").getImageData(px, py, 1, 1).data];
    })()`);
    const markerColorBefore = await sample(wheelX, wheelY);
    assert.deepEqual(markerColorBefore, [8, 127, 91, 255], "wheel anchor is on the section-local player marker");
    const cameraBeforeWheel = { ...camera };
    await cdp("Input.dispatchMouseEvent", {
      type: "mouseWheel", x: canvas.x + wheelX, y: canvas.y + wheelY, deltaX: 0, deltaY: -100
    });
    zoomAt(camera.zoom * 1.1, wheelX, wheelY);
    await waitFor('document.querySelector("#world-zoom-label").textContent === "33%"');
    assert.deepEqual(await sample(wheelX, wheelY), markerColorBefore,
      "wheel zoom keeps the same section-local marker under the pointer");
    assert.ok(Math.abs((markerWorld.x - camera.x) * camera.zoom - wheelX) < 1e-8);
    assert.ok(Math.abs((markerWorld.y - camera.y) * camera.zoom - wheelY) < 1e-8);
    const cameraAfterWheel = { ...camera };

    const seamBeforePan = (0 - camera.x) * camera.zoom;
    const eastEdgeBeforePan = (2048 - camera.x) * camera.zoom;
    const boundaryPixel = async x => evaluate(`(() => {
      const canvas = document.querySelector("#world-canvas");
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const context = canvas.getContext("2d");
      const px = Math.round(${JSON.stringify(x)} * scaleX);
      const py = Math.round(80 * scaleY);
      for (let dx = -8; dx <= 8; dx++) {
        const color = context.getImageData(px + dx, py, 1, 1).data;
        if (color[0] === 255 && color[1] === 209 && color[2] === 102 && color[3] === 255) return true;
      }
      return false;
    })()`);
    assert.equal(await boundaryPixel(seamBeforePan), true, "shared section boundary is visible before pan");
    assert.equal(await boundaryPixel(eastEdgeBeforePan), true, "eastern section boundary is visible before pan");
    const panCenter = { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 };
    await mouse("mousePressed", canvas.x + panCenter.x, canvas.y + panCenter.y, "middle");
    await mouse("mouseMoved", canvas.x + panCenter.x + 60, canvas.y + panCenter.y + 30, "middle");
    await mouse("mouseReleased", canvas.x + panCenter.x + 60, canvas.y + panCenter.y + 30, "middle");
    camera.x -= 60 / camera.zoom;
    camera.y -= 30 / camera.zoom;
    const seamAfterPan = (0 - camera.x) * camera.zoom;
    const eastEdgeAfterPan = (2048 - camera.x) * camera.zoom;
    assert.ok(Math.abs(seamAfterPan - seamBeforePan - 60) < 1);
    assert.ok(Math.abs(eastEdgeAfterPan - eastEdgeBeforePan - 60) < 1);
    assert.equal(await boundaryPixel(seamAfterPan), true, "both sections pan together across their shared edge");
    assert.equal(await boundaryPixel(eastEdgeAfterPan), true, "eastern section boundary follows the shared canvas pan");
    const markerAfterPan = {
      x: (markerWorld.x - camera.x) * camera.zoom,
      y: (markerWorld.y - camera.y) * camera.zoom
    };
    assert.deepEqual(await sample(markerAfterPan.x, markerAfterPan.y), markerColorBefore,
      "panning preserves the marker's section-local coordinates");
    assert.deepEqual(storedDocuments(), baselineDocuments,
      "zoom and pan do not change either section's persisted local coordinates");
    evidence.push({
      viewport: { cameraBeforeWheel, cameraAfterWheel,
        cameraAfterPan: camera, wheelAnchor: { x: wheelX, y: wheelY, markerWorld }, markerColorBefore,
        markerAfterPan, seamBeforePan, seamAfterPan, eastEdgeBeforePan, eastEdgeAfterPan },
      unchangedDocumentsBeforeSave: true
    });

    const dirtyMarker = original.sections[0].document.objects.find(object => object.id === "player-start-2");
    const dirtyWorldX = -2048 + dirtyMarker.transform.x + 16;
    const dirtyWorldY = dirtyMarker.transform.y + 16;
    const dirtyPoint = { x: (dirtyWorldX - camera.x) * camera.zoom, y: (dirtyWorldY - camera.y) * camera.zoom };
    await mouse("mousePressed", canvas.x + dirtyPoint.x, canvas.y + dirtyPoint.y);
    await mouse("mouseMoved", canvas.x + dirtyPoint.x + 32 * camera.zoom, canvas.y + dirtyPoint.y);
    assert.deepEqual(await evaluate(`["#world-save", "#world-undo", "#world-redo", "#world-close"]
      .map(selector => document.querySelector(selector).disabled)`), [true, true, true, true],
    "workspace actions are disabled while a drag is in progress");
    const worldRequestsBeforeShortcut = network.filter(item => item.url === api + address).length;
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "s", code: "KeyS", modifiers: 2 });
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "s", code: "KeyS", modifiers: 2 });
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
    assert.equal(await evaluate('document.querySelector("#world-workspace").open'), true,
      "Escape cannot close an unfinished drag");
    assert.equal(network.filter(item => item.url === api + address).length, worldRequestsBeforeShortcut,
      "the save shortcut cannot submit an unfinished drag");
    await mouse("mouseReleased", canvas.x + dirtyPoint.x + 32 * camera.zoom, canvas.y + dirtyPoint.y);
    await waitFor('!document.querySelector("#world-save").disabled');
    const expectedDocuments = structuredClone(baselineDocuments);
    expectedDocuments[0].document.objects.find(object => object.id === "player-start-2").transform.x += 32;
    await click("#world-save");
    await waitFor('document.querySelector("#world-status").textContent.includes("saved transactionally")');
    assert.deepEqual(storedDocuments(), expectedDocuments, "UI save persists the exact section-local documents");
    await click("#world-close");
    await click("#worlds-button");
    await waitFor(`document.querySelector("#world-dialog").open &&
      document.querySelector("#world-list").value === ${JSON.stringify(original.worldId)} &&
      !document.querySelector("#world-open").disabled`);
    await click("#world-open");
    await waitFor('document.querySelector("#world-workspace").open && document.querySelector("#world-zoom-label").textContent === "25%"');
    const reopened = (await request(address)).body;
    assert.deepEqual(reopened.sections.map(section => ({
      sectionId: section.sectionId, document: section.document
    })), expectedDocuments, "reopening through the UI restores exact persisted documents");
    assert.deepEqual(await evaluate('window.__studioTest.document()'), initialLevel);
    assert.deepEqual(exceptions, []);
    evidence.push({ reopenedDocuments: reopened.sections.map(section => section.document),
      persistence: "UI save and reopen passed exactly" });
  } else {
  const boundaryPixel = async x => evaluate(`(() => {
    const canvas = document.querySelector("#world-canvas");
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const context = canvas.getContext("2d");
    const px = Math.round(${JSON.stringify(x)} * scaleX);
    const py = Math.round(80 * scaleY);
    for (let dx = -8; dx <= 8; dx++) {
      const color = context.getImageData(px + dx, py, 1, 1).data;
      if (color[0] === 255 && color[1] === 209 && color[2] === 102 && color[3] === 255) return true;
    }
    return false;
  })()`);
  assert.equal(await boundaryPixel(512), true, "the shared section edge is rendered on the common canvas");
  assert.equal(await boundaryPixel(1024), true, "the second section boundary is rendered on the common canvas");
  const leftX = canvas.x + (1056 + 16) * 0.25;
  const leftY = canvas.y + (1024 + 16) * 0.25;
  await mouse("mousePressed", leftX, leftY);
  await mouse("mouseMoved", leftX + 260, leftY);
  await mouse("mouseReleased", leftX + 260, leftY);
  await waitFor('document.querySelector("#world-status").textContent.includes("Move rejected")');
  assert.equal(await evaluate('document.querySelector("#world-save").disabled'), true,
    "a cross-section move is rejected without dirtying either section");
  await mouse("mousePressed", leftX, leftY);
  await mouse("mouseMoved", leftX + 8, leftY + 8);
  await mouse("mouseReleased", leftX + 8, leftY + 8);
  await waitFor('!document.querySelector("#world-save").disabled');
  const rightX = canvas.x + (2048 + 1024 + 16) * 0.25;
  const rightY = canvas.y + (1056 + 16) * 0.25;
  await mouse("mousePressed", rightX, rightY);
  await mouse("mouseMoved", rightX + 8, rightY);
  await mouse("mouseReleased", rightX + 8, rightY);
  await waitFor('document.querySelector("#world-status").textContent.includes("Object moved within its section")');

  let camera = { x: -2048, y: 0, zoom: 0.25 };
  const zoomAt = (value, x, y) => {
    const worldX = camera.x + x / camera.zoom;
    const worldY = camera.y + y / camera.zoom;
    camera = { x: worldX - x / value, y: worldY - y / value, zoom: value };
  };
  await click("#world-zoom-in");
  zoomAt(camera.zoom * 1.2, canvas.clientWidth / 2, canvas.clientHeight / 2);
  await waitFor('document.querySelector("#world-zoom-label").textContent === "30%"');
  const wheelX = canvas.width * 0.65;
  const wheelY = canvas.height * 0.6;
  await cdp("Input.dispatchMouseEvent", {
    type: "mouseWheel", x: canvas.x + wheelX, y: canvas.y + wheelY, deltaX: 0, deltaY: -100
  });
  zoomAt(camera.zoom * 1.1, wheelX, wheelY);
  await waitFor('document.querySelector("#world-zoom-label").textContent === "33%"');
  await mouse("mousePressed", canvas.x + canvas.width / 2, canvas.y + canvas.height / 2, "middle");
  await mouse("mouseMoved", canvas.x + canvas.width / 2 + 60, canvas.y + canvas.height / 2 + 30, "middle");
  await mouse("mouseReleased", canvas.x + canvas.width / 2 + 60, canvas.y + canvas.height / 2 + 30, "middle");
  camera.x -= 60 / camera.zoom;
  camera.y -= 30 / camera.zoom;
  const seam = (0 - camera.x) * camera.zoom;
  const eastEdge = (2048 - camera.x) * camera.zoom;
  assert.equal(await boundaryPixel(seam), true, "pan and zoom preserve the shared section boundary");
  assert.equal(await boundaryPixel(eastEdge), true, "pan and zoom preserve the eastern section boundary");
  await click("#world-save");
  await waitFor('document.querySelector("#world-status").textContent.includes("saved transactionally")');
  await click("#world-close");
  await click("#worlds-button");
  await waitFor(`document.querySelector("#world-dialog").open &&
    document.querySelector("#world-list").value === ${JSON.stringify(original.worldId)} &&
    !document.querySelector("#world-open").disabled`);
  await click("#world-open");
  await waitFor('document.querySelector("#world-workspace").open && document.querySelector("#world-zoom-label").textContent === "25%"');
  const reopened = (await request(address)).body;
  assert.deepEqual(reopened.sections[0].document.objects[0].transform, { x: 1088, y: 1056 });
  const expectedSecond = structuredClone(saved.body.sections[1].document);
  expectedSecond.objects[0].transform.x += 32;
  assert.deepEqual(reopened.sections[1].document, expectedSecond);
  assert.deepEqual(await evaluate('window.__studioTest.document()'), initialLevel);
  assert.deepEqual(exceptions, []);
  evidence.push({ canvas, reopenedTransform: reopened.sections[0].document.objects[0].transform, directCdp: "passed" });
  }
} catch (error) {
  failure = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  if (socket?.readyState === WebSocket.OPEN && sessionId) {
    try {
      evidence.push({ ui: await evaluate(`({
        readyState: document.readyState,
        status: document.querySelector("#world-status")?.textContent,
        dialogStatus: document.querySelector("#world-dialog-status")?.textContent,
        dialogOpen: document.querySelector("#world-dialog")?.open,
        workspaceOpen: document.querySelector("#world-workspace")?.open,
        selectedWorld: document.querySelector("#world-list")?.value,
        openDisabled: document.querySelector("#world-open")?.disabled,
        openRect: (() => { const r = document.querySelector("#world-open")?.getBoundingClientRect();
          return r && {x:r.x,y:r.y,width:r.width,height:r.height}; })(),
        title: document.querySelector("#world-workspace-title")?.textContent,
        trace: window.__worldWorkspaceTrace,
        worldWorkspace: window.__studioTest?.worldWorkspace?.()
      })`) });
      const screenshot = await cdp("Page.captureScreenshot");
      await writeFile(resolve(directory, "final.png"), Buffer.from(screenshot.data, "base64"));
    } catch (error) { evidence.push({ diagnosticsError: error.message }); }
    try { await cdp("Browser.close", {}, true); }
    catch (error) { evidence.push({ browserCloseError: error.message }); }
    socket.close();
  }
  for (const child of [...children].reverse()) await stop(child);
  await writeFile(resolve(directory, "diagnostics.json"), JSON.stringify({
    failure, evidence, exceptions, browserErrors, network: network.filter(item => item.url || item.error),
    ports: { apiPort, webPort, debugPort },
    processes: children.map(child => ({ pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode })),
    ...(terrainOnly ? { requests: [...networkRequests.values()] } : {})
  }, null, 2));
  for (const [index, child] of children.entries()) await writeFile(resolve(directory, `process-${index}.log`), child.output);
  console.log(`World workspace evidence: ${directory}`);
  if (failure) console.error(failure);
}
