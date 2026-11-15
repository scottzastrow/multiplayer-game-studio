import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as generic from "../../games/generic-grid-v1/src/project.js";
import * as tower from "../../games/astraeum-tower/src/project.js";
import { sectionOrigin, worldToSection, sectionToWorld } from "../world-coordinates.js";
import { extendTerrainStroke, isTerrainBrushAsset, planTerrainStroke, rasterizeTerrainSegment } from "../world-terrain.js";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
await mkdir(resolve(root, "studio", "data"), { recursive: true });
const directory = await mkdtemp(resolve(root, "studio", "data", "world-terrain-logic-"));
const evidence = [];
let failure;
const catalog = { ...generic.ASSET_CATALOG,
  "alternate-tile": { ...generic.ASSET_CATALOG["generic-tile"], color: "#ff6670" } };
const options = {
  assetId: "alternate-tile", assetCatalog: catalog, layerState: { locked: false, visible: true },
  createObject: (id, assetId, transform, order) => generic.createDesignObject(id, assetId, transform, order, catalog),
  validate: document => generic.validateFloorDocument(document, catalog)
};
const section = (gridX, gridY, id) => ({
  sectionId: `section-${id}`, mapId: `map-${id}`, gridX, gridY,
  document: generic.createDocument(`map-${id}`, `Section ${id}`)
});
const paint = (sections, cells, settings = options) => planTerrainStroke(sections, cells, settings);
function unchangedOnFailure(sections, cells, pattern, settings = options) {
  const before = structuredClone(sections);
  assert.throws(() => paint(sections, cells, settings), pattern);
  assert.deepEqual(sections, before, "rejected strokes cannot mutate any section");
}
try {
  for (const x of [-2049, -2048, -1, 0, 2047, 2048]) {
    const local = worldToSection(x, x);
    assert.equal(local.gridX, Math.floor(x / 2048));
    assert.equal(local.x, x - Math.floor(x / 2048) * 2048);
    assert.deepEqual(sectionToWorld(local.gridX, local.gridY, local.x, local.y), { x, y: x });
    const [cell] = rasterizeTerrainSegment({ x, y: x }, { x, y: x });
    assert.deepEqual(cell, { x: Math.floor(x / 32) * 32, y: Math.floor(x / 32) * 32 });
  }
  assert.throws(() => sectionOrigin(Number.MAX_SAFE_INTEGER, 0), RangeError);
  assert.throws(() => rasterizeTerrainSegment({ x: NaN, y: 0 }, { x: 0, y: 0 }), RangeError);
  assert.throws(() => rasterizeTerrainSegment({ x: 0, y: 0 }, { x: 1e9, y: 0 }), /working set/);
  const cells = rasterizeTerrainSegment({ x: -81, y: 337 }, { x: 80, y: 337 });
  assert.deepEqual(cells, [-96, -64, -32, 0, 32, 64].map(x => ({ x, y: 320 })));
  assert.deepEqual(rasterizeTerrainSegment({ x: 80, y: 337 }, { x: -81, y: 337 }), [...cells].reverse());
  const diagonal = rasterizeTerrainSegment({ x: -48, y: -48 }, { x: 48, y: 48 });
  assert.deepEqual(diagonal, [
    [-64, -64], [-32, -64], [-64, -32], [-32, -32],
    [0, -32], [-32, 0], [0, 0], [32, 0], [0, 32], [32, 32]
  ].map(([x, y]) => ({ x, y })));
  assert.deepEqual(new Set(rasterizeTerrainSegment({ x: 48, y: 48 }, { x: -48, y: -48 })
    .map(cell => `${cell.x},${cell.y}`)), new Set(diagonal.map(cell => `${cell.x},${cell.y}`)));
  const stroke = { cells: new Map(), last: null, error: null };
  for (const point of [{ x: -81, y: 337 }, { x: 80, y: 337 }, { x: -81, y: 337 }]) extendTerrainStroke(stroke, point);
  assert.equal(stroke.error, null);
  assert.deepEqual([...stroke.cells.values()], cells, "retracing deduplicates the entire gesture");
  evidence.push({ coordinatesAndRasterization: "passed", cells, diagonal });

  const sections = [section(-1, 0, "left"), section(0, 0, "right")];
  sections[0].document.objects.push(generic.createDesignObject("existing-tile", "generic-tile", { x: 2016, y: 320 }, 37));
  sections[0].document.objects.push(generic.createDesignObject("terrain-brush-1", "generic-marker", { x: 0, y: 0 }, 3));
  const before = structuredClone(sections);
  const updates = paint(sections, cells);
  assert.deepEqual(sections, before, "preflight is a pure operation");
  assert.equal(updates.length, 2);
  for (const update of updates) {
    const owner = sections.find(item => item.sectionId === update.sectionId);
    const terrain = update.document.objects.filter(object => object.type === "terrain-tile");
    assert.equal(terrain.length, 3);
    assert.equal(new Set(terrain.map(object => `${object.transform.x},${object.transform.y}`)).size, 3);
    assert.deepEqual(update.document.objects.filter(object => object.type !== "terrain-tile"),
      owner.document.objects.filter(object => object.type !== "terrain-tile"));
    assert.deepEqual(update.document.layers, owner.document.layers);
    assert.equal(update.document.cameraZoom, owner.document.cameraZoom);
    owner.document = update.document;
  }
  const replacement = sections[0].document.objects.find(object => object.id === "existing-tile");
  assert.equal(replacement.assetId, "alternate-tile");
  assert.equal(replacement.order, 37);
  assert.deepEqual(paint(sections, cells), [], "identical terrain is a history-free no-op");
  assert.deepEqual(paint(sections, [...cells, ...cells]), []);
  evidence.push({ replacementsPreservationAndNoOp: "passed", documents: sections.map(item => item.document) });

  unchangedOnFailure(sections, [...cells, { x: 2048, y: 320 }], /Section \(1, 0\).*missing/);
  unchangedOnFailure([sections[0], { ...sections[1], document: null }], cells, /unloaded/);
  unchangedOnFailure(sections, cells, /locked/, { ...options, layerState: { locked: true, visible: true } });
  unchangedOnFailure(sections, cells, /hidden/, { ...options, layerState: { locked: false, visible: false } });
  unchangedOnFailure(sections, [{ x: -1, y: 320 }], /32px/);
  unchangedOnFailure(sections, cells, /compatible/, { ...options, assetId: "generic-block" });
  const invalid = structuredClone(sections);
  invalid[1].document.bounds.width = 64;
  unchangedOnFailure(invalid, cells, /Section \(0, 0\).*dimensions/);
  assert.equal(isTerrainBrushAsset(generic.ASSET_CATALOG["generic-tile"]), true);
  assert.equal(isTerrainBrushAsset({ ...catalog["alternate-tile"], size: { width: 64, height: 32 } }), false);
  assert.equal(isTerrainBrushAsset({ ...catalog["alternate-tile"], pivot: { x: 16, y: 16 } }), false);
  evidence.push({ lockHiddenMissingIdentityAndAssetRejection: "passed" });

  const full = [section(-1, 0, "capacity-left"), section(0, 0, "capacity-right")];
  full[1].document.objects.push(...Array.from({ length: 3998 }, (_, i) =>
    generic.createDesignObject(`marker-${i}`, "generic-marker", { x: 32, y: 32 }, i)));
  unchangedOnFailure(full, cells, /Section \(0, 0\).*4000/);
  const replaceAtCapacity = structuredClone(full);
  replaceAtCapacity[1].document.objects.pop();
  replaceAtCapacity[1].document.objects.push(generic.createDesignObject("old-tile", "generic-tile", { x: 0, y: 320 }, 0));
  const accepted = paint(replaceAtCapacity, [{ x: -32, y: 320 }, { x: 0, y: 320 }]);
  assert.equal(accepted[1].document.objects.length, 4000, "replacements count before capacity validation");
  const allCells = Array.from({ length: 4096 }, (_, i) => ({ x: i % 64 * 32, y: Math.floor(i / 64) * 32 }));
  unchangedOnFailure([section(0, 0, "all-cells")], allCells, /4000/);
  unchangedOnFailure(sections, cells, /2 MB/, {
    ...options, assetId: "generic-tile",
    validate: document => ({ ...options.validate(document), name: "x".repeat(2_000_001) })
  });
  evidence.push({ perSectionCapacityReplacementAndSize: "passed" });

  const towerSections = [-1, 0].map((gridX, index) => ({
    sectionId: `tower-section-${index}`, mapId: `tower-map-${index}`, gridX, gridY: 0,
    document: { ...tower.createBlankDocument(`tower-map-${index}`, `Tower ${index}`),
      bounds: { width: 2048, height: 2048 } }
  }));
  const towerUpdates = paint(towerSections, cells.map(cell => ({ ...cell, y: 1600 })), {
    ...options, assetId: "floor-cobblestone", assetCatalog: tower.ASSET_CATALOG,
    createObject: tower.createDesignObject, validate: tower.validateFloorDocument
  });
  assert.equal(towerUpdates.length, 2);
  for (const update of towerUpdates) tower.validateFloorDocument(update.document);
  evidence.push({ bothModelValidators: "passed" });
  console.log("World terrain focused logic checks passed.");
} catch (error) {
  failure = error.stack ?? String(error);
  process.exitCode = 1;
  console.error(failure);
} finally {
  await writeFile(resolve(directory, "diagnostics.json"), JSON.stringify({ failure, evidence }, null, 2));
  console.log(`World terrain logic evidence: ${directory}`);
}
