import floor1 from "./floor1.json" with { type: "json" };
import {
  ASSET_CATALOG,
  DESIGN_LAYERS,
  LEGACY_MARKER_ASSETS,
  OBJECT_TYPES
} from "./catalog.js";

export const MAP_CELL_SIZE = 32;
export const DESIGN_FORMAT_VERSION = 2;
export const MAX_DESIGN_OBJECTS = 4000;
export const FLOOR1_GRID = Object.freeze(floor1.f1);
export const FLOOR1_COLUMNS = FLOOR1_GRID[0].length;
export const FLOOR1_ROWS = FLOOR1_GRID.length;
export const FLOOR1_BOUNDS = Object.freeze({
  width: FLOOR1_COLUMNS * MAP_CELL_SIZE,
  height: FLOOR1_ROWS * MAP_CELL_SIZE
});
const DESIGN_ID = "astraeum-tower-floor-1";
const DESIGN_NAME = "Damp Corridors";
const IDENTIFIER = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const OBJECT_KEYS = new Set(["id", "type", "assetId", "layer", "order", "transform", "collision", "migration"]);
const LAYER_ORDER = Object.freeze(Object.fromEntries(DESIGN_LAYERS.map(layer => [layer.id, layer.order])));

export { ASSET_CATALOG, DESIGN_LAYERS, OBJECT_TYPES };

function fail(message) {
  throw new TypeError(message);
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) {
    fail(`${label} must contain exactly: ${keys.join(", ")}.`);
  }
}

function sameRect(left, right) {
  return left.x === right.x && left.y === right.y &&
    left.width === right.width && left.height === right.height;
}

export function assetFor(object, assetCatalog = ASSET_CATALOG) {
  const asset = assetCatalog[object.assetId];
  if (!asset) fail(`Unknown asset ${object.assetId}.`);
  return asset;
}

export function objectBounds(object, assetCatalog = ASSET_CATALOG) {
  const asset = assetFor(object, assetCatalog);
  return {
    x: object.transform.x - asset.pivot.x,
    y: object.transform.y - asset.pivot.y,
    width: asset.size.width,
    height: asset.size.height
  };
}

export function collisionRect(object) {
  if (!object.collision) return null;
  return {
    x: object.transform.x + object.collision.x,
    y: object.transform.y + object.collision.y,
    width: object.collision.width,
    height: object.collision.height
  };
}

export function isAutotiledWall(object) {
  return object.type === "wall" &&
    object.transform.x % MAP_CELL_SIZE === 0 && object.transform.y % MAP_CELL_SIZE === 0;
}

export function snapTransform(assetId, transform, assetCatalog = ASSET_CATALOG) {
  const { snap } = assetCatalog[assetId];
  return {
    x: Math.round((transform.x - snap.x) / MAP_CELL_SIZE) * MAP_CELL_SIZE + snap.x,
    y: Math.round((transform.y - snap.y) / MAP_CELL_SIZE) * MAP_CELL_SIZE + snap.y
  };
}

export function clampTransform(assetId, transform, bounds = FLOOR1_BOUNDS, assetCatalog = ASSET_CATALOG) {
  const asset = assetCatalog[assetId];
  const clampAxis = (value, pivot, size, limit) =>
    Math.min(limit - size + pivot, Math.max(pivot, value));
  let next = {
    x: clampAxis(transform.x, asset.pivot.x, asset.size.width, bounds.width),
    y: clampAxis(transform.y, asset.pivot.y, asset.size.height, bounds.height)
  };
  if (asset.snap.forced) {
    next = snapTransform(assetId, next, assetCatalog);
    const step = (value, pivot, size, limit) => {
      while (value - pivot < 0) value += MAP_CELL_SIZE;
      while (value - pivot + size > limit) value -= MAP_CELL_SIZE;
      return value;
    };
    next = {
      x: step(next.x, asset.pivot.x, asset.size.width, bounds.width),
      y: step(next.y, asset.pivot.y, asset.size.height, bounds.height)
    };
  }
  return next;
}

