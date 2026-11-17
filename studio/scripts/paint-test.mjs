import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as generic from "../../games/generic-grid-v1/src/project.js";
import * as tower from "../../games/astraeum-tower/src/project.js";
import { importedAssetDefinition } from "../project-assets.js";
import { isPaintBrushAsset, planPaintStroke } from "../world-paint.js";
import { extendTerrainStroke, planTerrainStroke } from "../world-terrain.js";
import { ASTRAEUM_PROJECT_ID, ASTRAEUM_FLOOR_1_MAP_ID } from "../project-identity.js";

const root = resolve(import.meta.dirname, "..", "..");
await mkdir(resolve(root, "studio", "data"), { recursive: true });
const directory = await mkdtemp(resolve(root, "studio", "data", "paint-check-"));
const evidence = { checks: [], nativeBrowser: "Not run; blocked browser harness deliberately not launched." };
const layers = Object.fromEntries(tower.DESIGN_LAYERS.map(layer => [layer.id, { locked: false, visible: true }]));
const section = (model, x, id) => {
  const document = model === generic ? model.createDocument(`paint-${id}`, id)
    : model.createBlankDocument(`paint-${id}`, id);
  document.bounds = { width: 2048, height: 2048 };
  document.objects = [];
  return { sectionId: id, mapId: document.id, gridX: x, gridY: 0, document };
};
const options = (model, assetId, extra = {}) => ({
  assetId, assetCatalog: model.ASSET_CATALOG, layers,
  createObject: model === generic
    ? (id, asset, transform, order) => model.createDesignObject(id, asset, transform, order)
    : model.createDesignObject,
  validate: model.validateFloorDocument, ...extra
});
const stroke = (points, brushSize = 1) => {
  const result = { cells: new Map(), brushSize };
  for (const [x, y] of points) extendTerrainStroke(result, { x, y });
  assert.equal(result.error, undefined);
  return [...result.cells.values()];
};
const publish = (sections, plan) => {
  for (const update of plan.updates) sections.find(section => section.sectionId === update.sectionId).document = update.document;
};
function reject(sections, cells, settings, pattern) {
  const before = structuredClone(sections);
  assert.throws(() => planPaintStroke(sections, cells, settings), pattern);
  assert.deepEqual(sections, before, "invalid preflight never changes any document");
}
let service, output = "";
async function start() {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  service = spawn(process.execPath, ["--no-warnings", resolve(root, "studio", "server.mjs")], {
    cwd: root, env: { ...process.env, STUDIO_API_PORT: String(port),
      STUDIO_DATABASE_PATH: relative(root, resolve(directory, "paint.sqlite")),
      STUDIO_GAMES_PATH: relative(root, resolve(directory, "games")) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  service.stdout.on("data", chunk => { output += chunk; });
  service.stderr.on("data", chunk => { output += chunk; });
  const origin = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (service.exitCode !== null) throw new Error(`Disposable API exited: ${output}`);
    try {
      const response = await fetch(`${origin}/api/projects/${ASTRAEUM_PROJECT_ID}/maps/${ASTRAEUM_FLOOR_1_MAP_ID}`);
      if (response.ok) return origin;
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
    await delay(100);
  }
  throw new Error(`Disposable API did not become ready: ${output}`);
}
async function stop() {
  if (!service || service.exitCode !== null || service.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Disposable API failed to stop.")), 5000);
    service.once("exit", () => { clearTimeout(timer); resolve(); });
    service.kill("SIGTERM");
  });
}
async function request(origin, path, method = "GET", body) {
  const response = await fetch(`${origin}${path}`, {
    method, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {})
  });
  const result = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(result)}`);
  return result;
}

try {
  for (const model of [generic, tower]) {
    const sections = [section(model, -1, "west"), section(model, 0, "east")];
    const id = model === generic ? "generic-tile" : "floor-cobblestone";
    const cells = stroke([[-257, 513], [257, 513]], 8);
    const settings = options(model, id);
    const dense = planPaintStroke(sections, cells, settings);
    assert.deepEqual(dense.updates, planTerrainStroke(sections, cells, {
      ...settings, layerState: layers.terrain
    }), "100% / gap 0 must match the old continuous terrain planner byte-for-byte");
    const sparse = planPaintStroke(sections, cells, { ...settings, density: 27, seed: 923 });
    assert.ok(sparse.placements.length > 0 && sparse.placements.length < dense.placements.length / 2);
    assert.deepEqual(sparse, planPaintStroke(sections, cells, { ...settings, density: 27, seed: 923 }));
    const retraced = stroke([[-257, 513], [257, 513], [-257, 513], [257, 513]], 8);
    assert.deepEqual(planPaintStroke(sections, retraced, { ...settings, density: 27, seed: 923 }), sparse);
    assert.deepEqual(new Set(planPaintStroke(sections, [...cells].reverse(), {
      ...settings, density: 27, seed: 923
    }).placements.map(p => `${p.x},${p.y}`)), new Set(sparse.placements.map(p => `${p.x},${p.y}`)));
    reject(sections, cells, { ...settings, layers: { ...layers, terrain: { locked: true, visible: true } } }, /unlock/);
    reject(sections, cells, { ...settings, layers: { ...layers, terrain: { locked: false, visible: false } } }, /show/);
    reject(sections, [...cells, { x: 4096, y: 0 }], settings, /missing/);
    reject(sections, cells, { ...settings, density: 0 }, /Density/);
    reject(sections, cells, { ...settings, spacing: -1 }, /spacing/);
    evidence.checks.push({ model: model.MODEL ?? "astraeum-floor-v2", continuousFloor: "exact",
      deterministicSparse: sparse.placements.length, dense: dense.placements.length, retracingAndAtomicLocks: "passed" });
  }
  const barrels = [section(tower, -1, "west"), section(tower, 0, "east")];
  const cells = stroke([[-129, 321], [129, 321]], 4);
  const settings = options(tower, "prop-barrel", { spacing: 10, seed: 13 });
  const plan = planPaintStroke(barrels, cells, settings);
  assert.equal(plan.updates.length, 2);
  assert.ok(plan.placements.every(p => p.width === 22 && p.height === 30));
  for (const [index, a] of plan.placements.entries()) {
    for (const b of plan.placements.slice(index + 1)) {
      assert.ok(a.x + a.width + 10 <= b.x || b.x + b.width + 10 <= a.x ||
        a.y + a.height + 10 <= b.y || b.y + b.height + 10 <= a.y);
    }
  }
  assert.ok(plan.updates.every(update => update.document.objects.every(object =>
    object.layer === "props" && object.collision === null)));
  publish(barrels, plan);
  assert.deepEqual(planPaintStroke(barrels, cells, settings).updates, [], "existing footprint spacing prevents a second pass stacking");
  const westEdge = [section(tower, -1, "west"), section(tower, 0, "east")];
  westEdge[0].document.objects.push(tower.createDesignObject("edge-barrel", "prop-barrel", { x: 2037, y: 348 }, 77));
  const edgePlan = planPaintStroke(westEdge, [{ x: 0, y: 320 }], options(tower, "prop-barrel", { spacing: 12 }));
  assert.ok(edgePlan.skipped > 0, "existing neighbor-section artwork enforces the gap across a seam");
  assert.equal(westEdge[0].document.objects[0].order, 77);
  const defaultSeam = planPaintStroke([section(tower, 0, "west"), section(tower, 1, "east")],
    stroke([[2017, 337], [2081, 337]], 4), options(tower, "prop-barrel"));
  assert.equal(defaultSeam.updates.length, 2, "default non-32px props can stroke across section seams");
  assert.ok(defaultSeam.seamSkipped > 0, "Fill-compatible seam slots are skipped, never split, resized or reassigned");
  const full = [section(generic, -1, "west"), section(generic, 0, "east")];
  full[1].document.objects = Array.from({ length: 4000 }, (_, i) =>
    generic.createDesignObject(`occupied-${i}`, "generic-marker", { x: 1024, y: 1024 }, i));
  reject(full, [{ x: -32, y: 320 }, { x: 0, y: 320 }], options(generic, "generic-block"), /4000/);
  const wallPlan = planPaintStroke([section(tower, 0, "wall")], [{ x: 320, y: 320 }], options(tower, "wall-damp-stone"));
  assert.deepEqual(wallPlan.updates[0].document.objects[0].collision, tower.ASSET_CATALOG["wall-damp-stone"].collisionBox);
  const imported = importedAssetDefinition({ name: "Static art", width: 70, height: 45, category: "prop" });
  assert.ok(isPaintBrushAsset(imported));
  for (const category of ["character", "item"]) assert.equal(isPaintBrushAsset(importedAssetDefinition({ category })), false);
  assert.equal(isPaintBrushAsset({ ...importedAssetDefinition({ category: "character" }), paint: "static" }), false);
  for (const id of ["spawn-aries", "spawn-slime", "prop-stairs-rune", "item-chest", "collision-box"]) {
    assert.equal(isPaintBrushAsset(tower.ASSET_CATALOG[id]), false, id);
  }
  assert.equal(isPaintBrushAsset({ ...tower.ASSET_CATALOG["prop-barrel"], paint: undefined }), false);
  const catalog = { ...tower.ASSET_CATALOG, "static-art": imported };
  const importedPlan = planPaintStroke([section(tower, 0, "imported")], stroke([[257, 257], [513, 257]], 8), {
    ...options(tower, "static-art"), assetCatalog: catalog, spacing: 7,
    createObject: (id, asset, transform, order) => tower.createDesignObject(id, asset, transform, order, {}, catalog),
    validate: document => tower.validateFloorDocument(document, catalog)
  });
  assert.ok(importedPlan.placements.length > 1);
  assert.ok(importedPlan.placements.every(p => p.width === 70 && p.height === 45));
  evidence.checks.push({ non32FootprintsSpacingCrossSeamExistingAndStroke: "passed",
    collisionDefaultsLayerOrderCapacityAndExplicitCapabilities: "passed" });

  let origin = await start();
  const created = await request(origin, "/api/projects", "POST", {
    name: "Disposable Paint", author: "Fixture", width: 2048, height: 2048, model: generic.MODEL
  });
  const path = `/api/projects/${created.projectId}/levels/${created.mapId}/sections`;
  const initial = await request(origin, path);
  const saved = await request(origin, path, "POST", { gridX: 1, gridY: 0, revision: initial.revision });
  const draft = planPaintStroke(saved.sections, stroke([[2017, 337], [2081, 337]], 4),
    options(generic, "generic-marker", { density: 37, spacing: 0, seed: 77 }));
  assert.equal(draft.updates.length, 2);
  assert.deepEqual(await request(origin, path), saved, "preflight remains draft-only before Save");
  const after = await request(origin, path, "PUT", {
    operationId: "paint-save", revision: saved.revision,
    sections: saved.sections.map(section => ({ sectionId: section.sectionId, revision: section.revision,
      document: draft.updates.find(update => update.sectionId === section.sectionId)?.document ?? section.document }))
  });
  await stop();
  origin = await start();
  assert.deepEqual(await request(origin, path), after, "atomic multi-section Paint Save survives service restart/reopen");
  evidence.checks.push({ disposableSQLiteSaveRestartReopen: "passed" });
  console.log("Paint focused logic and disposable SQLite Save/reopen checks passed.");
} catch (error) {
  evidence.failure = error.stack;
  process.exitCode = 1;
  console.error(error);
} finally {
  await stop();
  await writeFile(resolve(directory, "diagnostics.json"), JSON.stringify(evidence, null, 2));
  await writeFile(resolve(directory, "api.log"), output);
  console.log(`Paint evidence: ${directory}`);
}
