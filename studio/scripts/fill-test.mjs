import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";
import { runInNewContext } from "node:vm";
import * as tower from "../../games/astraeum-tower/src/project.js";
import * as generic from "../../games/generic-grid-v1/src/project.js";
import { drawDesign, TILE_INDEX } from "../../games/astraeum-tower/src/design-render.js";
import { createLocalGame } from "../../games/sample/node_modules/@multiplayer-game/local-preview/dist/index.js";
import { fillRectangle, isBorderAsset, isRepeatableAsset, planFill } from "../world-fill.js";

register("../../games/astraeum-tower/scripts/combat-test-loader.mjs", import.meta.url);
const { createTowerGameModule, towerSettings } = await import("../../games/astraeum-tower/src/game.js");
const { genericPreview } = await import("../../games/generic-grid-v1/src/runtime.js");
const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
await mkdir(resolve(root, "studio", "data"), { recursive: true });
const evidenceDir = await mkdtemp(resolve(root, "studio", "data", "fill-logic-"));
const evidence = { evidenceDir, checks: [] };
const layers = Object.fromEntries(tower.DESIGN_LAYERS.map(layer => [layer.id, { locked: false, visible: true }]));
const section = (gridX, id, model = tower) => {
  const document = model === tower ? tower.createBlankDocument(`map-${id}`, id)
    : generic.createDocument(`map-${id}`, id);
  document.objects = [];
  return { sectionId: `section-${id}`, mapId: document.id, gridX, gridY: 0, document };
};
const settings = (model = tower, extra = {}) => ({
  assetId: model === tower ? "prop-barrel" : "generic-marker",
  assetCatalog: model.ASSET_CATALOG, layers: structuredClone(layers),
  createObject: model === generic
    ? (id, assetId, transform, order) => model.createDesignObject(id, assetId, transform, order)
    : model.createDesignObject,
  validate: model.validateFloorDocument, ...extra
});
const publish = (sections, updates) => {
  for (const update of updates) sections.find(section => section.sectionId === update.sectionId).document = update.document;
};
function rejection(sections, rectangle, options, pattern) {
  const before = structuredClone(sections);
  assert.throws(() => planFill(sections, rectangle, options), pattern);
  assert.deepEqual(sections, before, "all rejected preflights preserve all documents");
}
let failure;
try {
  const barrel = tower.ASSET_CATALOG["prop-barrel"];
  assert.deepEqual(barrel.size, { width: 22, height: 30 });
  assert.ok(isRepeatableAsset(barrel));
  for (const id of ["spawn-aries", "spawn-slime", "prop-stairs-rune", "item-chest", "collision-box"]) {
    assert.equal(isRepeatableAsset(tower.ASSET_CATALOG[id]), false, id);
  }
  assert.equal(isRepeatableAsset({ ...barrel, unique: true }), false);
  assert.ok(isBorderAsset(tower.ASSET_CATALOG["wall-damp-stone"]));
  assert.equal(isBorderAsset(barrel), false);
  const rect = fillRectangle({ x: 100, y: 120 }, { x: 188, y: 210 }, barrel);
  assert.deepEqual(rect, { x: 100, y: 120, width: 88, height: 90 });
  assert.deepEqual(fillRectangle({ x: 188, y: 210 }, { x: 100, y: 120 }, barrel), rect);
  const one = [section(0, "barrels")];
  const before = structuredClone(one);
  const plan = planFill(one, rect, settings());
  assert.equal(plan.count, 12, "22 x 30 footprints pack into 88 x 90 without 32px cells");
  assert.equal(plan.borderCount, 0, "intentional border generation is off by default");
  assert.deepEqual(one, before);
  const copies = plan.updates[0].document.objects;
  assert.deepEqual(copies[0], tower.createDesignObject(copies[0].id, "prop-barrel", { x: 111, y: 148 }, 0));
  assert.deepEqual(copies.at(-1).transform, { x: 177, y: 208 });
  assert.ok(copies.every(copy => copy.collision === null));
  const spaced = planFill(one, rect, settings(tower, { gapX: 10, gapY: 2, collision: true }));
  assert.equal(spaced.count, 6);
  assert.ok(spaced.updates[0].document.objects.every(copy =>
    JSON.stringify(copy.collision) === JSON.stringify(barrel.collisionBox)));
  evidence.checks.push({ nonCellBarrels: { count: plan.count, spaced: spaced.count }, propertiesAndCollision: "passed" });

  // Source-image resolution is deliberately unrelated to this asset's configured world footprint.
  const catalog = { ...tower.ASSET_CATALOG, "test-art": {
    ...barrel, size: { width: 11, height: 15 }, pivot: { x: 5, y: 14 },
    artwork: { image: "barrel", region: { x: 0, y: 0, width: 220, height: 300 } }
  } };
  const resolutionOptions = settings(tower, {
    assetId: "test-art", assetCatalog: catalog,
    createObject: (id, assetId, transform, order, options) =>
      tower.createDesignObject(id, assetId, transform, order, options, catalog),
    validate: document => tower.validateFloorDocument(document, catalog)
  });
  const resolutionBefore = structuredClone(catalog["test-art"]);
  const resolutionPlan = planFill(one, rect, resolutionOptions);
  assert.equal(resolutionPlan.count, 48);
  assert.deepEqual(catalog["test-art"], resolutionBefore, "the image region and configured size never change");
  evidence.checks.push({ sourceResolutionIndependence: "passed" });

  publish(one, plan.updates);
  const occupied = structuredClone(one);
  const skip = planFill(one, rect, settings());
  assert.equal(skip.count, 0);
  assert.equal(skip.skipped, 12);
  assert.deepEqual(skip.updates, []);
  const allow = planFill(one, rect, settings(tower, { overlap: "allow" }));
  assert.equal(allow.count, 12);
  assert.equal(allow.overlaps, 12);
  assert.equal(allow.updates[0].document.objects.length, 24);
  assert.deepEqual(allow.updates[0].document.objects.slice(0, 12), occupied[0].document.objects,
    "existing object identities, order, transforms and collision remain exact");
  assert.equal(new Set(allow.updates[0].document.objects.map(object => object.id)).size, 24);
  assert.deepEqual(one, occupied);
  const withCollision = structuredClone(one);
  withCollision[0].document.objects[0].collision = { ...barrel.collisionBox };
  assert.deepEqual(planFill(withCollision, rect, settings()).updates, [],
    "skipping existing copies preserves their authored optional collision");
  evidence.checks.push({ skipAndAllowSameLayerOverlaps: "passed" });

  const both = [section(-1, "west"), section(0, "east")];
  const seamRect = { x: -32, y: 160, width: 96, height: 64 };
  const seamBefore = structuredClone(both);
  const seamPlan = planFill(both, seamRect, settings(tower, { gapX: 10, gapY: 2 }));
  assert.equal(seamPlan.count, 6);
  assert.equal(seamPlan.updates.length, 2);
  assert.deepEqual(both, seamBefore);
  publish(both, seamPlan.updates);
  assert.deepEqual(both.map(s => s.document.objects.length), [2, 4]);
  assert.deepEqual(both[0].document.objects[0].transform, { x: 2027, y: 188 });
  assert.deepEqual(both[1].document.objects[0].transform, { x: 11, y: 188 });
  for (const s of both) for (const object of s.document.objects) {
    const bounds = tower.objectBounds(object);
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 2048);
  }
  const after = structuredClone(both);
  publish(both, seamBefore.map(s => ({ sectionId: s.sectionId, document: s.document })));
  assert.deepEqual(both, seamBefore, "one document-set history record restores all owning sections");
  publish(both, after.map(s => ({ sectionId: s.sectionId, document: s.document })));
  assert.deepEqual(both, after, "redo restores the complete set");
  const straddlers = planFill([section(-1, "west"), section(0, "east")], seamRect, settings());
  assert.equal(straddlers.seamSkipped, 2);
  assert.equal(straddlers.count, 6, "straddling slots are reported and not split or resized");
  evidence.checks.push({ crossSectionAtomicDocumentsAndHistoryShape: "passed", seamSkipped: straddlers.seamSkipped });

  const borderSections = [section(0, "border")];
  const borderRect = { x: 128, y: 128, width: 128, height: 128 };
  const borderPlan = planFill(borderSections, borderRect, settings(tower, {
    assetId: "floor-cobblestone", borderAssetId: "wall-damp-stone"
  }));
  assert.equal(borderPlan.count, 16);
  assert.equal(borderPlan.borderCount, 12, "corners occur once");
  const borderObjects = borderPlan.updates[0].document.objects;
  assert.equal(borderObjects.filter(object => object.type === "terrain-tile").length, 4);
  assert.equal(borderObjects.filter(object => object.type === "wall").length, 12);
  assert.ok(borderObjects.filter(object => object.type === "wall").every(object => object.collision));
  const borderless = planFill(borderSections, borderRect, settings(tower, { assetId: "floor-cobblestone" }));
  assert.equal(borderless.count, 16);
  assert.ok(borderless.updates[0].document.objects.every(object => object.type === "terrain-tile"));
  const mixed = planFill(borderSections, borderRect, settings(tower, { borderAssetId: "wall-damp-stone" }));
  assert.equal(mixed.borderCount, 12);
  assert.equal(mixed.count - mixed.borderCount, 4, "barrels use their own 22 x 30 footprint inside the border");
  const seamBorder = planFill([section(-1, "west"), section(0, "east")],
    { x: -64, y: 128, width: 128, height: 128 },
    settings(tower, { assetId: "floor-cobblestone", borderAssetId: "wall-damp-stone" }));
  assert.equal(seamBorder.borderCount, 12);
  assert.ok(seamBorder.placements.filter(p => p.x === -32 || p.x === 0)
    .filter(p => p.y === 160 || p.y === 192).every(p => !p.border), "no artificial seam border");
  evidence.checks.push({ separateOptionalBorderAndFootprintInterior: "passed" });

  const locked = settings(tower, { borderAssetId: "wall-damp-stone" });
  locked.layers.walls.locked = true;
  rejection(borderSections, borderRect, locked, /locked/);
  const fillLocked = settings();
  fillLocked.layers.props.locked = true;
  rejection(both, seamRect, fillLocked, /locked/);
  const hidden = settings();
  hidden.layers.props.visible = false;
  rejection(both, seamRect, hidden, /hidden/);
  rejection([both[0]], seamRect, settings(), /missing/);
  rejection([both[0], { ...both[1], document: null }], seamRect, settings(), /unloaded/);
  rejection(both, seamRect, settings(tower, { gapX: -1 }), /Spacing/);
  rejection(both, seamRect, settings(tower, { gapY: NaN }), /Spacing/);
  rejection(both, seamRect, settings(tower, { overlap: "replace" }), /Skip or Allow/);
  rejection(both, seamRect, settings(tower, { assetId: "spawn-slime" }), /cannot repeat/);
  rejection(both, seamRect, settings(tower, { borderAssetId: "prop-barrel" }), /border asset/);
  rejection(both, { x: -32, y: 0, width: 4096, height: 64 }, settings(), /two-section/);
  rejection(borderSections, { x: 0, y: 0, width: 2, height: 2 }, settings(), /No complete/);
  const small = [section(0, "small", generic)];
  small[0].document.bounds = { width: 64, height: 64 };
  rejection(small, { x: 32, y: 32, width: 64, height: 64 }, settings(generic), /saved map bounds/);
  const invalid = structuredClone(both);
  invalid[1].document.id = "wrong-map";
  rejection(invalid, seamRect, settings(), /identity/);
  const full = [section(-1, "west"), section(0, "full")];
  full[1].document.objects = Array.from({ length: 4000 }, (_, i) =>
    tower.createDesignObject(`existing-${i}`, "prop-barrel", { x: 111, y: 148 }, i));
  rejection(full, seamRect, settings(tower, { gapX: 10, gapY: 2 }), /4000/);
  rejection(borderSections, { x: 0, y: 0, width: 2048, height: 2048 }, resolutionOptions, /8192/);
  const serializedLimit = settings(tower, { validate: document => {
    tower.validateFloorDocument(document);
    if (document.objects.length) return { ...document, testPadding: "x".repeat(2_000_000) };
    return document;
  } });
  rejection(borderSections, borderRect, serializedLimit, /2 MB/);
  for (const model of [generic, tower]) {
    const s = [section(0, model.MODEL ?? "tower", model)];
    const assetId = model === generic ? "generic-tile" : "floor-cobblestone";
    const tileOptions = settings(model, { assetId });
    const tileRect = fillRectangle({ x: 128, y: 128 }, { x: 160, y: 160 }, model.ASSET_CATALOG[assetId]);
    assert.equal(planFill(s, tileRect, tileOptions).count, 4, "terrain still includes both endpoint cells");
    publish(s, planFill(s, tileRect, tileOptions).updates);
    assert.deepEqual(planFill(s, tileRect, tileOptions).updates, [], "identical terrain is a no-op");
    assert.deepEqual(planFill(s, tileRect, { ...tileOptions, gapX: NaN }).updates, [],
      "disabled object-gap controls do not block terrain fills");
  }
  rejection([section(0, "forced", generic)], { x: 1, y: 1, width: 64, height: 64 },
    settings(generic, { assetId: "generic-block" }), /configured grid alignment/);
  evidence.checks.push({ locksBoundsCapacitySizeMissingInvalidAndNoOp: "passed" });

  const main = await readFile(resolve(root, "studio", "src", "main.js"), "utf8");
  const functionSource = name => {
    const start = main.indexOf(`function ${name}(`);
    assert.ok(start >= 0);
    const end = main.indexOf("\nfunction ", start + 1);
    assert.ok(end > start);
    return main.slice(start, end);
  };
  const editor = {
    state: { sections: structuredClone(seamBefore), undo: [], redo: [], selectedIds: new Set(),
      activeSectionId: seamBefore[0].sectionId, scene: {}, fillSettings: { gapX: 10, gapY: 2 },
      layers: structuredClone(layers), pointerMode: null },
    ASSET_CATALOG: tower.ASSET_CATALOG, HISTORY_LIMIT: 100,
    createDesignObject: tower.createDesignObject, validateFloorDocument: tower.validateFloorDocument,
    planFill, structuredClone, isPlaying: () => false, isSelectable: () => true,
    refreshChrome() {}, refreshAfterOperation() {}, setStatus() {}
  };
  editor.activeSection = () => editor.state.sections.find(s => s.sectionId === editor.state.activeSectionId);
  editor.setSelection = ids => { editor.state.selectedIds = new Set(ids); };
  const begin = () => {
    editor.state.document = editor.activeSection().document;
    editor.state.fillPreview = { assetId: "prop-barrel", rectangle: seamRect,
      before: editor.state.sections.map(({ sectionId, document }) => ({ sectionId, document })) };
  };
  begin();
  const controller = ["pushSectionUndo", "commitToolPreview", "fillPlan", "applyFill", "restoreHistory", "undo", "redo"]
    .map(functionSource).join("\n");
  runInNewContext(`${controller}\napplyFill();`, editor);
  assert.equal(editor.state.undo.length, 1, "actual main-editor Apply pushes exactly one history entry");
  const applied = structuredClone(editor.state.sections);
  assert.deepEqual(applied, after);
  runInNewContext(`${controller}\nundo();`, editor);
  assert.deepEqual(editor.state.sections, seamBefore, "actual editor Undo restores both section documents");
  assert.equal(editor.state.undo.length, 0);
  runInNewContext(`${controller}\nredo();`, editor);
  assert.deepEqual(editor.state.sections, applied, "actual editor Redo restores both section documents");
  begin();
  runInNewContext(`${controller}\napplyFill();`, editor);
  assert.equal(editor.state.undo.length, 1, "skipped-overlap no-op adds no history");
  begin();
  editor.state.layers.props.locked = true;
  runInNewContext(`${controller}\napplyFill();`, editor);
  assert.match(editor.state.fillPreview.error, /locked/);
  assert.deepEqual(editor.state.sections, applied, "Apply revalidates locks after preview");
  assert.equal(editor.state.undo.length, 1);
  editor.state.layers.props.locked = false;
  begin();
  editor.activeSection().document = structuredClone(editor.activeSection().document);
  const intervening = structuredClone(editor.state.sections);
  runInNewContext(`${controller}\napplyFill();`, editor);
  assert.match(editor.state.fillPreview.error, /changed after this gesture/);
  assert.deepEqual(editor.state.sections, intervening);
  assert.equal(editor.state.undo.length, 1, "stale previews cannot overwrite intervening edits or their history");
  evidence.checks.push({ actualMainEditorApplyUndoRedoLockAndStalePreflight: "passed (isolated controller, not browser UI)" });

  const isolated = section(0, "wang").document;
  isolated.objects = [tower.createDesignObject("only-floor", "floor-cobblestone", { x: 128, y: 128 }, 0)];
  const isolatedBefore = structuredClone(isolated);
  const drawCalls = [];
  drawDesign({ fillRect() {}, drawImage(...args) { drawCalls.push(args); } }, { wang: "wang-image" }, isolated,
    { decorations: false });
  assert.equal(drawCalls.length, 4);
  const tileIndices = drawCalls.map(([, sx, sy]) => sy / 32 * 4 + sx / 32);
  assert.deepEqual(new Set(tileIndices), new Set(["0001", "0010", "0100", "1000"].map(bits => TILE_INDEX[bits])));
  assert.deepEqual(isolated, isolatedBefore);
  assert.deepEqual(tower.collisionRects(isolated), []);
  assert.equal(isolated.objects.filter(object => object.type === "wall").length, 0);
  evidence.checks.push({ apparentBorder: "four Wang corner tiles; no generated walls or object collision", tileIndices,
    caveat: "Astraeum's original-area absent floor cells are separately blocked by floorDocumentGrid; visual edges add no blockers." });

  evidence.runtime = [];
  for (const model of [generic, tower]) {
    const document = model === generic ? generic.createDocument("play-fixture", "Play fixture") : tower.createFloorDocument();
    const original = structuredClone(document);
    const config = model === generic ? genericPreview(document) : {
      moduleFactory: createTowerGameModule(document), settings: towerSettings, map: tower.createFloorMap(document),
      seed: 1, roster: [{ accountId: "aries", username: "Aries", joinedOrder: 0 }],
      viewer: { accountId: "aries", role: "player" }
    };
    const game = await createLocalGame(config);
    try {
      const before = structuredClone(game.snapshot);
      assert.equal(game.sendInput(config.viewer.accountId, { type: "move", x: 0, y: 1 }), true);
      for (let tick = 0; tick < 8; tick++) game.step();
      const after = structuredClone(game.snapshot);
      const position = snapshot => model === generic ? snapshot.players[0].position : snapshot.player;
      assert.equal(position(after).x, position(before).x);
      assert.equal(position(after).y - position(before).y, 32, "eight movement ticks advance exactly 32 world pixels");
      evidence.runtime.push({ model: model.MODEL ?? "astraeum-floor-v2", before, after });
    } finally { game.dispose(); }
    assert.deepEqual(document, original);
    const missing = { ...document, objects: document.objects.filter(object => object.type !== "spawn") };
    assert.ok(model.playStartProblems(missing).length);
  }
  evidence.checks.push({ installedRuntimeAdapters: "created and stepped both single maps; NOT main-editor UI acceptance" });
} catch (error) {
  failure = error;
  evidence.failure = error.stack;
} finally {
  await writeFile(resolve(evidenceDir, "diagnostics.json"), JSON.stringify(evidence, null, 2));
}
if (failure) {
  console.error(`Fill logic failed. Evidence: ${evidenceDir}`);
  throw failure;
}
console.log(`Fill logic passed. Evidence: ${evidenceDir}`);
