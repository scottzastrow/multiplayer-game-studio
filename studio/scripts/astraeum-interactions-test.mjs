import assert from "node:assert/strict";
import { register } from "node:module";
import * as tower from "../../games/astraeum-tower/src/project.js";
import { connectedFixture } from "./connected-play-fixtures.mjs";
import { ASTRAEUM_MODEL } from "../project-identity.js";

register("./public-runtime-loader.mjs", import.meta.url);
const { createLocalGame } = await import("@multiplayer-game/local-preview");
const { connectedSkin, createConnectedPreview } = await import("../extensions/connected-play.js");
const { createTowerInteractionState } = await import("../../games/astraeum-tower/src/game.js");

const options = { mapId: "connected-level", model: ASTRAEUM_MODEL, assetCatalog: tower.ASSET_CATALOG };
const add = (section, id, assetId, transform) => {
  const object = tower.createDesignObject(id, assetId, transform, section.document.objects.length);
  section.document.objects.push(object);
  return object;
};
const makeSections = () => connectedFixture(ASTRAEUM_MODEL);
const createGame = async (sections, interactionState = createTowerInteractionState()) => {
  const preview = createConnectedPreview(sections, { ...options, interactionState });
  return createLocalGame(preview.options);
};
const send = (game, input) => assert.equal(game.sendInput("aries", input), true);
const step = (game, ticks = 1) => {
  let frame;
  for (let tick = 0; tick < ticks; tick += 1) frame = game.step();
  return frame;
};

function mountInteractionRenderer(preview) {
  let documentRef;
  let worldCanvas = null;
  let worldFilterDraws = 0;
  const offscreenFilterDraws = [];
  const canvases = [];
  const makeElement = tagName => {
    const element = {
      tagName, dataset: {}, style: {}, children: [], clientWidth: 800, clientHeight: 600,
      width: 800, height: 600,
      append(...children) { this.children.push(...children); },
      remove() {},
      setAttribute() {},
      addEventListener() {},
      focus() { documentRef.activeElement = this; }
    };
    if (tagName === "canvas") {
      canvases.push(element);
      element.getContext = () => element.context ??= new Proxy({
        canvas: element, globalAlpha: 1, filter: "none", globalCompositeOperation: "source-over", stack: []
      }, {
        get(target, key) {
          if (key in target) return target[key];
          if (key === "createRadialGradient") return () => ({ addColorStop() {} });
          if (key === "save") return () => {
            target.stack.push({
              filter: target.filter, globalAlpha: target.globalAlpha,
              globalCompositeOperation: target.globalCompositeOperation
            });
          };
          if (key === "restore") return () => {
            assert.ok(target.stack.length, "Canvas restore must match a prior save");
            Object.assign(target, target.stack.pop());
          };
          if (key === "drawImage") return () => {
            if (target.filter === "none") return;
            if (element === worldCanvas) worldFilterDraws += 1;
            else offscreenFilterDraws.push(target.filter);
          };
          return () => {};
        },
        set(target, key, value) { target[key] = value; return true; }
      });
    }
    return element;
  };
  documentRef = {
    hidden: false,
    createElement: makeElement,
    createTextNode: textContent => ({ textContent }),
    addEventListener() {}
  };
  const windowRef = {
    devicePixelRatio: 1,
    addEventListener() {},
    dispatchEvent() {}
  };
  const oldDocument = globalThis.document;
  const oldWindow = globalThis.window;
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const oldCustomEvent = globalThis.CustomEvent;
  globalThis.document = documentRef;
  globalThis.window = windowRef;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true, value: { getGamepads: () => [] }
  });
  globalThis.CustomEvent = class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } };
  const slots = new Map(["world", "hud", "controls"].map(name => [name, makeElement(name)]));
  const drawingPreview = { ...preview, drawWorld() {} };
  const artwork = new Proxy({ ariesIdle: { naturalWidth: 64 } }, {
    get(target, key) { return target[key] ??= { naturalWidth: 1, width: 1, height: 1 }; }
  });
  const skin = connectedSkin(drawingPreview, artwork, "keyboard-only").mount({
    slots, dispatchInput() {}
  });
  const canvas = slots.get("world").children[0].children[0];
  worldCanvas = canvas;
  canvas.focus();
  skin.handleViewport(800, 600, 1);
  return {
    get worldFilterDraws() { return worldFilterDraws; },
    get offscreenFilterDraws() { return [...offscreenFilterDraws]; },
    render(snapshot) {
      skin.handleSnapshot(snapshot);
      skin.render();
      assert.equal(canvas.context.stack.length, 0, "world Canvas saves are balanced after rendering");
      assert.equal(canvas.context.filter, "none", "world Canvas filter is restored after rendering");
      assert.equal(canvas.context.globalAlpha, 1, "world Canvas alpha is restored after rendering");
      assert.equal(canvas.context.globalCompositeOperation, "source-over",
        "world Canvas compositing is restored after rendering");
      for (const other of canvases.filter(element => element !== canvas && element.context)) {
        assert.equal(other.context.stack.length, 0, "offscreen Canvas saves are balanced");
        assert.equal(other.context.filter, "none", "offscreen Canvas filter is restored");
      }
    },
    dispose() {
      skin.dispose();
      globalThis.document = oldDocument;
      globalThis.window = oldWindow;
      if (oldNavigator) Object.defineProperty(globalThis, "navigator", oldNavigator);
      else delete globalThis.navigator;
      globalThis.CustomEvent = oldCustomEvent;
    }
  };
}