/** Transform that centres the asset's drawn bounds on a world point. */
export function transformAtPoint(assetId, point, assetCatalog = ASSET_CATALOG) {
  const asset = assetCatalog[assetId];
  return {
    x: Math.round(point.x - asset.size.width / 2 + asset.pivot.x),
    y: Math.round(point.y - asset.size.height / 2 + asset.pivot.y)
  };
}

export function createDesignObject(id, assetId, transform, order, { collision } = {}, assetCatalog = ASSET_CATALOG) {
  const asset = assetCatalog[assetId];
  if (!asset) fail(`Unknown asset ${assetId}.`);
  const withCollision = collision ?? asset.collision === "required";
  return {
    id,
    type: asset.type,
    assetId,
    layer: OBJECT_TYPES[asset.type].layer,
    order,
    transform: { x: transform.x, y: transform.y },
    collision: withCollision && asset.collisionBox ? { ...asset.collisionBox } : null
  };
}

// ---------------------------------------------------------------- unresolved collision

export const UNRESOLVED_COLLISION_SOURCE = "format-1-wall";

/**
 * A former format 1 wall that the migration could not map to wall artwork (it was
 * off the 32 px grid and drawn with the floor tile). It still blocks movement until
 * the user assigns artwork, keeps it deliberately, or deletes it.
 */
export function isUnresolvedCollision(object) {
  return object.type === "collision" && object.migration?.from === UNRESOLVED_COLLISION_SOURCE;
}

/** Assets with artwork that may replace an unresolved collision box. */
export function artworkReplacementAssets() {
  return Object.keys(ASSET_CATALOG).filter(assetId => {
    const asset = ASSET_CATALOG[assetId];
    return asset.artwork && ["wall", "prop", "item"].includes(asset.type) && !asset.unique;
  });
}

function sameAbsoluteRect(left, right) {
  return Boolean(left && right) && sameRect(left, right);
}

/**
 * Plans replacing an unresolved collision box with an artwork asset. Walls keep the
 * exact transform and collision; other assets are centred on the box and use their
 * own collision, which the outcome states explicitly before anything changes.
 */
export function planArtworkReplacement(object, assetId) {
  const asset = ASSET_CATALOG[assetId];
  if (!isUnresolvedCollision(object)) fail(`${object.id} is not an unresolved collision box.`);
  if (!artworkReplacementAssets().includes(assetId)) fail(`${assetId} cannot replace a collision box.`);
  const before = collisionRect(object);
  const transform = asset.type === "wall"
    ? { ...object.transform }
    : clampTransform(assetId, transformAtPoint(assetId, {
      x: before.x + before.width / 2, y: before.y + before.height / 2
    }));
  const collision = asset.collisionBox && asset.collision !== "none" ? { ...asset.collisionBox } : null;
  const after = collision ? collisionRect({ transform, collision }) : null;
  const outcome = sameAbsoluteRect(before, after) ? "identical" : after ? "changed" : "removed";
  const text = outcome === "identical"
    ? `Collision stays identical: ${before.width} × ${before.height} at ${before.x}, ${before.y}.`
    : outcome === "changed"
      ? `Collision changes from ${before.width} × ${before.height} at ${before.x}, ${before.y} to the ` +
        `${asset.label.toLowerCase()} footprint ${after.width} × ${after.height} at ${after.x}, ${after.y}.`
      : `Collision is removed: ${asset.label} has no collision, so this spot becomes walkable.`;
  return { assetId, transform, collision, outcome, text };
}

function nextLayerOrder(document, layer) {
  return Math.max(-1, ...document.objects.filter(item => item.layer === layer).map(item => item.order)) + 1;
}

/** Replaces an unresolved collision box with artwork, keeping its stable ID. */
export function assignArtworkToCollision(document, id, assetId) {
  const object = document.objects.find(item => item.id === id);
  if (!object) fail(`Object ${id} does not exist.`);
  const plan = planArtworkReplacement(object, assetId);
  const asset = ASSET_CATALOG[assetId];
  const layer = OBJECT_TYPES[asset.type].layer;
  const replacement = {
    ...createDesignObject(id, assetId, plan.transform, nextLayerOrder(document, layer),
      { collision: Boolean(plan.collision) }),
    migration: {
      from: "format-1-wall-resolved",
      note: `Migrated from an off-grid format 1 wall as an unresolved collision box; ${asset.label} ` +
        `artwork assigned in Studio. ${plan.text}`
    }
  };
  return { ...document, objects: document.objects.map(item => item.id === id ? replacement : item) };
}

