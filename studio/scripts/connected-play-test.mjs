import assert from "node:assert/strict";
import { register } from "node:module";
import { connectedFixture } from "./connected-play-fixtures.mjs";
import * as generic from "../../games/generic-grid-v1/src/project.js";
import * as tower from "../../games/astraeum-tower/src/project.js";
import { ASTRAEUM_MODEL } from "../project-identity.js";
import { createGridRectangleBoundary } from "../playable-boundaries.js";

register("./public-runtime-loader.mjs", import.meta.url);
const { createLocalGame } = await import("@multiplayer-game/local-preview");
const { createConnectedPreview, connectedCamera, connectedSkin } = await import("../extensions/connected-play.js");
const results = [];

for (const model of [generic.MODEL, ASTRAEUM_MODEL]) {
  for (const axis of ["x", "y"]) {
    const sections = connectedFixture(model, axis);
    const before = structuredClone(sections);
    const assetCatalog = model === generic.MODEL ? generic.ASSET_CATALOG : tower.ASSET_CATALOG;
    const preview = createConnectedPreview(sections, { mapId: sections[0].mapId, model, assetCatalog });
    assert.equal(preview.options.map, undefined, "connected Play uses world, never a flattened map");
    assert.equal(preview.options.world.sections.length, 2);
    if (model === ASTRAEUM_MODEL) {
      const reserved = preview.options.world.sections.flatMap(section =>
        section.map.spawns.filter(spawn => spawn.id === "reserved-player-spawn")
          .map(spawn => ({ x: spawn.position.x + section.origin.x, y: spawn.position.y + section.origin.y })));
      assert.equal(reserved.length, 1, "one unused compatibility slot satisfies the public two-start contract");
      assert.notDeepEqual(reserved[0], axis === "x" ? { x: -1968, y: 80 } : { x: 80, y: -1968 },
        "the compatibility slot cannot use the missing template floor");
    }
    const game = await createLocalGame(preview.options);
    const position = () => game.snapshot.player.position;
    const move = (along, ticks) => {
      assert.equal(game.sendInput("player", { type: "move", x: 0, y: 0, [axis]: along }), true);
      for (let tick = 0; tick < ticks; tick++) game.step();
    };
    try {
      assert.equal(position()[axis], -48, "authored start resolves with its negative section origin");
      const start = { ...position() };
      for (let tick = 0; tick < 24; tick++) {
        const prior = { ...position() };
        move(1, 1);
        assert.equal(position()[axis] - prior[axis], 4, "continuous movement including circle-straddling seam ticks");
        const cameraBefore = connectedCamera(preview.bounds, prior, 800, 600, 1);
        const cameraAfter = connectedCamera(preview.bounds, position(), 800, 600, 1);
        assert.equal(cameraAfter[axis] - cameraBefore[axis], 4, "camera never clamps at the seam");
      }
      assert.equal(position()[axis], 48);
      move(-1, 24);
      assert.deepEqual(position(), start, "return crosses the seam without resetting");
      move(1, 100);
      assert.ok(position()[axis] <= 128 - game.snapshot.player.radius + 0.01,
        "authored neighbor-section collision blocks movement");
      move(-1, 100);
      assert.ok(position()[axis] >= -128 + game.snapshot.player.radius - 0.01,
        "authored source-section collision blocks movement");
      results.push({ model, axis, seamCrossedBothWays: true, collisionBothSides: true });
    } finally { game.dispose(); }
    assert.deepEqual(sections, before, "Play and disposal never mutate section designs");

    const open = structuredClone(sections);
    for (const section of open) section.document.objects = section.document.objects.filter(object => object.type !== "wall");
    const outerPreview = createConnectedPreview(open, { mapId: open[0].mapId, model, assetCatalog });
    const outer = await createLocalGame(outerPreview.options);
    try {
      for (const direction of [1, -1]) {
        outer.sendInput("player", { type: "move", x: 0, y: 0, [axis]: direction });
        for (let tick = 0; tick < 1100; tick++) outer.step();
        const value = outer.snapshot.player.position[axis];
        assert.equal(value, direction === 1 ? 2048 - outer.snapshot.player.radius : -2048 + outer.snapshot.player.radius,
          "the exterior boundary remains enforced on both ends");
      }
    } finally { outer.dispose(); }

    const bounded = structuredClone(open);
    bounded[0].document.playableBoundary = createGridRectangleBoundary(
      axis === "x" ? { x: -64, y: 0 } : { x: 0, y: -64 },
      axis === "x" ? { x: 4, y: 63 } : { x: 63, y: 4 }, bounded
    ).boundary;
    {
      const boundedPreview = createConnectedPreview(bounded, { mapId: bounded[0].mapId, model, assetCatalog });
      const limited = await createLocalGame(boundedPreview.options);
      try {
        limited.sendInput("player", { type: "move", x: 0, y: 0, [axis]: 1 });
        for (let tick = 0; tick < 100; tick++) limited.step();
        assert.ok(limited.snapshot.player.position[axis] <= 160 - limited.snapshot.player.radius,
          "root-owned world boundary clips sections without adding a seam wall");
      } finally { limited.dispose(); }
    }

    const missing = structuredClone(sections);
    missing[0].document.objects = missing[0].document.objects.filter(object => object.type !== "spawn");
    assert.throws(() => createConnectedPreview(missing, { mapId: missing[0].mapId, model, assetCatalog }),
      /exactly one/, "missing authored starts fail explicitly without replacement");
    assert.throws(() => createConnectedPreview(sections, { mapId: "another-level", model, assetCatalog }),
      /root section is missing/, "Play cannot substitute the project's start level");
  }
}

