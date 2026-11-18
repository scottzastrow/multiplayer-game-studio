import assert from "node:assert/strict";
import { register } from "node:module";
import * as generic from "../../games/generic-grid-v1/src/project.js";
import * as tower from "../../games/astraeum-tower/src/project.js";

register("./public-runtime-loader.mjs", import.meta.url);
const { MAP_CELL_SIZE, MAX_MAP_DIMENSION, validateMapDefinition } = await import("@multiplayer-game/theme-sdk");
const { createLocalGame } = await import("@multiplayer-game/local-preview");
const { genericPreview } = await import("../../games/generic-grid-v1/src/runtime.js");
const { createTowerGameModule, towerSettings } = await import("../../games/astraeum-tower/src/game.js");

const map = validateMapDefinition({
  formatVersion: 1, id: "section-contract", name: "Disposable section contract",
  bounds: { width: MAX_MAP_DIMENSION, height: MAX_MAP_DIMENSION }, cellSize: MAP_CELL_SIZE,
  objects: [], collisions: [],
  spawns: [
    { id: "authored-start", kind: "player", position: { x: 2000, y: 80 }, radius: 8 },
    { id: "second-start", kind: "player", position: { x: 80, y: 80 }, radius: 8 }
  ]
});

for (const axis of ["width", "height"]) {
  assert.throws(() => validateMapDefinition({
    ...map, bounds: { ...map.bounds, [axis]: MAX_MAP_DIMENSION * 2 }
  }), error => error.issues?.some(issue => issue.code === "too_big" &&
    issue.path.join(".") === `bounds.${axis}` && issue.maximum === MAX_MAP_DIMENSION),
  `two full adjacent sections cannot be flattened along ${axis}`);
}
assert.throws(() => validateMapDefinition({
  ...map, origin: { x: MAX_MAP_DIMENSION, y: 0 }
}), undefined, "a MapDefinition has no section/world origin");
assert.throws(() => validateMapDefinition({
  ...map, spawns: [{ ...map.spawns[0], position: { x: MAX_MAP_DIMENSION + 16, y: 80 } },
    map.spawns[1]]
}), undefined, "a destination-section world-coordinate start is not a local map start");

const results = [];
for (const axis of ["x", "y"]) {
  const start = axis === "x" ? { x: 2000, y: 80 } : { x: 80, y: 2000 };
  const layout = { bounds: map.bounds, cellSize: MAP_CELL_SIZE, obstacles: [] };
  let phase = 0;
  const factory = {
    metadata: { id: `section-contract-${axis}`, version: "1.0.0", stateSchemaVersion: 1 },
    validateSettings: settings => settings !== null && typeof settings === "object",
    create(context) {
      return {
        stateSchemaVersion: 1,
        initialize() {
          assert.ok(context.maps, "local preview supplies the optional public transition service");
          context.entities.add({
            id: "authored-player", typeId: "player", position: start, radius: 8,
            state: { authored: true }
          });
        },
        validateInput: () => false,
        applyInput() {},
        step() {
          const player = context.entities.get("authored-player");
          if (phase === 0) {
            assert.deepEqual(player.position, start, "initialization uses the authored position");
            const delta = { x: 0, y: 0, [axis]: 128 };
            const moved = context.geometry.moveCircle(player.position, delta, player.radius);
            assert.equal(moved[axis], MAX_MAP_DIMENSION - player.radius,
              "the first map's exterior clamps the circle before the adjacent section");
            context.entities.update(player.id, current => ({ ...current, position: moved }));
          } else if (phase === 1) {
            const token = context.maps.prepare(layout);
            const outside = { ...player.position, [axis]: MAX_MAP_DIMENSION + 16 };
            assert.throws(() => context.maps.commit(token, [{ ...player, position: outside }]),
              /walkable/, "replacing one bounded map does not admit adjacent world coordinates");
            assert.deepEqual(context.entities.get(player.id), player,
              "a failed replacement retains the original entity");
            assert.equal(context.geometry.isWalkable(outside.x, outside.y, player.radius), false);
            context.maps.commit(token, [player]);
            assert.deepEqual(context.entities.get(player.id), player,
              "replacement at the same local position is supported");
          } else {
            const token = context.maps.prepare(layout);
            const localDestination = { ...player.position, [axis]: 16 };
            context.maps.commit(token, [{ ...player, position: localDestination }]);
            assert.equal(context.entities.get(player.id).position[axis], 16,
              "entering a replacement map locally requires an explicit position change");
          }
          phase++;
        },
        snapshot() { return { phase, player: context.entities.get("authored-player") }; },
        results() { return { phase }; },
        dispose() {}
      };
    }
  };
  const game = await createLocalGame({
    moduleFactory: factory, settings: {}, map, seed: 1,
    roster: [{ accountId: "player", username: "Player", joinedOrder: 0 }],
    viewer: { accountId: "player", role: "player" }
  });
  try {
    for (let tick = 0; tick < 3; tick++) game.step();
    results.push({ axis, clampedAt: MAX_MAP_DIMENSION - 8,
      replacementLocalPosition: game.snapshot.player.position[axis] });
  } finally {
    game.dispose();
  }
}
const adapterResults = [];
for (const model of ["generic", "tower"]) {
  const design = model === "generic"
    ? generic.createDocument("single-section-contract", "Single-section regression")
    : tower.createFloorDocument();
  const before = structuredClone(design);
  const options = model === "generic" ? genericPreview(design) : {
    moduleFactory: createTowerGameModule(design), settings: towerSettings,
    map: tower.createFloorMap(design), seed: 1,
    roster: [{ accountId: "aries", username: "Aries", joinedOrder: 0 }],
    viewer: { accountId: "aries", role: "player" }
  };
  const game = await createLocalGame(options);
  const position = () => model === "generic"
    ? game.snapshot.players[0].position
    : { x: game.snapshot.player.x, y: game.snapshot.player.y };
  try {
    const initial = position();
    assert.deepEqual(initial, {
      x: options.map.spawns[0].position.x,
      y: options.map.spawns[0].position.y + (model === "tower" ? 8 : 0)
    }, `${model} retains its authored start and existing feet offset`);
    const accountId = options.roster[0].accountId;
    for (const y of [1, -1]) {
      assert.equal(game.sendInput(accountId, { type: "move", x: 0, y }), true);
      for (let tick = 0; tick < 8; tick++) game.step();
      if (y === 1) assert.equal(position().y, initial.y + 32, `${model} retains its movement speed`);
    }
    assert.deepEqual(position(), initial, `${model} can return along the same path`);
    adapterResults.push({ model, initial, returned: position() });
  } finally {
    game.dispose();
  }
  assert.deepEqual(design, before, `${model} simulation/disposal never modifies the design`);
}
console.log(JSON.stringify({
  result: "passed", mapLimit: MAX_MAP_DIMENSION, results, adapterResults,
  scope: "Bounded single-map replacement only; not connected-section acceptance. No oversized MapGeometry submitted."
}, null, 2));