/** Keeps an unresolved collision box deliberately as an invisible blocker. */
export function keepCollisionBox(document, id) {
  const object = document.objects.find(item => item.id === id);
  if (!object || !isUnresolvedCollision(object)) fail(`${id} is not an unresolved collision box.`);
  const migration = {
    from: "format-1-wall-kept",
    note: "Migrated from an off-grid format 1 wall; kept in Studio as an intentional collision-only box " +
      "(no artwork, still blocks movement in Play)."
  };
  return { ...document, objects: document.objects.map(item => item.id === id ? { ...item, migration } : item) };
}

function emptyDesign() {
  return {
    formatVersion: DESIGN_FORMAT_VERSION,
    id: DESIGN_ID,
    name: DESIGN_NAME,
    cellSize: MAP_CELL_SIZE,
    bounds: { ...FLOOR1_BOUNDS },
    layers: DESIGN_LAYERS.map(layer => ({ ...layer })),
    objects: []
  };
}

function markerObjectId(assetId, x, y) {
  if (assetId === "spawn-aries") return "aries-start";
  return `${assetId.slice(assetId.indexOf("-") + 1)}-${x}-${y}`;
}

function markerTransform(assetId, x, y) {
  const { snap } = ASSET_CATALOG[assetId];
  return { x: x * MAP_CELL_SIZE + snap.x, y: y * MAP_CELL_SIZE + snap.y };
}

function nextOrders() {
  const orders = new Map();
  return layer => {
    const order = orders.get(layer) ?? 0;
    orders.set(layer, order + 1);
    return order;
  };
}

function assertTemplateGrid(grid) {
  if (!Array.isArray(grid) || grid.length !== FLOOR1_ROWS ||
      !grid.every(row => typeof row === "string" && row.length === FLOOR1_COLUMNS)) {
    fail(`The Floor 1 grid must be ${FLOOR1_COLUMNS} × ${FLOOR1_ROWS} cells.`);
  }
}

function terrainAndMarkers(grid, { walls }) {
  const terrain = [];
  const wallObjects = [];
  const markers = [];
  for (let y = 0; y < grid.length; y += 1) {
    for (let x = 0; x < grid[y].length; x += 1) {
      const cell = grid[y][x];
      terrain.push(createDesignObject(`terrain-${x}-${y}`, "floor-cobblestone",
        { x: x * MAP_CELL_SIZE, y: y * MAP_CELL_SIZE }, 0));
      if (cell === "#") {
        if (!walls) fail(`Unexpected wall marker at ${x},${y}.`);
        wallObjects.push(createDesignObject(`wall-${x}-${y}`, "wall-damp-stone",
          { x: x * MAP_CELL_SIZE, y: y * MAP_CELL_SIZE }, 0));
        continue;
      }
      if (cell === ".") continue;
      const assetId = LEGACY_MARKER_ASSETS[cell];
      if (!assetId) fail(`Unsupported Floor 1 marker "${cell}" at ${x},${y}.`);
      markers.push(createDesignObject(markerObjectId(assetId, x, y), assetId,
        markerTransform(assetId, x, y), 0));
    }
  }
  return { terrain, wallObjects, markers };
}

function assignOrders(objects) {
  const nextOrder = nextOrders();
  for (const object of objects) object.order = nextOrder(object.layer);
  return objects;
}

/** Imports the original Floor 1 template grid as a format 2 design. */
export function createFloorDocument(grid = FLOOR1_GRID) {
  assertTemplateGrid(grid);
  const design = emptyDesign();
  const { terrain, wallObjects, markers } = terrainAndMarkers(grid, { walls: true });
  design.objects = assignOrders([...terrain, ...wallObjects, ...markers]);
  return validateFloorDocument(design);
}