const sections = connectedFixture(ASTRAEUM_MODEL);
const isolated = structuredClone(sections);
isolated[0].document.playableBoundary = createGridRectangleBoundary(
  { x: -2, y: 32 }, { x: -2, y: 32 }, isolated
).boundary;
assert.throws(() => createConnectedPreview(isolated, {
  mapId: isolated[0].mapId, model: ASTRAEUM_MODEL, assetCatalog: tower.ASSET_CATALOG
}), /two distinct walkable start cells/, "the public two-start minimum fails explicitly, without inventing floor");

const neighborReserve = structuredClone(sections);
neighborReserve[0].document.playableBoundary = createGridRectangleBoundary(
  { x: -2, y: 32 }, { x: 0, y: 32 }, neighborReserve
).boundary;
neighborReserve[0].document.objects.push(tower.createDesignObject(
  "last-root-cell-wall", "wall-damp-stone", { x: 2016, y: 1024 }, neighborReserve[0].document.objects.length
));
const neighborPreview = createConnectedPreview(neighborReserve, {
  mapId: neighborReserve[0].mapId, model: ASTRAEUM_MODEL, assetCatalog: tower.ASSET_CATALOG
});
assert.ok(neighborPreview.options.world.sections[1].map.spawns.some(spawn => spawn.id === "reserved-player-spawn"),
  "the compatibility slot can use a neighbor when only the authored start fits in its own section");
const neighborGame = await createLocalGame(neighborPreview.options);
neighborGame.dispose();

const smallCollider = structuredClone(sections);
smallCollider[1].document.objects.push(tower.createDesignObject(
  "small-barrel", "prop-barrel", { x: 80, y: 1048 }, smallCollider[1].document.objects.length, { collision: true }
));
const smallPreview = createConnectedPreview(smallCollider, {
  mapId: smallCollider[0].mapId, model: ASTRAEUM_MODEL, assetCatalog: tower.ASSET_CATALOG
});
assert.equal(smallPreview.options.world.sections[1].map.objects.some(object => object.id === "small-barrel"), false,
  "small colliders are not enlarged to bypass public rectangle dimensions");
const smallGame = await createLocalGame(smallPreview.options);
try {
  smallGame.sendInput("player", { type: "move", x: 1, y: 0 });
  for (let tick = 0; tick < 100; tick++) smallGame.step();
  assert.equal(smallGame.snapshot.player.position.x, 64, "the exact 18x8 barrel collision stops connected movement");
} finally { smallGame.dispose(); }

const preview = createConnectedPreview(sections, {
  mapId: sections[0].mapId, model: ASTRAEUM_MODEL, assetCatalog: tower.ASSET_CATALOG
});
const draws = [];
let translation = { x: 0, y: 0 };
const stack = [];
const drawing = {
  save() { stack.push({ ...translation }); }, restore() { translation = stack.pop(); },
  translate(x, y) { translation.x += x; translation.y += y; },
  beginPath() {}, rect() {}, clip() {}, fillRect() {},
  drawImage(image, ...args) { draws.push({ image, args, translation: { ...translation } }); }
};
preview.drawWorld(drawing, { wang: "wang" });
const seamTiles = draws.filter(draw => draw.image === "wang" &&
  draw.args[4] + draw.translation.x === -16 && draw.args[5] === 1008);
assert.equal(seamTiles.length, 2, "both clipped section halves render the shared Wang tile");
assert.ok(seamTiles.every(draw => draw.args[0] === 64 && draw.args[1] === 32),
  "both halves sample full-floor tile 1111, not a decorative seam edge");

const fakeEvents = new Map();
const canvas = {
  dataset: {}, style: {}, clientWidth: 800, clientHeight: 600, width: 800, height: 600,
  setAttribute() {}, addEventListener(name, callback) { fakeEvents.set(name, callback); },
  getContext() { return { ...drawing, setTransform() {}, arc() {}, fill() {} }; },
  remove() { this.removed = true; }, focus() {}
};
const oldDocument = globalThis.document, oldWindow = globalThis.window;
globalThis.document = {
  createElement: name => name === "canvas" ? canvas : { remove() {} },
  addEventListener() {}
};
globalThis.window = { devicePixelRatio: 1, addEventListener() {} };
try {
  const inputs = [];
  const skin = connectedSkin({
    ...preview, drawWorld() {}, drawActor() {}
  }, {}).mount({
    slots: new Map([["world", { append() {} }], ["controls", { append() {} }]]),
    dispatchInput: input => inputs.push(input)
  });
  skin.handleSnapshot({ tick: 1, player: { position: { x: 0, y: 1040 } } });
  fakeEvents.get("keydown")({ code: "ArrowRight", preventDefault() {} });
  skin.render();
  assert.deepEqual(inputs.at(-1), { type: "move", x: 1, y: 0 });
  assert.equal(canvas.dataset.sectionCount, "2");
  fakeEvents.get("blur")();
  assert.deepEqual(inputs.at(-1), { type: "move", x: 0, y: 0 });
  skin.dispose();
  assert.equal(canvas.removed, true);
} finally {
  globalThis.document = oldDocument; globalThis.window = oldWindow;
}
console.log(JSON.stringify({ result: "passed", results,
  rendering: "neighbor-aware Wang halves match", input: "movement, blur and disposal passed" }, null, 2));
