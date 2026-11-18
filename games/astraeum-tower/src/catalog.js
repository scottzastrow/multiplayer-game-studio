// Asset/object catalog for Astraeum Tower designs. Pure data: no image loading,
// so the Studio service can validate documents with the same definitions.

export const ARTWORK_CREDIT = "Anh Nguyen (PixelLab)";

export const OBJECT_TYPES = Object.freeze({
  "terrain-tile": Object.freeze({ label: "Terrain tile", layer: "terrain" }),
  wall: Object.freeze({ label: "Wall", layer: "walls" }),
  prop: Object.freeze({ label: "Prop", layer: "props" }),
  item: Object.freeze({ label: "Item", layer: "items" }),
  spawn: Object.freeze({ label: "Character spawn", layer: "spawns" }),
  collision: Object.freeze({ label: "Collision box", layer: "collision" })
});

export const DESIGN_LAYERS = Object.freeze([
  Object.freeze({ id: "terrain", name: "Terrain", order: 0 }),
  Object.freeze({ id: "walls", name: "Walls", order: 1 }),
  Object.freeze({ id: "props", name: "Props", order: 2 }),
  Object.freeze({ id: "items", name: "Items", order: 3 }),
  Object.freeze({ id: "spawns", name: "Character spawns", order: 4 }),
  Object.freeze({ id: "collision", name: "Collision boxes", order: 5 })
]);

// play: "implemented" renders/behaves in Play, "partial" has limited Play
// behaviour (described by playNote), "editor-only" has no gameplay yet.
// pivot: sprite pixel placed at the object's transform. snap: where the pivot
// sits inside a 32 px cell when snapped; forced snap always applies.
// collision: "required" | "optional" | "none"; collisionBox is relative to the transform.
function asset(definition) {
  const size = definition.size ?? (definition.artwork
    ? { width: definition.artwork.region.width, height: definition.artwork.region.height }
    : { width: 20, height: 20 });
  return Object.freeze({ collision: "none", collisionBox: null, legacyMarker: null, unique: false,
    alpha: 1, light: null, ...definition,
    interaction: definition.interaction ? Object.freeze({ ...definition.interaction }) : null,
    size: Object.freeze(size) });
}

function region(image, file, x, y, width, height) {
  return Object.freeze({ image, file, region: Object.freeze({ x, y, width, height }) });
}

