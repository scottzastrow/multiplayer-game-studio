import { isProjectMapId } from "../../../studio/project-identity.js";

export const MODEL = "generic-grid-v1";
export const MAP_CELL_SIZE = 32;
export const DEFAULT_DIMENSIONS = Object.freeze({ width: 640, height: 480 });
export const DESIGN_LAYERS = Object.freeze([
  { id: "terrain", name: "Terrain", order: 0 },
  { id: "walls", name: "Blocks", order: 1 },
  { id: "props", name: "Markers", order: 2 },
  { id: "spawns", name: "Player spawns", order: 3 },
  { id: "collision", name: "Collision boxes", order: 4 }
]);
export const OBJECT_TYPES = Object.freeze({
  "terrain-tile": { label: "Terrain tile", layer: "terrain" },
  wall: { label: "Block", layer: "walls" },
  prop: { label: "Marker", layer: "props" },
  spawn: { label: "Player spawn", layer: "spawns" },
  collision: { label: "Collision box", layer: "collision" }
});
function primitive(label, type, color, { blocking = false, required = false } = {}) {
  return Object.freeze({
    label, type, color, size: { width: 32, height: 32 }, pivot: { x: 0, y: 0 },
    snap: { forced: type !== "prop", x: 0, y: 0 },
    collision: blocking ? "required" : "none",
    collisionBox: blocking ? { x: 0, y: 0, width: 32, height: 32 } : null,
    required, unique: required, artwork: null, play: "implemented",
    details: "Built-in generic shape; no imported artwork.",
    playNote: type === "collision" ? "Invisible blocker in Play." : "Visible in the movement preview."
  });
}
export const ASSET_CATALOG = Object.freeze({
  "generic-tile": primitive("Plain tile", "terrain-tile", "#c5d0d8"),
  "generic-block": primitive("Solid block", "wall", "#52616b", { blocking: true }),
  "generic-marker": primitive("Marker", "prop", "#cf9c42"),
  "generic-player": primitive("Player start", "spawn", "#087f5b", { required: true }),
  "generic-player-2": primitive("Second player start", "spawn", "#287eb4", { required: true }),
  "generic-collision": primitive("Collision box", "collision", "#db7182", { blocking: true })
});