export function createBlankDocument(id, name) {
  const design = emptyDesign();
  design.id = id;
  design.name = name;
  for (let y = 0; y < FLOOR1_ROWS; y++) {
    for (let x = 0; x < FLOOR1_COLUMNS; x++) {
      design.objects.push(createDesignObject(`terrain-${x}-${y}`, "floor-cobblestone",
        { x: x * MAP_CELL_SIZE, y: y * MAP_CELL_SIZE }, design.objects.length));
    }
  }
  design.objects.push(createDesignObject("aries-start", "spawn-aries", { x: 80, y: 80 }, 0));
  return validateFloorDocument(design);
}

function validateFormatOne(document) {
  if (!document || document.formatVersion !== 1 || document.id !== DESIGN_ID ||
      document.name !== DESIGN_NAME || document.cellSize !== MAP_CELL_SIZE ||
      !Array.isArray(document.terrain) || document.terrain.length !== FLOOR1_ROWS ||
      !document.terrain.every(row => typeof row === "string" && row.length === FLOOR1_COLUMNS &&
        !row.includes("#")) ||
      !Array.isArray(document.walls) || document.walls.length > 2000) {
    fail("The format 1 Floor 1 document has an unsupported shape.");
  }
  const extra = Object.keys(document).filter(key =>
    !["formatVersion", "id", "name", "cellSize", "terrain", "walls"].includes(key));
  if (extra.length) fail(`The format 1 document has unknown fields: ${extra.join(", ")}.`);
  const ids = new Set();
  for (const wall of document.walls) {
    exactKeys(wall, ["id", "x", "y", "width", "height"], "A format 1 wall");
    if (typeof wall.id !== "string" || !IDENTIFIER.test(wall.id) || ids.has(wall.id) ||
        !Number.isFinite(wall.x) || !Number.isFinite(wall.y) ||
        wall.width !== MAP_CELL_SIZE || wall.height !== MAP_CELL_SIZE ||
        wall.x < 0 || wall.y < 0 || wall.x + wall.width > FLOOR1_BOUNDS.width ||
        wall.y + wall.height > FLOOR1_BOUNDS.height) {
      fail(`Format 1 wall ${String(wall.id)} is invalid.`);
    }
    ids.add(wall.id);
  }
}

/**
 * Explicit format 1 → 2 migration. Grid-aligned format 1 walls were drawn with the
 * Wang wall artwork and map reliably to walls. Unaligned ones were drawn with the
 * all-floor tile, so they become clearly labelled collision boxes (same collision,
 * no wall label) and are listed in the report; callers keep the original as a backup.
 */
export function migrateFloorDocumentV1(document) {
  validateFormatOne(document);
  const design = emptyDesign();
  const { terrain, markers } = terrainAndMarkers(document.terrain, { walls: false });
  const reservedIds = new Set([...terrain, ...markers].map(object => object.id));
  const converted = [];
  const collisionBoxes = [];
  const walls = [];
  for (const wall of document.walls) {
    if (reservedIds.has(wall.id)) fail(`Format 1 wall ID ${wall.id} conflicts with a template object.`);
    const aligned = wall.x % MAP_CELL_SIZE === 0 && wall.y % MAP_CELL_SIZE === 0;
    if (aligned) {
      converted.push(createDesignObject(wall.id, "wall-damp-stone", { x: wall.x, y: wall.y }, 0));
      walls.push(wall.id);
    } else {
      const box = createDesignObject(wall.id, "collision-box", { x: wall.x, y: wall.y }, 0);
      box.migration = {
        from: "format-1-wall",
        note: `Format 1 wall at (${wall.x}, ${wall.y}) was off the 32 px grid and was drawn ` +
          "with the floor tile, not wall artwork. Kept as a collision-only box with identical " +
          "collision; the original document is kept in the database backup."
      };
      converted.push(box);
      collisionBoxes.push({ id: wall.id, x: wall.x, y: wall.y });
    }
  }
  design.objects = assignOrders([...terrain, ...converted, ...markers]);
  const result = validateFloorDocument(design);
  const positions = new Map();
  for (const wall of document.walls) {
    const key = `${wall.x},${wall.y}`;
    positions.set(key, [...(positions.get(key) ?? []), wall.id]);
  }
  return {
    document: result,
    report: {
      fromVersion: 1,
      toVersion: DESIGN_FORMAT_VERSION,
      terrainTiles: terrain.length,
      markerObjects: markers.length,
      walls: walls.length,
      collisionBoxes,
      overlappingWalls: [...positions.values()].filter(ids => ids.length > 1)
    }
  };
}