export const ASSET_CATALOG = Object.freeze({
  "floor-cobblestone": asset({
    type: "terrain-tile", label: "Cobblestone floor", paint: "terrain",
    artwork: region("wang", "damp-corridors-wang.png", 64, 32, 32, 32),
    pivot: { x: 0, y: 0 }, snap: { x: 0, y: 0, forced: true },
    play: "implemented", playNote: "Walkable floor; drawn with the Damp Corridors Wang autotile.",
    details: "Wang sheet tile 6 (all floor) · 32 × 32"
  }),
  "wall-damp-stone": asset({
    type: "wall", label: "Damp stone wall", paint: "static",
    artwork: region("wang", "damp-corridors-wang.png", 0, 96, 32, 32),
    autotile: "damp-corridors-wang",
    pivot: { x: 0, y: 0 }, snap: { x: 0, y: 0, forced: false },
    collision: "required", collisionBox: { x: 0, y: 0, width: 32, height: 32 },
    play: "implemented",
    playNote: "Blocks movement. Grid-aligned walls join the Wang autotile; off-grid walls use the solid-wall tile.",
    details: "Wang sheet tile 12 (all wall) · 32 × 32 · collision"
  }),
  "prop-barrel": asset({
    type: "prop", label: "Barrel", legacyMarker: "B", paint: "static",
    artwork: region("barrel", "barrel.png", 0, 0, 22, 30),
    pivot: { x: 11, y: 28 }, snap: { x: 16, y: 24, forced: false },
    collision: "optional", collisionBox: { x: -9, y: -8, width: 18, height: 8 },
    play: "implemented", playNote: "Decorative in Play. The original game defines no attack rule, durability or drops. Collision is optional (off for the original Floor 1 props).",
    details: "22 × 30 · optional 18 × 8 collision"
  }),
  "prop-crate": asset({
    type: "prop", label: "Crate", legacyMarker: "X", paint: "static",
    artwork: region("crate", "crate.png", 0, 0, 28, 30),
    pivot: { x: 14, y: 28 }, snap: { x: 16, y: 24, forced: false },
    collision: "optional", collisionBox: { x: -12, y: -10, width: 24, height: 10 },
    play: "implemented", playNote: "Decorative in Play. The original game defines no attack rule, durability or drops. Collision is optional (off for the original Floor 1 props).",
    details: "28 × 30 · optional 24 × 10 collision"
  }),
  "prop-pots": asset({
    type: "prop", label: "Clay pots", legacyMarker: "o", paint: "static",
    artwork: region("pots", "pots.png", 0, 0, 30, 29),
    pivot: { x: 15, y: 27 }, snap: { x: 16, y: 24, forced: false },
    collision: "optional", collisionBox: { x: -12, y: -8, width: 24, height: 8 },
    play: "implemented", playNote: "Decorative in Play. The original game defines no attack rule, durability or drops. Collision is optional (off for the original Floor 1 props).",
    details: "30 × 29 · optional 24 × 8 collision"
  }),
  "prop-candle": asset({
    type: "prop", label: "Candle", paint: "static",
    artwork: region("candle", "candle.png", 0, 0, 18, 27),
    pivot: { x: 9, y: 27 }, snap: { x: 16, y: 24, forced: false },
    light: { offsetY: -23, radius: 80, color: "#ffc070" },
    play: "implemented", playNote: "Rendered in Play with the original flickering candle light.",
    details: "18 × 27 · warm light"
  }),
  "prop-stairs-rune": asset({
    type: "prop", label: "Stairs portal", legacyMarker: ">", unique: false, repeatable: false,
    artwork: region("rune", "rune.png", 0, 0, 114, 113),
    alpha: 0.85,
    pivot: { x: 57, y: 48 }, snap: { x: 16, y: 16, forced: true },
    light: { offsetY: 8, radius: 70, color: "#a070ff", steady: true },
    play: "implemented", playNote: "Level exit: after defeating all authored slimes, enter the rune's activation area to continue automatically. Select a destination level and Aries start in the Inspector. Unconfigured exits report an error; doors remain decorative.",
    details: "114 × 113 rune · violet light · authored level exit"
  }),
  "item-chest": asset({
    type: "item", label: "Treasure chest", legacyMarker: "C",
    interaction: { kind: "chest", defaultTier: "normal" },
    artwork: region("chest", "chest.png", 0, 0, 40, 37),
    pivot: { x: 20, y: 34 }, snap: { x: 16, y: 24, forced: false },
    collision: "optional", collisionBox: { x: -16, y: -10, width: 32, height: 10 },
    play: "implemented", playNote: "Opens automatically once within 46 px. Normal chests use the original Floor 1 loot table; choose Normal or Treasure tier in the Inspector.",
    details: "40 × 37 · opens once when Aries approaches within 46 px"
  }),
  "item-herb": asset({
    type: "item", label: "Healing herb", legacyMarker: "h",
    interaction: { kind: "pickup", item: "herb", count: 1, planted: true },
    artwork: region("herb", "herb.png", 0, 0, 32, 38), size: { width: 19, height: 22 },
    pivot: { x: 10, y: 22 }, snap: { x: 16, y: 24, forced: false },
    play: "implemented", playNote: "Auto-collected once nearby. Press H to use one and restore up to 30 HP; a full-health use does not consume it.",
    details: "drawn 19 × 22 · +1 herb · H restores up to 30 HP"
  }),
  "item-mushroom": asset({
    type: "item", label: "Glowcap mushroom", legacyMarker: "m", artwork: null,
    interaction: { kind: "pickup", item: "mushroom", count: 1 },
    placeholder: { glyph: "m", color: "#5fe0d8" },
    pivot: { x: 10, y: 20 }, snap: { x: 16, y: 24, forced: false },
    play: "implemented", playNote: "Auto-collected once nearby and added to the original run inventory; no Studio use effect is defined.",
    details: "no artwork · +1 inventory item"
  }),
  "item-amethyst": asset({
    type: "item", label: "Amethyst", legacyMarker: "a",
    interaction: { kind: "pickup", item: "amethyst", count: 1 },
    artwork: region("amethyst", "amethyst.png", 0, 0, 24, 29), size: { width: 11, height: 13 },
    pivot: { x: 6, y: 13 }, snap: { x: 16, y: 24, forced: false },
    play: "implemented", playNote: "Auto-collected once nearby and added to the original gem inventory.",
    details: "drawn 11 × 13 · +1 gem"
  }),
  "item-sapphire": asset({
    type: "item", label: "Sapphire", legacyMarker: "z",
    interaction: { kind: "pickup", item: "sapphire", count: 1 },
    artwork: region("sapphire", "sapphire.png", 0, 0, 20, 28), size: { width: 9, height: 13 },
    pivot: { x: 5, y: 13 }, snap: { x: 16, y: 24, forced: false },
    play: "implemented", playNote: "Auto-collected once nearby and added to the original gem inventory.",
    details: "drawn 9 × 13 · +1 gem"
  }),
  "spawn-aries": asset({
    type: "spawn", label: "Aries start", legacyMarker: "P", unique: true, required: true,
    artwork: region("ariesIdle", "aries-idle.png", 10, 3, 41, 57),
    pivot: { x: 21, y: 48 }, snap: { x: 16, y: 16, forced: true },
    play: "implemented", playNote: "Player start used by Play. Spawns stay centred on cells (runtime requirement).",
    details: "idle frame region 41 × 57 · player start"
  }),
  "spawn-slime": asset({
    type: "spawn", label: "Slime spawn", legacyMarker: "s", artwork: null,
    placeholder: { glyph: "s", color: "#7fd36b" },
    pivot: { x: 10, y: 10 }, snap: { x: 16, y: 16, forced: true },
    play: "implemented", playNote: "Spawns the original green slime: 36 HP, hop-chase movement and 12 contact damage. The Halberd can damage and defeat it; its static procedural drawing uses no sprite frames.",
    details: "procedural slime · 36 HP · hop-chase · contact damage and combat"
  }),
  "collision-box": asset({
    type: "collision", label: "Collision box", artwork: null, size: { width: 32, height: 32 },
    pivot: { x: 0, y: 0 }, snap: { x: 0, y: 0, forced: false },
    collision: "required", collisionBox: { x: 0, y: 0, width: 32, height: 32 },
    play: "implemented", playNote: "Invisible blocker in Play. It has no artwork and is not a wall.",
    details: "invisible 32 × 32 blocker"
  })
});

export const LEGACY_MARKER_ASSETS = Object.freeze(Object.fromEntries(
  Object.entries(ASSET_CATALOG)
    .filter(([, definition]) => definition.legacyMarker)
    .map(([id, definition]) => [definition.legacyMarker, id])
));