function exact(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) {
    throw new TypeError(`${label} must contain exactly ${keys.join(", ")}.`);
  }
}
export function validateCreation(input) {
  exact(input, ["name", "author", "width", "height", "model"], "New game");
  if (input.model !== MODEL) throw new TypeError("Select the supported Generic Grid v1 model.");
  for (const [key, max] of [["name", 64], ["author", 128]]) {
    if (typeof input[key] !== "string" || !input[key].trim() || input[key].trim().length > max ||
        /[\u0000-\u001f\u007f]/.test(input[key])) {
      throw new TypeError(`${key === "name" ? "Game name" : "Author/credits"} must be nonblank and at most ${max} characters, without control characters.`);
    }
  }
  validateDimensions(input);
  return { ...input, name: input.name.trim(), author: input.author.trim() };
}
export function validateDimensions({ width, height }) {
  for (const [key, value] of Object.entries({ width, height })) {
    if (!Number.isInteger(value) || value < 64 || value > 2048 || value % 32 !== 0) {
      throw new TypeError(`Map ${key} must be a multiple of 32 between 64 and 2048 pixels.`);
    }
  }
}
export function createDesignObject(id, assetId, transform, order, assetCatalog = ASSET_CATALOG) {
  const asset = assetCatalog[assetId];
  if (!asset) throw new TypeError(`Unknown generic asset ${assetId}.`);
  return { id, type: asset.type, assetId, layer: OBJECT_TYPES[asset.type].layer, order,
    transform: { ...transform }, collision: asset.collisionBox ? { ...asset.collisionBox } : null };
}
export function createDocument(id, name, bounds) {
  validateDimensions(bounds);
  const x = Math.floor(bounds.width / 64) * 32;
  const y = Math.floor(bounds.height / 64) * 32;
  return validateFloorDocument({
    formatVersion: 1, id, name, cellSize: 32, bounds: { ...bounds },
    layers: DESIGN_LAYERS.map(layer => ({ ...layer })),
    objects: [
      createDesignObject("player-start", "generic-player", { x, y }, 0),
      createDesignObject("player-start-2", "generic-player-2", { x: x - 32, y }, 1)
    ]
  });
}
export function validateFloorDocument(document, assetCatalog = ASSET_CATALOG) {
  exact(document, ["formatVersion", "id", "name", "cellSize", "bounds", "layers", "objects"], "Generic document");
  if (document.formatVersion !== 1 || document.cellSize !== 32 || !isProjectMapId(document.id) ||
      typeof document.name !== "string" || !document.name.trim() || document.name.length > 64) {
    throw new TypeError("Invalid Generic Grid v1 document identity or version.");
  }
  exact(document.bounds, ["width", "height"], "Bounds");
  validateDimensions(document.bounds);
  if (JSON.stringify(document.layers) !== JSON.stringify(DESIGN_LAYERS)) throw new TypeError("Invalid generic layers.");
  if (!Array.isArray(document.objects) || document.objects.length > 4000) throw new TypeError("At most 4000 objects are allowed.");
  const ids = new Set();
  const unique = new Set();
  const terrain = new Set();
  for (const object of document.objects) {
    exact(object, ["id", "type", "assetId", "layer", "order", "transform", "collision"], "Object");
    const asset = assetCatalog[object.assetId];
    if (!asset || object.type !== asset.type || object.layer !== OBJECT_TYPES[asset.type].layer ||
        !isProjectMapId(object.id) || ids.has(object.id) || !Number.isSafeInteger(object.order) || object.order < 0) {
      throw new TypeError("Invalid or duplicate generic object identity, asset, layer or order.");
    }
    ids.add(object.id);
    exact(object.transform, ["x", "y"], "Transform");
    const { x, y } = object.transform;
    const bounds = objectBounds(object, assetCatalog);
    if (![x, y].every(Number.isInteger) || bounds.x < 0 || bounds.y < 0 ||
        bounds.x + bounds.width > document.bounds.width || bounds.y + bounds.height > document.bounds.height ||
        (asset.snap.forced && (x % 32 || y % 32))) throw new TypeError(`Invalid transform for ${object.id}.`);
    if (JSON.stringify(object.collision) !== JSON.stringify(asset.collisionBox)) {
      throw new TypeError(`Invalid generic collision for ${object.id}.`);
    }
    if (asset.unique) {
      if (unique.has(object.assetId)) throw new TypeError(`Only one ${asset.label} is allowed.`);
      unique.add(object.assetId);
    }
    if (object.type === "terrain-tile") {
      const cell = `${x},${y}`;
      if (terrain.has(cell)) throw new TypeError("Duplicate terrain cell.");
      terrain.add(cell);
    }
  }
  for (const [id, asset] of Object.entries(ASSET_CATALOG)) {
    if (asset.required && !unique.has(id)) throw new TypeError(`${asset.label} is required.`);
  }
  return document;
}
export const objectBounds = (object, assetCatalog = ASSET_CATALOG) => {
  const asset = assetCatalog[object.assetId];
  return { x: object.transform.x - asset.pivot.x, y: object.transform.y - asset.pivot.y,
    width: asset.size.width, height: asset.size.height };
};
export const collisionRect = object => object.collision
  ? { x: object.transform.x + object.collision.x, y: object.transform.y + object.collision.y,
    width: object.collision.width, height: object.collision.height }
  : null;