function validateObject(input, index, assetCatalog = ASSET_CATALOG) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail(`Object ${index} is invalid.`);
  const unknown = Object.keys(input).filter(key => !OBJECT_KEYS.has(key));
  if (unknown.length) fail(`Object ${String(input.id)} has unknown fields: ${unknown.join(", ")}.`);
  const { id, type, assetId, layer, order, transform, collision, migration } = input;
  if (typeof id !== "string" || !IDENTIFIER.test(id)) fail(`Object ${index} has an invalid ID.`);
  const asset = assetCatalog[assetId];
  if (!asset) fail(`Object ${id} references unknown asset ${String(assetId)}.`);
  if (type !== asset.type) fail(`Object ${id} type ${String(type)} does not match asset ${assetId}.`);
  if (layer !== OBJECT_TYPES[type].layer) fail(`Object ${id} must stay on the ${OBJECT_TYPES[type].layer} layer.`);
  if (!Number.isInteger(order) || order < 0 || order > 1_000_000) fail(`Object ${id} has an invalid order.`);
  exactKeys(transform, ["x", "y"], `Object ${id} transform`);
  if (!Number.isInteger(transform.x) || !Number.isInteger(transform.y)) fail(`Object ${id} transform must use whole pixels.`);
  const object = { id, type, assetId, layer, order, transform: { x: transform.x, y: transform.y }, collision: null };
  const bounds = objectBounds(object, assetCatalog);
  if (bounds.x < 0 || bounds.y < 0 || bounds.x + bounds.width > FLOOR1_BOUNDS.width ||
      bounds.y + bounds.height > FLOOR1_BOUNDS.height) {
    fail(`Object ${id} is outside the Floor 1 bounds.`);
  }
  if (asset.snap.forced && ((transform.x - asset.snap.x) % MAP_CELL_SIZE !== 0 ||
      (transform.y - asset.snap.y) % MAP_CELL_SIZE !== 0)) {
    fail(`Object ${id} must stay aligned to the 32 px grid.`);
  }
  if (collision !== null) {
    exactKeys(collision, ["x", "y", "width", "height"], `Object ${id} collision`);
    if (asset.collision === "none" || !sameRect(collision, asset.collisionBox)) {
      fail(`Object ${id} has collision that its asset does not define.`);
    }
    object.collision = { ...collision };
  } else if (asset.collision === "required") {
    fail(`Object ${id} requires collision.`);
  }
  if (migration !== undefined) {
    exactKeys(migration, ["from", "note"], `Object ${id} migration`);
    if (typeof migration.from !== "string" || migration.from.length > 64 ||
        typeof migration.note !== "string" || migration.note.length > 600) {
      fail(`Object ${id} migration note is invalid.`);
    }
    object.migration = { ...migration };
  }
  return object;
}

