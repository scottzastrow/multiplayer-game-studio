import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { setTimeout as delay } from "node:timers/promises";
import { createLocalGame } from "../../games/sample/node_modules/@multiplayer-game/local-preview/dist/index.js";
import { validateMapDefinition } from "../../games/sample/node_modules/@multiplayer-game/theme-sdk/dist/index.js";
import * as generic from "../../games/generic-grid-v1/src/project.js";
import * as tower from "../../games/astraeum-tower/src/project.js";
import {
  boundaryEdges,
  createGridRectangleBoundary,
  createPolygonBoundary,
  defaultBoundaryCells,
  playableBoundaryCells,
  validatePlayableBoundary,
  validatePlayableBoundaryForSections
} from "../playable-boundaries.js";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const dataRoot = resolve(root, "studio", "data");
await mkdir(dataRoot, { recursive: true });
const testDir = await mkdtemp(resolve(dataRoot, "playable-boundaries-test-"));
let service;
let output = "";

function section(gridX, gridY, width = 2048, height = 2048) {
  return { sectionId: `section-${gridX}-${gridY}`, mapId: `map-${gridX}-${gridY}`, gridX, gridY,
    document: { bounds: { width, height } } };
}

function hasEdge(edges, x1, y1, x2, y2) {
  return edges.some(edge => edge.x1 === x1 && edge.y1 === y1 && edge.x2 === x2 && edge.y2 === y2);
}

async function freePort() {
  const listener = createServer();
  await new Promise((ok, fail) => listener.once("error", fail).listen(0, "127.0.0.1", ok));
  const port = listener.address().port;
  await new Promise((ok, fail) => listener.close(error => error ? fail(error) : ok()));
  return port;
}

async function startService() {
  const port = await freePort();
  output = "";
  service = spawn(process.execPath, ["--no-warnings", resolve(root, "studio", "server.mjs")], {
    cwd: root,
    env: { ...process.env, STUDIO_API_PORT: String(port),
      STUDIO_DATABASE_PATH: relative(root, resolve(testDir, "studio.sqlite")),
      STUDIO_GAMES_PATH: relative(root, resolve(testDir, "games")) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  service.stdout.on("data", chunk => { output += chunk; });
  service.stderr.on("data", chunk => { output += chunk; });
  const origin = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (service.exitCode !== null) throw new Error(`Studio API exited: ${output}`);
    try {
      const response = await fetch(`${origin}/api/projects`);
      if (response.ok) return origin;
    } catch {}
    await delay(100);
  }
  throw new Error(`Studio API did not start: ${output}`);
}

async function stopService() {
  if (!service || service.exitCode !== null || service.signalCode !== null) return;
  await new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error("Studio API did not stop.")), 5000);
    service.once("exit", () => { clearTimeout(timer); ok(); });
    service.kill("SIGTERM");
  });
}

async function request(address, method = "GET", body) {
  const response = await fetch(address, {
    method,
    ...(body === undefined ? {} : {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    })
  });
  return { status: response.status, body: await response.json() };
}