{
  const document = tower.createBlankDocument("interaction-schema", "Interaction schema");
  const chest = add({ document }, "schema-chest", "item-chest", { x: 176, y: 152 });
  assert.deepEqual(chest.interaction, { tier: "normal" }, "new chests default to normal loot");
  chest.interaction.tier = "treasure";
  const saved = structuredClone(document);
  assert.equal(tower.validateFloorDocument(JSON.parse(JSON.stringify(document)))
    .objects.find(object => object.id === chest.id).interaction.tier, "treasure");
  assert.deepEqual(document, saved, "validation does not mutate a saved design");
  const invalid = structuredClone(document);
  invalid.objects.find(object => object.id === chest.id).interaction.tier = "invented";
  assert.throws(() => tower.validateFloorDocument(invalid), /tier must be normal or treasure/);
}

{
  const sections = makeSections();
  for (const [index, assetId] of ["item-herb", "item-mushroom", "item-amethyst"].entries()) {
    add(sections[0], `pickup-${index}`, assetId, { x: 2000, y: 1048 });
  }
  const saved = structuredClone(sections);
  const interactionState = createTowerInteractionState();
  const game = await createGame(sections, interactionState);
  try {
    step(game, 5);
    assert.deepEqual(
      { herb: game.snapshot.inventory.herb, mushroom: game.snapshot.inventory.mushroom,
        amethyst: game.snapshot.inventory.amethyst },
      { herb: 1, mushroom: 1, amethyst: 1 },
      "nearby original pickups enter inventory"
    );
    assert.equal(interactionState.collected.size, 3, "each pickup is recorded once");
    const inventory = { ...game.snapshot.inventory };
    step(game, 20);
    assert.deepEqual(game.snapshot.inventory, inventory, "standing nearby never duplicates pickups");
    assert.deepEqual(sections, saved, "collecting pickups never mutates the saved design");
  } finally {
    game.dispose();
  }

  const fullHealthState = createTowerInteractionState();
  fullHealthState.inventory.herb = 1;
  const fullHealthGame = await createGame(makeSections(), fullHealthState);
  try {
    send(fullHealthGame, { type: "use-herb", pressed: true });
    step(fullHealthGame);
    assert.equal(fullHealthGame.snapshot.player.hp, 500);
    assert.equal(fullHealthGame.snapshot.inventory.herb, 1,
      "a herb is not consumed when Aries is already at full health");
  } finally {
    fullHealthGame.dispose();
  }
}