/** Validates a format 2 design and returns a normalised copy. Unknown fields are rejected, never dropped. */
export function validateFloorDocument(document, assetCatalog = ASSET_CATALOG) {
  exactKeys(document, ["formatVersion", "id", "name", "cellSize", "bounds", "layers", "objects"],
    "The Floor 1 design");
  if (document.formatVersion !== DESIGN_FORMAT_VERSION) {
    fail(`Unsupported Floor 1 design format ${String(document.formatVersion)}.`);
  }
  if (typeof document.id !== "string" || !IDENTIFIER.test(document.id) ||
      typeof document.name !== "string" || !document.name.trim() || document.name.length > 64 ||
      /[\u0000-\u001f\u007f]/.test(document.name) || document.cellSize !== MAP_CELL_SIZE) {
    fail("The Floor 1 design identity is invalid.");
  }
  exactKeys(document.bounds, ["width", "height"], "Design bounds");
  if (document.bounds.width !== FLOOR1_BOUNDS.width || document.bounds.height !== FLOOR1_BOUNDS.height) {
    fail("The Floor 1 design bounds are invalid.");
  }
  if (!Array.isArray(document.layers) || document.layers.length !== DESIGN_LAYERS.length ||
      !document.layers.every((layer, index) => {
        exactKeys(layer, ["id", "name", "order"], "A design layer");
        const expected = DESIGN_LAYERS[index];
        return layer.id === expected.id && layer.name === expected.name && layer.order === expected.order;
      })) {
    fail("The design layers are invalid.");
  }
  if (!Array.isArray(document.objects) || document.objects.length > MAX_DESIGN_OBJECTS) {
    fail(`A design may contain at most ${MAX_DESIGN_OBJECTS} objects.`);
  }
  const ids = new Set();
  const terrainCells = new Set();
  const uniqueAssets = new Map();
  const objects = document.objects.map((input, index) => {
    const object = validateObject(input, index, assetCatalog);
    if (ids.has(object.id)) fail(`Object ID ${object.id} is not unique.`);
    ids.add(object.id);
    if (object.type === "terrain-tile") {
      const key = `${object.transform.x},${object.transform.y}`;
      if (terrainCells.has(key)) fail(`Two terrain tiles occupy cell ${key}.`);
      terrainCells.add(key);
    }
    uniqueAssets.set(object.assetId, (uniqueAssets.get(object.assetId) ?? 0) + 1);
    return object;
  });
  for (const [assetId, asset] of Object.entries(ASSET_CATALOG)) {
    const count = uniqueAssets.get(assetId) ?? 0;
    if (asset.unique && count > 1) fail(`Only one ${asset.label} is allowed.`);
    if (asset.required && count < 1) fail(`The design needs a ${asset.label}.`);
  }
  return {
    formatVersion: DESIGN_FORMAT_VERSION,
    id: document.id,
    name: document.name,
    cellSize: MAP_CELL_SIZE,
    bounds: { ...FLOOR1_BOUNDS },
    layers: DESIGN_LAYERS.map(layer => ({ ...layer })),
    objects
  };
}

export const DEFAULT_FLOOR_DOCUMENT = Object.freeze(createFloorDocument());

/**
 * Objects in exact draw order. Layers draw in layer order; inside the walls layer the
 * grid-aligned walls are composited by the Wang autotile before off-grid walls.
 * Hit-testing walks this list in reverse so selection always matches what is drawn.
 */
export function renderOrder(design) {
  const rank = object => object.type === "wall" && !isAutotiledWall(object) ? 1 : 0;
  return design.objects
    .map((object, index) => ({ object, index }))
    .sort((left, right) =>
      LAYER_ORDER[left.object.layer] - LAYER_ORDER[right.object.layer] ||
      rank(left.object) - rank(right.object) ||
      left.object.order - right.object.order ||
      left.index - right.index)
    .map(entry => entry.object);
}

export function hitTest(design, point, isSelectable = () => true, assetCatalog = ASSET_CATALOG) {
  const ordered = renderOrder(design);
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const object = ordered[index];
    if (!isSelectable(object)) continue;
    const bounds = objectBounds(object, assetCatalog);
    if (point.x >= bounds.x && point.x < bounds.x + bounds.width &&
        point.y >= bounds.y && point.y < bounds.y + bounds.height) {
      return object;
    }
  }
  return null;
}

/** Floor and Wang-autotiled wall occupancy per cell. */
export function cellOccupancy(design) {
  const floor = Array.from({ length: FLOOR1_ROWS }, () => new Array(FLOOR1_COLUMNS).fill(false));
  const wall = Array.from({ length: FLOOR1_ROWS }, () => new Array(FLOOR1_COLUMNS).fill(false));
  for (const object of design.objects) {
    const x = object.transform.x / MAP_CELL_SIZE;
    const y = object.transform.y / MAP_CELL_SIZE;
    if (object.type === "terrain-tile") floor[y][x] = true;
    else if (isAutotiledWall(object)) wall[y][x] = true;
  }
  return { floor, wall };
}

/**
 * Derived legacy grid used by collision and generated decorations: "#" for aligned
 * walls and cells without floor, otherwise the marker of an object anchored in the
 * cell ("*" for objects without a Floor 1 marker), otherwise ".".
 */