try {
  const adjacent = [section(0, 0), section(1, 0)];
  const adjacentCells = defaultBoundaryCells(adjacent);
  const adjacentEdges = boundaryEdges(adjacentCells);
  assert.equal(adjacentCells.size, 8192, "default area is the union of both full sections");
  assert.ok(hasEdge(adjacentEdges, 0, 10, 0, 11), "west outer edge is exposed");
  assert.ok(!hasEdge(adjacentEdges, 64, 10, 64, 11), "the shared section seam is not a wall");
  assert.ok(hasEdge(adjacentEdges, 128, 10, 128, 11), "east outer edge is exposed");

  const aroundHole = [section(0, 0), section(1, 0), section(0, 1)];
  const holeEdges = boundaryEdges(defaultBoundaryCells(aroundHole));
  assert.ok(hasEdge(holeEdges, 64, 64, 65, 64), "the missing southeast section remains a hole");
  assert.ok(hasEdge(holeEdges, 64, 64, 64, 65), "hole edges are exposed on both adjacent sections");
  assert.ok(!hasEdge(holeEdges, 64, 20, 64, 21), "shared vertical seam stays open");

  const beforeExpansion = defaultBoundaryCells([section(0, 0)]);
  const afterExpansion = defaultBoundaryCells([section(0, 0), section(0, 1)]);
  assert.equal(beforeExpansion.size, 4096);
  assert.equal(afterExpansion.size, 8192, "adding a section expands the implicit default boundary");

  const smallRoot = section(0, 0, 160, 160);
  const gridResult = createGridRectangleBoundary({ x: 1, y: 1 }, { x: 2, y: 2 }, [smallRoot]);
  assert.equal(gridResult.cells.size, 4);
  assert.throws(() => createGridRectangleBoundary({ x: 63, y: 1 }, { x: 64, y: 1 }, [section(0, 0)]), /missing section/);
  const polygonResult = createPolygonBoundary([[1, 1], [5, 1], [5, 5], [1, 5]], [smallRoot]);
  assert.equal(polygonResult.cells.size, 16, "closed polygon interior is rasterized to 32 px cells");
  assert.throws(() => createPolygonBoundary([[0, 0], [4, 4], [0, 4], [4, 0]], [smallRoot]), /self-intersects/);
  assert.throws(() => createPolygonBoundary([[1, 1], [5, 1], [3, 1], [3, 5], [1, 5]], [smallRoot]), /backtracks/);
  assert.throws(() => createPolygonBoundary([[64, 64], [68, 64], [68, 68], [64, 68]], aroundHole),
    /missing section/, "polygon areas extending into a missing section are rejected");
  const savedCustomBoundary = structuredClone(gridResult.boundary);
  assert.deepEqual(savedCustomBoundary, gridResult.boundary, "custom boundaries are stable when more sections are added");
  assert.equal(playableBoundaryCells(savedCustomBoundary, [smallRoot, section(1, 0)]).size, 4);
  assert.throws(() => validatePlayableBoundary({ ...savedCustomBoundary, version: 2 }), /version/);
  assert.throws(() => validatePlayableBoundary({ ...savedCustomBoundary, unknown: true }), /exactly/);

  const main = await (await import("node:fs/promises")).readFile(resolve(root, "studio", "src", "main.js"), "utf8");
  const functionSource = name => {
    const start = main.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `main editor defines ${name}`);
    const end = main.indexOf("\nfunction ", start + 1);
    assert.ok(end > start, `${name} has a complete function body`);
    return main.slice(start, end);
  };
  const document = generic.createDocument("boundary-test-map", "Boundary test");
  const sections = [{ sectionId: "root", mapId: document.id, gridX: 0, gridY: 0, document }];
  const editor = {
    state: { sections, identity: { mapId: document.id }, activeSectionId: "root", document,
      selectedIds: new Set(), undo: [], redo: [], boundaryDraft: null, fillPreview: null,
      pointerMode: null, scene: {} },
    HISTORY_LIMIT: 100,
    fillDiagnostics: { applying: false },
    validateFloorDocument: generic.validateFloorDocument,
    validatePlayableBoundaryForSections: (boundary, items) => validatePlayableBoundaryForSections(boundary, items),
    isPlaying: () => false,
    isSelectable: () => true,
    setSelection: ids => { editor.state.selectedIds = new Set(ids); },
    activeSection: () => editor.state.sections.find(item => item.sectionId === editor.state.activeSectionId),
    boundarySections: () => editor.state.sections.map(({ gridX, gridY, document: design }) => ({ gridX, gridY, document: design })),
    refreshChrome() {},
    refreshAfterOperation() {},
    render() {},
    setStatus() {}
  };
  editor.validateFloorDocument = value => generic.validateFloorDocument(value);
  const historyController = ["pushSectionUndo", "restoreHistory", "undo", "redo",
    "commitToolPreview", "applyBoundary", "resetBoundary", "cancelBoundaryPreview"].map(functionSource).join("\n");
  const editorBoundary = createGridRectangleBoundary({ x: 30, y: 30 }, { x: 33, y: 33 }, [
    { gridX: 0, gridY: 0, document }
  ]).boundary;
  editor.state.boundaryDraft = { boundary: editorBoundary, cells: new Set(), type: "boundary-grid" };
  const baselineDocument = structuredClone(editor.state.document);
  runInNewContext(`${historyController}\ncancelBoundaryPreview();`, editor);
  assert.deepEqual(editor.state.document, baselineDocument, "Escape cancellation leaves the document unchanged");
  assert.equal(editor.state.undo.length, 0, "cancellation creates no history");
  editor.state.boundaryDraft = { boundary: editorBoundary, cells: new Set(), type: "boundary-grid" };
  runInNewContext(`${historyController}\napplyBoundary();`, editor);
  assert.equal(editor.state.boundaryDraft, null, `Apply failed: ${editor.state.boundaryDraft?.error ?? "unknown error"}`);
  assert.equal(editor.state.undo.length, 1, "Apply creates exactly one undo entry");
  assert.deepEqual(editor.state.document.playableBoundary, editorBoundary);
  runInNewContext(`${historyController}\nundo();`, editor);
  assert.equal(Object.hasOwn(editor.state.document, "playableBoundary"), false, "Undo restores default behavior");
  runInNewContext(`${historyController}\nredo();`, editor);
  assert.deepEqual(editor.state.document.playableBoundary, editorBoundary, "Redo restores the custom boundary");
  const historyBeforeReset = editor.state.undo.length;
  runInNewContext(`${historyController}\nresetBoundary();`, editor);
  assert.equal(editor.state.undo.length, historyBeforeReset + 1, "Reset creates exactly one undo entry");
  assert.equal(Object.hasOwn(editor.state.document, "playableBoundary"), false);
  runInNewContext(`${historyController}\nundo();`, editor);
  assert.deepEqual(editor.state.document.playableBoundary, editorBoundary, "Undo restores the reset boundary");
  runInNewContext(`${historyController}\nredo();`, editor);
  assert.equal(Object.hasOwn(editor.state.document, "playableBoundary"), false, "Redo reapplies Reset");

  const runtimeDocument = generic.validateFloorDocument({
    ...document,
    playableBoundary: createGridRectangleBoundary({ x: 30, y: 30 }, { x: 33, y: 33 }, [
      { gridX: 0, gridY: 0, document }
    ]).boundary
  });
  assert.deepEqual(generic.playStartProblems(runtimeDocument), []);
  const playOptions = {
    map: generic.createFloorMap(runtimeDocument),
    settings: { moveDistance: 4 },
    seed: 1,
    roster: [{ accountId: "player", username: "Player", joinedOrder: 0 }],
    viewer: { accountId: "player", role: "player" },
    moduleFactory: {
      metadata: { id: generic.MODEL, version: "1.0.0", stateSchemaVersion: 1 },
      validateSettings: settings => settings?.moveDistance === 4,
      create(context, settings, roster) {
        const inputs = new Map();
        let tick = 0;
        return {
          stateSchemaVersion: 1,
          get state() { return { tick }; },
          initialize() {
            context.entities.add({
              id: `player:${roster[0].accountId}`, typeId: "generic-player",
              position: playOptions.map.spawns[0].position, radius: 8,
              state: { accountId: roster[0].accountId }
            });
          },
          validateInput: input => input?.type === "move" &&
            [input.x, input.y].every(value => Number.isFinite(value) && Math.abs(value) <= 1),
          applyInput(accountId, input) { inputs.set(accountId, { x: input.x, y: input.y }); },
          setPlayerPresence() {},
          step(_dt, nextTick) {
            tick = nextTick;
            for (const player of context.entities.values()) {
              const input = inputs.get(player.state.accountId);
              if (!input) continue;
              const distance = settings.moveDistance / Math.max(1, Math.hypot(input.x, input.y));
              const position = context.geometry.moveCircle(player.position,
                { x: input.x * distance, y: input.y * distance }, player.radius);
              context.entities.update(player.id, current => ({ ...current, position }));
            }
          },
          snapshot() {
            return { tick, players: context.entities.values().map(player => ({ position: player.position })) };
          },
          results() { return {}; },
          dispose() { inputs.clear(); }
        };
      }
    }
  };
  const game = await createLocalGame(playOptions);
  try {
    const initial = game.snapshot.players[0].position;
    assert.ok(initial.x >= 960 && initial.x < 1088, "existing player spawn was not repositioned");
    assert.ok(playOptions.map.collisions.length > 0, "custom boundary is represented by public collision rectangles");
    assert.equal(game.sendInput("player", { type: "move", x: 1, y: 0 }), true);
    for (let index = 0; index < 40; index += 1) game.step();
    const blocked = game.snapshot.players[0].position;
    assert.ok(blocked.x > initial.x && blocked.x <= 1080.01,
      `single-section public runtime blocks at the playable edge (got ${blocked.x})`);
  } finally {
    game.dispose();
  }
  const outsideDocument = generic.validateFloorDocument({
    ...document,
    playableBoundary: createGridRectangleBoundary({ x: 0, y: 0 }, { x: 8, y: 8 }, [
      { gridX: 0, gridY: 0, document }
    ]).boundary
  });
  assert.ok(generic.playStartProblems(outsideDocument).some(problem => /lies outside the playable boundary/.test(problem)),
    "an excluded spawn is explained rather than moved");
  const towerDocument = tower.createFloorDocument();
  const towerBoundary = createGridRectangleBoundary({ x: 1, y: 1 }, { x: 8, y: 8 }, [
    { gridX: 0, gridY: 0, document: towerDocument }
  ]).boundary;
  const boundedTowerDocument = tower.validateFloorDocument({
    ...towerDocument,
    playableBoundary: towerBoundary
  });
  assert.deepEqual(tower.playStartProblems(boundedTowerDocument), [],
    "Astraeum player and reserved spawns remain within the custom boundary");
  const towerMap = tower.createFloorMap(boundedTowerDocument);
  assert.equal(validateMapDefinition(towerMap).id, towerMap.id,
    "Astraeum boundary collisions satisfy the installed public map contract");
  assert.ok(towerMap.collisions.length > tower.createFloorMap(towerDocument).collisions.length,
    "Astraeum custom boundaries add non-rendered runtime collisions");
  const excludedTowerDocument = tower.validateFloorDocument({
    ...towerDocument,
    playableBoundary: createGridRectangleBoundary({ x: 20, y: 1 }, { x: 25, y: 8 }, [
      { gridX: 0, gridY: 0, document: towerDocument }
    ]).boundary
  });
  assert.ok(tower.playStartProblems(excludedTowerDocument).some(problem => /Aries player start lies outside/.test(problem)),
    "Astraeum reports an excluded spawn rather than repositioning it");

  let origin = await startService();
  const create = await request(`${origin}/api/projects`, "POST", {
    name: "Playable boundary persistence", author: "Disposable test", model: generic.MODEL,
    width: 2048, height: 2048
  });
  assert.equal(create.status, 201, create.body.error);
  const projectId = create.body.projectId;
  const mapId = create.body.mapId;
  const address = `${origin}/api/projects/${projectId}/maps/${mapId}`;
  const outsideSection = createGridRectangleBoundary({ x: 64, y: 0 }, { x: 65, y: 0 }, [
    { ...section(1, 0), document: create.body.document }
  ]).boundary;
  const rejected = await request(address, "PUT", { projectId, model: generic.MODEL,
    document: { ...create.body.document, playableBoundary: outsideSection } });
  assert.equal(rejected.status, 400, "single-section persistence rejects area in a missing section");
  const persistedBoundary = createGridRectangleBoundary({ x: 30, y: 30 }, { x: 33, y: 33 }, [
    { ...section(0, 0), document: create.body.document }
  ]).boundary;
  const saved = await request(address, "PUT", { projectId, model: generic.MODEL,
    document: { ...create.body.document, playableBoundary: persistedBoundary } });
  assert.equal(saved.status, 200, saved.body.error);
  let set = await request(`${origin}/api/projects/${projectId}/levels/${mapId}/sections`);
  assert.equal(set.status, 200);
  set = await request(`${origin}/api/projects/${projectId}/levels/${mapId}/sections`, "POST", {
    gridX: 1, gridY: 0, revision: set.body.revision
  });
  assert.equal(set.status, 201, set.body.error);
  assert.deepEqual(set.body.sections.find(item => item.mapId === mapId).document.playableBoundary, persistedBoundary,
    "adding a section does not expand or rewrite a custom boundary");
  await stopService();
  origin = await startService();
  set = await request(`${origin}/api/projects/${projectId}/levels/${mapId}/sections`);
  assert.equal(set.status, 200);
  assert.deepEqual(set.body.sections.find(item => item.mapId === mapId).document.playableBoundary, persistedBoundary,
    "versioned custom boundary survives service restart/reopen");
  console.log("Playable boundary geometry, editor history, runtime collision and persistence checks passed.");
} catch (error) {
  console.error(error);
  if (output) console.error(output);
  process.exitCode = 1;
} finally {
  await stopService();
  await rm(testDir, { recursive: true, force: true });
}