{
  const sections = makeSections();
  for (const [index, assetId] of ["prop-barrel", "prop-crate", "prop-pots"].entries()) {
    add(sections[0], `decorative-${index}`, assetId, { x: 2000, y: 1048 });
  }
  const interactionState = createTowerInteractionState();
  const game = await createGame(sections, interactionState);
  try {
    send(game, { type: "attack", pressed: true });
    step(game, 80);
    send(game, { type: "attack", pressed: false });
    assert.equal(game.snapshot.interactions.chests.length, 0);
    assert.equal(interactionState.drops.length, 0, "attacks do not generate drops from decorative props");
  } finally {
    game.dispose();
  }
}

for (const axis of ["x", "y"]) {
  const sections = connectedFixture(ASTRAEUM_MODEL, axis);
  const saved = structuredClone(sections);
  const game = await createGame(sections);
  try {
    send(game, axis === "x" ? { type: "move", x: 1, y: 0 } : { type: "move", x: 0, y: 1 });
    step(game, 24);
    send(game, { type: "move", x: 0, y: 0 });
    assert.ok(axis === "x" ? game.snapshot.player.x > 0 : game.snapshot.player.y > 0,
      `Tower interactions continue across the ${axis.toUpperCase()} section seam`);
  } finally {
    game.dispose();
  }
  assert.deepEqual(sections, saved, `crossing the ${axis.toUpperCase()} seam does not mutate saved sections`);
}

{
  const sections = makeSections();
  const chest = add(sections[0], "normal-chest", "item-chest", { x: 1952, y: 1040 });
  const saved = structuredClone(sections);
  const interactionState = createTowerInteractionState();
  const game = await createGame(sections, interactionState);
  try {
    step(game, 5);
    const chestSnapshot = () => game.snapshot.interactions.chests.find(item => item.id.includes(chest.id));
    assert.equal(chestSnapshot().opened, false, "a chest 48 pixels away stays closed");
    assert.equal(game.sendInput("aries", { type: "interact", pressed: true }), false,
      "chests do not require or accept an Interact action");
    send(game, { type: "move", x: -1, y: 0 });
    for (let tick = 0; tick < 8 && !chestSnapshot().opened; tick += 1) game.step();
    send(game, { type: "move", x: 0, y: 0 });
    assert.equal(chestSnapshot().opened, true, "the chest opens automatically within its proximity radius");
    assert.ok(Math.hypot(game.snapshot.player.x - chestSnapshot().transform.x,
      game.snapshot.player.y - chestSnapshot().transform.y) < 46);
    assert.equal(game.snapshot.lastEvent.type, "chest-opened");
    const initialLoot = game.snapshot.interactions.items;
    const itemDrops = initialLoot.filter(item => item.kind !== "gold");
    const gold = initialLoot.filter(item => item.kind === "gold")
      .reduce((sum, item) => sum + item.value, 0);
    assert.ok(itemDrops.length >= 2 && itemDrops.length <= 4, "normal chests drop 2-4 items");
    assert.ok(gold >= 10 && gold <= 16, "normal chest gold stays in the original range");
    assert.ok(itemDrops.every(item =>
      ["herb", "mushroom", "amethyst", "sapphire", "ruby", "emerald"].includes(item.kind)));
    step(game, 35);
    assert.ok(game.snapshot.effects.some(effect =>
      /^\+\d+ (?:Healing Herb|Glowcap|Amethyst|Sapphire|Ruby|Emerald|Mana Crystal)$/.test(effect.value)),
    "collected chest loot receives visible item feedback");
    step(game, 100);
    assert.equal(chestSnapshot().opened, true, "standing nearby never reopens the chest");
    assert.equal(interactionState.openedChests.size, 1);
    assert.ok(game.snapshot.inventory.gold > 0, "gold drops auto-collect after their original delay");
    assert.ok(Object.entries(game.snapshot.inventory).some(([kind, amount]) => kind !== "gold" && amount > 0),
      "item drops enter the original inventory");
    assert.equal(game.snapshot.effects.length, 0, "pickup and chest effects expire after settling");
    const expected = Object.fromEntries(Object.keys(interactionState.inventory).map(kind => [
      kind, initialLoot.filter(item => item.kind === kind).reduce((sum, item) => sum + item.value, 0)
    ]));
    for (const [kind, amount] of Object.entries(expected)) {
      const remaining = interactionState.drops.filter(item => item.kind === kind)
        .reduce((sum, item) => sum + item.value, 0);
      assert.equal(game.snapshot.inventory[kind] + remaining, amount,
        `collected and remaining ${kind} rewards equal the original chest drops`);
    }
    const ids = interactionState.drops.map(item => item.id);
    assert.equal(new Set(ids).size, ids.length, "loot IDs remain unique");
    assert.deepEqual(sections, saved, "chest activity never mutates the saved design");
    const inventory = { ...game.snapshot.inventory };
    const revisit = await createGame(sections, interactionState);
    try {
      assert.equal(revisit.snapshot.interactions.chests.find(item => item.id.includes(chest.id)).opened, true);
      assert.deepEqual(revisit.snapshot.inventory, inventory);
    } finally {
      revisit.dispose();
    }
  } finally {
    game.dispose();
  }
}

