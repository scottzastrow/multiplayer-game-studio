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
const playerAccount = model => model === ASTRAEUM_MODEL ? "aries" : "player";
const playerPosition = (game, model) => model === ASTRAEUM_MODEL
  ? { x: game.snapshot.player.x, y: game.snapshot.player.y }
  : game.snapshot.player.position;
const playerRadius = (game, model) => model === ASTRAEUM_MODEL ? 4 : game.snapshot.player.radius;
const movementStep = () => 4;

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
    const position = () => playerPosition(game, model);
    const radius = () => playerRadius(game, model);
    const move = (along, ticks) => {
      assert.equal(game.sendInput(playerAccount(model), { type: "move", x: 0, y: 0, [axis]: along }), true);
      for (let tick = 0; tick < ticks; tick++) game.step();
    };
    try {
      const startCoordinate = model === ASTRAEUM_MODEL && axis === "y" ? -40 : -48;
      assert.equal(position()[axis], startCoordinate, "authored start resolves with its negative section origin");
      const start = { ...position() };
      for (let tick = 0; tick < 96 / movementStep(model); tick++) {
        const prior = { ...position() };
        move(1, 1);
        assert.equal(position()[axis] - prior[axis], movementStep(model),
          "continuous movement including circle-straddling seam ticks");
        const cameraBefore = connectedCamera(preview.bounds, prior, 800, 600, 1);
        const cameraAfter = connectedCamera(preview.bounds, position(), 800, 600, 1);
        assert.equal(cameraAfter[axis] - cameraBefore[axis], movementStep(model),
          "camera never clamps at the seam");
      }
      assert.equal(position()[axis], startCoordinate + 96);
      move(-1, 96 / movementStep(model));
      assert.deepEqual(position(), start, "return crosses the seam without resetting");
      move(1, 100);
      const eastEdge = model === ASTRAEUM_MODEL
        ? axis === "x" ? 128 - 9 : 128
        : 128 - radius();
      assert.ok(position()[axis] <= eastEdge + 1,
        `authored neighbor-section collision blocks movement (${model}/${axis}: ${position()[axis]} > ${eastEdge})`);
      move(-1, 100);
      const westEdge = axis === "x"
        ? -160 - (model === ASTRAEUM_MODEL ? 9 : radius())
        : -128 + (model === ASTRAEUM_MODEL ? 8 : radius());
      assert.ok(position()[axis] >= westEdge - 1,
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
        outer.sendInput(playerAccount(model), { type: "move", x: 0, y: 0, [axis]: direction });
        for (let tick = 0; tick < 1100; tick++) outer.step();
        const value = playerPosition(outer, model)[axis];
        const outerLimit = 2048 - playerRadius(outer, model);
        const expected = model === ASTRAEUM_MODEL && axis === "y"
          ? direction === 1 ? 2048 : -2040
          : direction * outerLimit;
        assert.equal(value, expected,
          `the exterior boundary remains enforced on both ends (${model}/${axis}; radius ${playerRadius(outer, model)})`);
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
        limited.sendInput(playerAccount(model), { type: "move", x: 0, y: 0, [axis]: 1 });
        for (let tick = 0; tick < 100; tick++) limited.step();
        const boundaryLimit = model === ASTRAEUM_MODEL && axis === "y" ? 160 : 160 - playerRadius(limited, model);
        assert.ok(playerPosition(limited, model)[axis] <= boundaryLimit,
          `root-owned world boundary clips sections without adding a seam wall (${model}/${axis}: ${playerPosition(limited, model)[axis]})`);
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

for (const model of [generic.MODEL, ASTRAEUM_MODEL]) {
  const project = model === generic.MODEL ? generic : tower;
  const [root, neighbor] = connectedFixture(model);
  neighbor.gridX = -1;
  const primaryId = model === generic.MODEL ? "generic-player" : "spawn-aries";
  neighbor.document.objects.push(project.createDesignObject("neighbor-start", primaryId,
    model === generic.MODEL ? { x: 64, y: 1024 } : { x: 80, y: 1040 },
    neighbor.document.objects.length));
  const rootBefore = structuredClone(root.document);
  const neighborBefore = structuredClone(neighbor.document);
  const preview = createConnectedPreview([neighbor], {
    mapId: root.mapId, rootDocument: root.document, model, assetCatalog: project.ASSET_CATALOG
  });
  assert.equal(preview.options.world.sections.length, 1);
  assert.equal(preview.options.world.id, root.mapId);
  const game = await createLocalGame(preview.options);
  try {
    const start = playerPosition(game, model).x;
    game.sendInput(playerAccount(model), { type: "move", x: 1, y: 0 });
    for (let tick = 0; tick < 4; tick++) game.step();
    assert.equal(playerPosition(game, model).x, start + 4 * movementStep(model));
  } finally { game.dispose(); }
  assert.deepEqual(root.document, rootBefore);
  assert.deepEqual(neighbor.document, neighborBefore);
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
  smallGame.sendInput("aries", { type: "move", x: 1, y: 0 });
  for (let tick = 0; tick < 100; tick++) smallGame.step();
  assert.equal(smallGame.snapshot.player.x, 62, "the exact 18x8 barrel collision stops connected Tower movement");
} finally { smallGame.dispose(); }

const combatSections = connectedFixture(ASTRAEUM_MODEL);
combatSections[0].document.objects.push(tower.createDesignObject("connected-slime", "spawn-slime",
  { x: 1968, y: 1040 }, combatSections[0].document.objects.length));
const combatDesignsBefore = structuredClone(combatSections);
const combatPreview = createConnectedPreview(combatSections, {
  mapId: combatSections[0].mapId, model: ASTRAEUM_MODEL, assetCatalog: tower.ASSET_CATALOG
});
const combatGame = await createLocalGame(combatPreview.options);
let attackSnapshot;
try {
  assert.equal(combatGame.sendInput("aries", { type: "attack", pressed: true }), true);
  combatGame.step();
  attackSnapshot = combatGame.snapshot;
  for (let tick = 1; tick < 38; tick++) combatGame.step();
  assert.equal(combatGame.snapshot.damageDealt, 36, "connected Tower combat applies Halberd damage");
  assert.equal(combatGame.snapshot.slimesDefeated, 1, "connected Tower combat defeats the authored slime");
  assert.equal(combatGame.snapshot.lastEvent.type, "slime-defeated");
  assert.equal(combatGame.snapshot.enemies.length, 0);
} finally { combatGame.dispose(); }
assert.deepEqual(combatSections, combatDesignsBefore, "connected combat does not mutate section documents");

const contactSections = connectedFixture(ASTRAEUM_MODEL);
contactSections[0].document.objects.push(tower.createDesignObject("contact-slime", "spawn-slime",
  { x: 2000, y: 1040 }, contactSections[0].document.objects.length));
const contactPreview = createConnectedPreview(contactSections, {
  mapId: contactSections[0].mapId, model: ASTRAEUM_MODEL, assetCatalog: tower.ASSET_CATALOG
});
const contactGame = await createLocalGame(contactPreview.options);
try {
  contactGame.step();
  assert.equal(contactGame.snapshot.damageTaken, 12, "connected slime contact deals the original 12 damage");
  assert.equal(contactGame.snapshot.player.hp, 488);
} finally { contactGame.dispose(); }

const preview = createConnectedPreview(combatSections, {
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

const renderDocument = structuredClone(tower.DEFAULT_FLOOR_DOCUMENT);
const renderSections = [{ sectionId: "floor-1", mapId: renderDocument.id,
  gridX: 0, gridY: 0, document: renderDocument }];
const renderPreview = createConnectedPreview(renderSections, {
  mapId: renderDocument.id, model: ASTRAEUM_MODEL, assetCatalog: tower.ASSET_CATALOG
});
const renderCalls = [];
const rendererContext = new Proxy({ globalAlpha: 1, save() {}, restore() {} }, {
  get(target, key) {
    if (key in target) return target[key];
    if (key === "drawImage") return image => renderCalls.push(image);
    return () => {};
  },
  set(target, key, value) { target[key] = value; return true; }
});
const renderArtwork = {
  wang: {}, door: { width: 24, height: 32 }, web: { width: 32, height: 32 },
  candle: { width: 18, height: 27 }, rune: {}
};
renderPreview.drawWorld(rendererContext, renderArtwork);
assert.ok(renderCalls.includes(renderArtwork.door), "connected Tower Play draws its generated door");
assert.ok(renderCalls.includes(renderArtwork.rune), "connected Tower Play draws the stairs rune");

function mountConnectedTowerSkin(preferredControlMode, preview = combatPreview) {
  const windowListeners = new Map();
  const drawingCalls = [];
  let documentRef;
  const makeElement = tagName => {
    const element = {
      tagName, dataset: {}, style: {}, children: [], attributes: {}, clientWidth: 800, clientHeight: 600,
      width: 800, height: 600,
      append(...children) { this.children.push(...children); },
      remove() { this.removed = true; },
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(name, callback) {
        if (!this.listeners) this.listeners = new Map();
        if (!this.listeners.has(name)) this.listeners.set(name, []);
        this.listeners.get(name).push(callback);
      },
      fire(name, event = {}) {
        for (const callback of this.listeners?.get(name) ?? []) callback({ target: this, preventDefault() {}, ...event });
      },
      focus() { documentRef.activeElement = this; },
      getBoundingClientRect() { return { left: 0, top: 0 }; }
    };
    if (tagName === "canvas") {
      element.getContext = () => element.context ??= new Proxy({ canvas: element, globalAlpha: 1 }, {
        get(target, key) {
          if (key in target) return target[key];
          if (key === "createRadialGradient") return (...args) => {
            drawingCalls.push({ method: key, args });
            return { addColorStop() {} };
          };
          return (...args) => drawingCalls.push({ method: key, args });
        },
        set(target, key, value) { target[key] = value; return true; }
      });
    }
    return element;
  };
  documentRef = {
    hidden: false,
    createElement: makeElement,
    createTextNode: text => ({ textContent: text }),
    addEventListener() {}
  };
  const windowRef = {
    devicePixelRatio: 1,
    addEventListener(name, callback) {
      if (!windowListeners.has(name)) windowListeners.set(name, []);
      windowListeners.get(name).push(callback);
    },
    fire(name, event = {}) {
      for (const callback of windowListeners.get(name) ?? []) callback(event);
    },
    dispatchEvent(event) { this.fire(event.type, event); }
  };
  const oldDocument = globalThis.document;
  const oldWindow = globalThis.window;
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const oldCustomEvent = globalThis.CustomEvent;
  let gamepad = null;
  globalThis.document = documentRef;
  globalThis.window = windowRef;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true, value: { getGamepads: () => gamepad ? [gamepad] : [] }
  });
  globalThis.CustomEvent = class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } };
  const slots = new Map(["world", "hud", "controls"].map(name => [name, makeElement(name)]));
  const inputs = [];
  try {
    const skin = connectedSkin({
      ...preview, isTower: true, assetCatalog: tower.ASSET_CATALOG, drawWorld() {}
    }, { ariesIdle: { naturalWidth: 64 } }, preferredControlMode).mount({
      slots, dispatchInput: input => inputs.push(input)
    });
    const activeCanvas = slots.get("world").children[0].children[0];
    activeCanvas.focus();
    skin.handleViewport(800, 600, 1);
    return {
      canvas: activeCanvas, prompt: slots.get("world").children[0].children[1],
      help: slots.get("controls").children[0],
      inputs, drawingCalls, skin, window: windowRef,
      setGamepad(value) { gamepad = value; },
      restore() {
        skin.dispose();
        globalThis.document = oldDocument;
        globalThis.window = oldWindow;
        if (oldNavigator) Object.defineProperty(globalThis, "navigator", oldNavigator);
        else delete globalThis.navigator;
        if (oldCustomEvent === undefined) delete globalThis.CustomEvent;
        else globalThis.CustomEvent = oldCustomEvent;
      }
    };
  } catch (error) {
    globalThis.document = oldDocument;
    globalThis.window = oldWindow;
    if (oldNavigator) Object.defineProperty(globalThis, "navigator", oldNavigator);
    else delete globalThis.navigator;
    if (oldCustomEvent === undefined) delete globalThis.CustomEvent;
    else globalThis.CustomEvent = oldCustomEvent;
    throw error;
  }
}

