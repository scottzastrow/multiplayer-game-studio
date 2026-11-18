import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as generic from "../../games/generic-grid-v1/src/project.js";
import * as tower from "../../games/astraeum-tower/src/project.js";
import { sectionOrigin, worldToSection, sectionToWorld } from "../world-coordinates.js";
import { extendTerrainStroke, isTerrainBrushAsset, planTerrainStroke, rasterizeTerrainSegment,
  terrainBrushFootprint, terrainRectangle, terrainRectangleCells } from "../world-terrain.js";

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

  for (const size of [1, 2, 4, 8]) {
    const point = { x: -1, y: 337 };
    const footprint = terrainBrushFootprint(point, size);
    const offset = Math.floor((size - 1) / 2) * 32;
    assert.deepEqual(footprint, { x: -32 - offset, y: 320 - offset, width: size * 32, height: size * 32 });
    const brush = { cells: new Map(), brushSize: size };
    extendTerrainStroke(brush, point);
    assert.equal(brush.cells.size, size * size);
    assert.deepEqual([...brush.cells.values()], Array.from({ length: size * size }, (_, i) =>
      ({ x: footprint.x + (i % size) * 32, y: footprint.y + Math.floor(i / size) * 32 })));
    extendTerrainStroke(brush, { x: 63, y: 337 });
    assert.equal(brush.cells.size, (size + 2) * size, "fast strokes sweep the complete footprint without gaps");
    extendTerrainStroke(brush, point);
    assert.equal(brush.cells.size, (size + 2) * size, "large retraced brushes deduplicate");
    assert.equal(brush.error, undefined);
  }
  for (const size of [0, -1, 3, 16, NaN, "2"]) {
    assert.throws(() => terrainBrushFootprint({ x: 0, y: 0 }, size), /Brush size/);
  }
  const tooLarge = { cells: new Map(), brushSize: 8 };
  extendTerrainStroke(tooLarge, { x: 0, y: 0 });
  extendTerrainStroke(tooLarge, { x: 32768, y: 0 });
  assert.match(tooLarge.error, /working set/);
  evidence.push({ paintBrushSizesFootprintsAndSweeps: "passed" });

  const rectangle = terrainRectangle({ x: 65, y: 369 }, { x: -33, y: 321 });
  assert.deepEqual(rectangle, { x: -64, y: 320, columns: 5, rows: 2, cellCount: 10, sectionCount: 2 });
  assert.deepEqual(terrainRectangle({ x: -33, y: 321 }, { x: 65, y: 369 }), rectangle);
  assert.deepEqual([...terrainRectangleCells(rectangle)], Array.from({ length: 10 }, (_, i) =>
    ({ x: -64 + (i % 5) * 32, y: 320 + Math.floor(i / 5) * 32 })));
  assert.deepEqual(terrainRectangle({ x: -2048, y: -1 }, { x: -2048, y: -1 }),
    { x: -2048, y: -32, columns: 1, rows: 1, cellCount: 1, sectionCount: 1 });
  assert.equal(terrainRectangle({ x: -1, y: -1 }, { x: 0, y: 0 }).sectionCount, 4);
  assert.throws(() => terrainRectangle({ x: Infinity, y: 0 }, { x: 0, y: 0 }), RangeError);
  assert.throws(() => [...terrainRectangleCells(terrainRectangle({ x: 0, y: 0 }, { x: 4096, y: 2048 }))], /working set/);
  evidence.push({ rectangleGeometry: "passed", rectangle });

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
  const fillSections = [section(-1, 0, "fill-left"), section(0, 0, "fill-right")];
  fillSections[0].document.objects.push(
    generic.createDesignObject("replace-me", "generic-tile", { x: 2016, y: 320 }, 12),
    generic.createDesignObject("keep-me", "generic-marker", { x: 2016, y: 320 }, 13));
  const fillBefore = structuredClone(fillSections);
  const fillUpdates = paint(fillSections, terrainRectangleCells(rectangle));
  assert.deepEqual(fillSections, fillBefore);
  assert.equal(fillUpdates.length, 2);
  const replaced = fillUpdates[0].document.objects.find(item => item.id === "replace-me");
  assert.equal(replaced.assetId, "alternate-tile");
  assert.equal(replaced.order, 12);
  assert.deepEqual(fillUpdates[0].document.objects.find(item => item.id === "keep-me"),
    fillSections[0].document.objects.find(item => item.id === "keep-me"));
  assert.equal(fillUpdates.reduce((sum, item) => sum + item.document.objects.filter(o => o.type === "terrain-tile").length, 0), 10);
  unchangedOnFailure(fillSections, terrainRectangleCells(terrainRectangle({ x: -32, y: 0 }, { x: 2048, y: 0 })), /Section \(1, 0\).*missing/);
  unchangedOnFailure(fillSections, terrainRectangleCells(rectangle), /locked/, { ...options, layerState: { locked: true, visible: true } });
  evidence.push({ replacementsPreservationAndNoOp: "passed", documents: sections.map(item => item.document) });

  unchangedOnFailure(sections, [...cells, { x: 2048, y: 320 }], /Section \(1, 0\).*missing/);
  unchangedOnFailure([sections[0], { ...sections[1], document: null }], cells, /unloaded/);
  unchangedOnFailure(sections, cells, /locked/, { ...options, layerState: { locked: true, visible: true } });
  unchangedOnFailure(sections, cells, /hidden/, { ...options, layerState: { locked: false, visible: false } });
  unchangedOnFailure(sections, [{ x: -1, y: 320 }], /32px/);
  unchangedOnFailure(sections, cells, /compatible/, { ...options, assetId: "generic-block" });
  const invalid = structuredClone(sections);
  invalid[1].document.bounds.width = 65;
  unchangedOnFailure(invalid, cells, /Section \(0, 0\).*dimensions/);
  assert.equal(isTerrainBrushAsset(generic.ASSET_CATALOG["generic-tile"]), true);
  assert.equal(isTerrainBrushAsset({ ...catalog["alternate-tile"], size: { width: 64, height: 32 } }), false);
  assert.equal(isTerrainBrushAsset({ ...catalog["alternate-tile"], pivot: { x: 16, y: 16 } }), false);
  evidence.push({ lockHiddenMissingIdentityAndAssetRejection: "passed" });

  for (const [model, assetId] of [[generic, "generic-tile"], [tower, "floor-cobblestone"]]) {
    const saved = model === generic ? generic.createDocument("map-legacy", "Saved small map", { width: 640, height: 480 })
      : model.createFloorDocument();
    const small = [{ sectionId: "saved-section", mapId: saved.id, gridX: 0, gridY: 0,
      document: { ...saved, objects: saved.objects.filter(object =>
        object.type !== "terrain-tile" || object.transform.x !== 256 || object.transform.y !== 256) } }];
    const settings = { assetId, assetCatalog: model.ASSET_CATALOG, layerState: { locked: false, visible: true },
      createObject: model.createDesignObject, validate: model.validateFloorDocument };
    const smallBefore = structuredClone(small);
    const [painted] = paint(small, [{ x: 256, y: 256 }], settings);
    assert.ok(painted);
    assert.deepEqual(painted.document.bounds, saved.bounds, "painting a saved smaller map never resizes it");
    assert.deepEqual(painted.document.objects.filter(o => o.type !== "terrain-tile"),
      saved.objects.filter(o => o.type !== "terrain-tile"));
    const [filled] = paint(small,
      terrainRectangleCells(terrainRectangle({ x: 256, y: 256 }, { x: 288, y: 288 })), settings);
    assert.ok(filled.document.objects.some(o => o.type === "terrain-tile" && o.transform.x === 256 && o.transform.y === 256));
    assert.deepEqual(small, smallBefore);
    unchangedOnFailure(small, [{ x: 256, y: 256 }, { x: saved.bounds.width, y: 0 }], /outside.*bounds/, settings);
    unchangedOnFailure(small, terrainRectangleCells(terrainRectangle(
      { x: saved.bounds.width - 32, y: 0 }, { x: saved.bounds.width, y: 32 })), /outside.*bounds/, settings);
  }
  evidence.push({ savedSmallerMapPaintFillAndBoundsPreservation: "passed" });

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
  unchangedOnFailure([section(0, 0, "rectangle-capacity")],
    terrainRectangleCells(terrainRectangle({ x: 0, y: 0 }, { x: 2047, y: 2047 })), /4000/);
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
  const towerOptions = {
    ...options, assetId: "floor-cobblestone", assetCatalog: tower.ASSET_CATALOG,
    createObject: tower.createDesignObject, validate: tower.validateFloorDocument
  };
  const towerUpdates = paint(towerSections, cells.map(cell => ({ ...cell, y: 1600 })), towerOptions);
  assert.equal(towerUpdates.length, 2);
  for (const update of towerUpdates) tower.validateFloorDocument(update.document);
  const towerFill = paint(towerSections,
    terrainRectangleCells(terrainRectangle({ x: -33, y: 1601 }, { x: 33, y: 1633 })), towerOptions);
  assert.equal(towerFill.length, 2);
  for (const update of towerFill) tower.validateFloorDocument(update.document);
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