{
  const sections = makeSections();
  const chest = add(sections[0], "treasure-chest", "item-chest", { x: 1968, y: 1040 });
  chest.interaction = { tier: "treasure" };
  const game = await createGame(sections);
  try {
    step(game);
    const loot = game.snapshot.interactions.items;
    const items = loot.filter(item => item.kind !== "gold");
    const gold = loot.filter(item => item.kind === "gold").reduce((sum, item) => sum + item.value, 0);
    assert.equal(game.snapshot.interactions.chests.find(item => item.id.includes(chest.id)).opened, true);
    assert.ok(items.length >= 4 && items.length <= 6, "treasure chests drop 4-6 items");
    assert.ok(gold >= 24 && gold <= 39, "treasure chest gold stays in the original range");
    assert.ok(items.every(item =>
      ["herb", "sapphire", "ruby", "emerald", "mana", "amethyst"].includes(item.kind)));
  } finally {
    game.dispose();
  }
}

{
  const sections = makeSections();
  const chest = add(sections[0], "cached-chest", "item-chest", { x: 1968, y: 1040 });
  const preview = createConnectedPreview(sections, { ...options });
  const game = await createLocalGame(preview.options);
  const renderer = mountInteractionRenderer(preview);
  try {
    const frame = step(game);
    const openedChest = frame.snapshot.interactions.chests.find(item => item.id.includes(chest.id));
    assert.equal(openedChest?.opened, true, "the chest opens automatically as the player approaches");
    renderer.render(frame.snapshot);
    assert.equal(renderer.worldFilterDraws, 0, "opened chest art uses no world-Canvas filter");
    assert.deepEqual(renderer.offscreenFilterDraws, ["brightness(0.5) saturate(0.6)"],
      "the opened-chest dim filter is applied once to a cached image");
    renderer.render(frame.snapshot);
    assert.equal(renderer.offscreenFilterDraws.length, 1, "subsequent renders reuse the cached image");
    const secondChest = { ...openedChest, id: "second-open-chest" };
    renderer.render({ ...frame.snapshot, interactions: {
      ...frame.snapshot.interactions, chests: [...frame.snapshot.interactions.chests, secondChest]
    } });
    assert.equal(renderer.offscreenFilterDraws.length, 1, "chests sharing an asset share the cached image");
    renderer.render({ ...frame.snapshot, interactions: {
      ...frame.snapshot.interactions, chests: [{ ...secondChest, opened: false, tier: "treasure" }]
    } });
  } finally {
    game.dispose();
    renderer.dispose();
  }
}

console.log("Astraeum interactions: once-only pickups and chest opening, healing-herb rules, original normal and treasure loot, decorative props, both seam axes, revisits, saved-design nonmutation, and cached opened-chest rendering passed.");