export function floorDocumentGrid(document, assetCatalog = ASSET_CATALOG) {
  const design = validateFloorDocument(document, assetCatalog);
  const { floor, wall } = cellOccupancy(design);
  const rows = floor.map((row, y) => row.map((hasFloor, x) => hasFloor && !wall[y][x] ? "." : "#"));
  for (const object of design.objects) {
    if (!["prop", "item", "spawn"].includes(object.type)) continue;
    const x = Math.floor(object.transform.x / MAP_CELL_SIZE);
    const y = Math.floor(object.transform.y / MAP_CELL_SIZE);
    if (rows[y]?.[x] === ".") rows[y][x] = assetFor(object, assetCatalog).legacyMarker ?? "*";
  }
  return rows.map(row => row.join(""));
}

export function collisionRects(document) {
  return document.objects.map(collisionRect).filter(Boolean);
}

function hashPhase(id) {
  let hash = 2166136261;
  for (const character of id) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  return (hash / 4294967296) * 6;
}

/** Lights emitted by placed objects (stairs portal, placed candles). */
export function objectLights(design, assetCatalog = ASSET_CATALOG) {
  return design.objects.flatMap(object => {
    const { light } = assetFor(object, assetCatalog);
    if (!light) return [];
    return [{
      id: object.id,
      x: object.transform.x,
      y: object.transform.y + light.offsetY,
      radius: light.radius,
      color: light.color,
      steady: Boolean(light.steady),
      phase: hashPhase(object.id)
    }];
  });
}

/** Problems that would stop Play from starting, as actionable messages. */
export function playStartProblems(document, assetCatalog = ASSET_CATALOG) {
  const design = validateFloorDocument(document, assetCatalog);
  const start = design.objects.find(object => object.assetId === "spawn-aries");
  const grid = floorDocumentGrid(design, assetCatalog);
  const cell = {
    x: Math.floor(start.transform.x / MAP_CELL_SIZE),
    y: Math.floor(start.transform.y / MAP_CELL_SIZE)
  };
  const problems = [];
  if (grid[cell.y][cell.x] === "#") {
    problems.push(`Aries start is on a wall or empty (no floor) cell at column ${cell.x}, row ${cell.y}. ` +
      "Move the Aries start onto open floor or remove the wall there.");
  }
  const centre = { x: start.transform.x, y: start.transform.y + 4 };
  for (const object of design.objects) {
    const rect = collisionRect(object);
    if (!rect || object.type === "spawn") continue;
    const nearestX = Math.max(rect.x, Math.min(centre.x, rect.x + rect.width));
    const nearestY = Math.max(rect.y, Math.min(centre.y, rect.y + rect.height));
    if (Math.hypot(centre.x - nearestX, centre.y - nearestY) < 4) {
      problems.push(`Aries start overlaps the collision of ${object.id}. Move one of them apart.`);
    }
  }
  return problems;
}

export function createFloorMap(document, assetCatalog = ASSET_CATALOG) {
  const design = validateFloorDocument(document, assetCatalog);
  const start = design.objects.find(object => object.assetId === "spawn-aries");
  const reserve = FLOOR1_GRID.flatMap((row, y) => [...row].map((cell, x) =>
    cell === "." ? { x, y } : null)).find(Boolean);
  const colliders = design.objects.filter(object => object.collision &&
    object.collision.width % MAP_CELL_SIZE === 0 && object.collision.height % MAP_CELL_SIZE === 0);
  const objects = colliders.map(object => {
    const rect = collisionRect(object);
    return {
      id: object.id,
      typeId: object.type,
      position: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    };
  });
  const collisions = colliders.map(object => ({
    id: `collision-${object.id}`,
    objectId: object.id,
    shape: { type: "rect", width: object.collision.width, height: object.collision.height }
  }));
  return {
    formatVersion: 1,
    id: design.id,
    name: design.name,
    bounds: FLOOR1_BOUNDS,
    cellSize: MAP_CELL_SIZE,
    objects,
    collisions,
    spawns: [
      { id: "aries-start", kind: "player",
        position: { x: start.transform.x, y: start.transform.y }, radius: 4 },
      { id: "reserved-player-spawn", kind: "player",
        position: { x: reserve.x * MAP_CELL_SIZE + 16, y: reserve.y * MAP_CELL_SIZE + 16 },
        radius: 4 }
    ]
  };
}