const controls = mountConnectedTowerSkin("keyboard-only");
try {
  const skinSnapshot = { ...attackSnapshot, tick: 1 };
  controls.skin.handleSnapshot(skinSnapshot);
  controls.skin.render();
  assert.ok(Number(controls.canvas.dataset.collisionRectangles) > 0,
    "the reused Tower skin reports connected-world collision geometry");
  assert.ok(Number(controls.canvas.dataset.attackFrame) > 0);
  assert.equal(controls.canvas.dataset.exitUnlocked, "false", "HUD state reflects surviving slimes");
  assert.equal(controls.prompt.hidden, true, "no nearby rune means no interaction prompt");
  const unlocked = { ...skinSnapshot, enemies: [], exitUnlocked: true, nearbyExit: {
    id: "root:rune", destination: { levelId: "next-level", sectionId: "root", startId: "start" }
  } };
  controls.skin.handleSnapshot(unlocked);
  controls.skin.render();
  assert.equal(controls.prompt.textContent, "Enter the rune to continue");
  controls.skin.handleSnapshot({ ...unlocked, nearbyExit: { id: "root:rune", destination: null } });
  controls.skin.render();
  assert.match(controls.prompt.textContent, /no complete destination/);
  controls.skin.handleSnapshot(skinSnapshot);
  controls.skin.render();
  assert.ok(controls.drawingCalls.some(call => call.method === "stroke"),
    "the reused Tower skin visibly renders the connected Halberd attack");
  const initialCamera = Number(controls.canvas.dataset.cameraX);
  controls.skin.handleSnapshot({ ...skinSnapshot, player: { ...skinSnapshot.player, x: skinSnapshot.player.x + 4 } });
  controls.skin.render();
  assert.equal(Number(controls.canvas.dataset.cameraX), initialCamera + 4,
    "the reused Tower skin camera follows world movement continuously");
  assert.match(controls.help.textContent, /Chests open automatically nearby/);
  assert.doesNotMatch(controls.help.textContent, /E: Open chest|X: Open chest|interact/i,
    "control prompts contain no chest Interact binding");

  controls.canvas.fire("keydown", { code: "KeyD" });
  assert.ok(controls.inputs.some(input => input.type === "move" && input.x === 1));
  controls.canvas.fire("keydown", { code: "Space" });
  assert.ok(controls.inputs.some(input => input.type === "attack" && input.pressed));
  controls.canvas.fire("keydown", { code: "ArrowUp" });
  assert.ok(controls.inputs.some(input => input.type === "dodge" && input.pressed));
  controls.canvas.fire("keydown", { code: "KeyE" });
  controls.canvas.fire("keydown", { code: "KeyE", repeat: true });
  assert.ok(!controls.inputs.some(input => input.type === "interact"),
    "E no longer dispatches a chest interaction");
  assert.equal(controls.inputs.filter(input => input.type === "activate-exit").length, 0,
    "E no longer dispatches a rune activation input");
  controls.window.fire("keyup", { code: "KeyE" });
  assert.ok(!controls.inputs.some(input => input.type === "activate-exit"));
  controls.window.fire("studio:player-settings-mode-change",
    { type: "studio:player-settings-mode-change", detail: { mode: "keyboard-mouse" } });
  controls.skin.handleSnapshot(unlocked);
  controls.skin.render();
  assert.equal(controls.prompt.textContent, "Enter the rune to continue");
  controls.canvas.fire("keydown", { code: "ArrowRight" });
  assert.ok(controls.inputs.some(input => input.type === "move" && input.x === 1));
  controls.canvas.fire("pointermove", { clientX: 450, clientY: 300 });
  assert.ok(controls.inputs.some(input => input.type === "aim"));
  controls.canvas.fire("pointerdown", { button: 0 });
  assert.ok(controls.inputs.some(input => input.type === "attack" && input.pressed));
  controls.canvas.fire("pointerdown", { button: 2 });
  controls.canvas.fire("keydown", { code: "ArrowDown" });
  assert.ok(controls.inputs.some(input => input.type === "dodge" && input.pressed));

  controls.window.fire("studio:player-settings-mode-change",
    { type: "studio:player-settings-mode-change", detail: { mode: "game-controller" } });
  assert.equal(controls.prompt.textContent, "Enter the rune to continue",
    "all control modes use the same automatic entry prompt");
  assert.ok(!controls.help.textContent.includes("X/Square"));
  const interactOnlyButtons = Array.from({ length: 8 }, () => ({ pressed: false, value: 0 }));
  interactOnlyButtons[2] = { pressed: true, value: 1 };
  controls.setGamepad({ connected: true, mapping: "standard", id: "interact-only",
    axes: [0, 0, 0, 0], buttons: interactOnlyButtons });
  controls.skin.render();
  assert.ok(!controls.inputs.some(input => input.type === "interact"),
    "controller X no longer dispatches a chest interaction");
  const buttons = Array.from({ length: 8 }, () => ({ pressed: false, value: 0 }));
  buttons[7] = { pressed: true, value: 1 };
  controls.setGamepad({ connected: true, mapping: "standard", id: "fixture",
    axes: [0.8, 0, 0.2, 0], buttons });
  controls.skin.render();
  assert.ok(controls.inputs.some(input => input.type === "move" && input.x > 0));
  assert.ok(controls.inputs.some(input => input.type === "aim" && input.x > 0));
  assert.ok(controls.inputs.some(input => input.type === "attack" && input.pressed));
  buttons[1] = { pressed: true, value: 1 };
  controls.skin.render();
  assert.ok(controls.inputs.some(input => input.type === "dodge" && input.pressed),
    "the selected controller mode forwards a directional dodge");
} finally { controls.restore(); }