export const transformAtPoint = (assetId, point, assetCatalog = ASSET_CATALOG) => {
  const asset = assetCatalog[assetId];
  return { x: Math.round(point.x - asset.size.width / 2 + asset.pivot.x),
    y: Math.round(point.y - asset.size.height / 2 + asset.pivot.y) };
};
export const snapTransform = (assetId, point, assetCatalog = ASSET_CATALOG) => {
  const snap = assetCatalog[assetId].snap;
  return { x: Math.round((point.x - snap.x) / 32) * 32 + snap.x,
    y: Math.round((point.y - snap.y) / 32) * 32 + snap.y };
};
export const clampTransform = (assetId, point, bounds, assetCatalog = ASSET_CATALOG) => {
  const asset = assetCatalog[assetId];
  return {
    x: Math.max(asset.pivot.x, Math.min(bounds.width - asset.size.width + asset.pivot.x, point.x)),
    y: Math.max(asset.pivot.y, Math.min(bounds.height - asset.size.height + asset.pivot.y, point.y))
  };
};
function ordered(document) {
  return [...document.objects].sort((a, b) =>
    DESIGN_LAYERS.find(layer => layer.id === a.layer).order - DESIGN_LAYERS.find(layer => layer.id === b.layer).order ||
    a.order - b.order);
}
export function hitTest(document, point, selectable, assetCatalog = ASSET_CATALOG) {
  return ordered(document).reverse().find(object => {
    if (!selectable(object)) return false;
    const bounds = objectBounds(object, assetCatalog);
    return point.x >= bounds.x && point.x < bounds.x + bounds.width &&
      point.y >= bounds.y && point.y < bounds.y + bounds.height;
  }) ?? null;
}
export const isUnresolvedCollision = () => false;
export const floorDocumentGrid = () => null;
export function playStartProblems(document, assetCatalog = ASSET_CATALOG) {
  const blocks = document.objects.filter(object => object.collision);
  const spawns = document.objects.filter(object => object.type === "spawn");
  const problems = spawns.filter(spawn => blocks.some(block => {
    const dx = Math.max(block.transform.x - (spawn.transform.x + 16), 0, spawn.transform.x + 16 - block.transform.x - 32);
    const dy = Math.max(block.transform.y - (spawn.transform.y + 16), 0, spawn.transform.y + 16 - block.transform.y - 32);
    return dx * dx + dy * dy < 64;
  })).map(spawn => `${assetCatalog[spawn.assetId].label} is blocked; move the spawn or blocker.`);
  if (spawns[0].transform.x === spawns[1].transform.x && spawns[0].transform.y === spawns[1].transform.y) {
    problems.push("Player starts must occupy distinct cells; move one start.");
  }
  return problems;
}
export function createFloorMap(document, assetCatalog = ASSET_CATALOG) {
  validateFloorDocument(document, assetCatalog);
  const blocks = document.objects.filter(object => object.collision);
  return {
    formatVersion: 1, id: document.id, name: document.name, bounds: { ...document.bounds }, cellSize: 32,
    objects: blocks.map(object => ({ id: object.id, typeId: "generic-block",
      position: { x: object.transform.x + 16, y: object.transform.y + 16 } })),
    collisions: blocks.map(object => ({ id: object.id, objectId: object.id,
      shape: { type: "rect", width: 32, height: 32 } })),
    spawns: document.objects.filter(object => object.type === "spawn").map(object => ({
      id: object.id, kind: "player", position: { x: object.transform.x + 16, y: object.transform.y + 16 }, radius: 8
    }))
  };
}
export function drawAsset(context, artwork, assetId, transform, { alpha = 1, assetCatalog = ASSET_CATALOG } = {}) {
  const asset = assetCatalog[assetId];
  const bounds = objectBounds({ assetId, transform }, assetCatalog);
  context.save();
  context.globalAlpha = alpha;
  if (asset.imported) {
    const image = artwork.imported[assetId];
    context.drawImage(image, 0, 0, image.naturalWidth, image.naturalHeight,
      bounds.x, bounds.y, bounds.width, bounds.height);
  } else {
    context.fillStyle = asset.color;
    if (asset.type === "spawn" || asset.type === "prop") {
      context.beginPath();
      context.arc(transform.x + 16, transform.y + 16, asset.type === "spawn" ? 8 : 12, 0, Math.PI * 2);
      context.fill();
    } else context.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
  }
  context.restore();
  return bounds;
}
export function drawDesign(context, artwork, document, { mode = "editor", visible = {}, assetCatalog = ASSET_CATALOG } = {}) {
  context.fillStyle = "#eef4f7";
  context.fillRect(0, 0, document.bounds.width, document.bounds.height);
  for (const object of ordered(document)) {
    if (visible[object.layer] === false || (mode === "play" && ["spawn", "collision"].includes(object.type))) continue;
    drawAsset(context, artwork, object.assetId, object.transform, {
      alpha: object.type === "collision" ? 0.5 : 1, assetCatalog
    });
  }
}