const arrivalSections = connectedFixture(ASTRAEUM_MODEL);
arrivalSections[0].gridX = 0;
arrivalSections[1].gridX = 1;
arrivalSections[0].document.cameraZoom = 1.5;
arrivalSections[0].document.objects.push(tower.createDesignObject("arrival-rune", "prop-stairs-rune",
  { x: 1968, y: 1040 }, arrivalSections[0].document.objects.length));
const arrivalPreview = createConnectedPreview(arrivalSections, {
  mapId: arrivalSections[0].mapId, model: ASTRAEUM_MODEL, assetCatalog: tower.ASSET_CATALOG,
  requireNeutral: true
});
const arrivalRuntime = await createLocalGame(arrivalPreview.options);
const arrivalControls = mountConnectedTowerSkin("game-controller", arrivalPreview);
try {
  arrivalControls.skin.handleSnapshot(arrivalRuntime.snapshot);
  const buttons = Array.from({ length: 8 }, () => ({ pressed: false, value: 0 }));
  buttons[2] = buttons[7] = { pressed: true, value: 1 };
  arrivalControls.setGamepad({ connected: true, mapping: "standard", id: "arrival",
    axes: [0.8, 0, 0, 0], buttons });
  arrivalControls.canvas.fire("keydown", { code: "KeyE", repeat: true });
  arrivalControls.skin.render();
  assert.equal(arrivalControls.inputs.length, 0, "fresh destination skin suppresses held controller and repeated keyboard input");
  buttons[2] = buttons[7] = { pressed: false, value: 0 };
  arrivalControls.setGamepad({ connected: true, mapping: "standard", id: "arrival", axes: [0, 0, 0, 0], buttons });
  arrivalControls.skin.render();
  buttons[2] = { pressed: true, value: 1 };
  arrivalControls.skin.render();
  arrivalControls.skin.render();
  assert.equal(arrivalControls.inputs.filter(input => input.type === "activate-exit").length, 0,
    "controller X/Square no longer dispatches an activation input");
  assert.equal(arrivalControls.canvas.dataset.exitUnlocked, "true");
  assert.equal(arrivalControls.canvas.dataset.worldScale, "1.5");
  assert.equal(arrivalControls.canvas.dataset.lightingCenterX, "2000");
  assert.equal(arrivalControls.canvas.dataset.lightingCenterY, "1028");
  assert.equal(Number(arrivalControls.canvas.dataset.lightingScreenX),
    (2000 - Number(arrivalControls.canvas.dataset.cameraX)) * 1.5);
  assert.ok(arrivalControls.drawingCalls.some(call => call.method === "createRadialGradient" &&
    call.args[0] === (1968 - Number(arrivalControls.canvas.dataset.cameraX)) * 1.5 &&
    call.args[1] === (1048 - Number(arrivalControls.canvas.dataset.cameraY)) * 1.5 &&
    call.args[5] === 105),
  "the new level's rune light is transformed with the destination camera and zoom");
} finally {
  arrivalRuntime.dispose();
  arrivalControls.restore();
}

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
  const genericPreview = createConnectedPreview(connectedFixture(generic.MODEL), {
    mapId: "connected-level", model: generic.MODEL, assetCatalog: generic.ASSET_CATALOG
  });
  const skin = connectedSkin({
    ...genericPreview, drawWorld() {}, drawActor() {}
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
  rendering: "neighbor-aware Wang halves, generated door, rune and Tower attack match",
  combat: "connected slime contact, damage and defeat passed",
  input: "all Tower control modes, camera following, blur and disposal passed" }, null, 2));
