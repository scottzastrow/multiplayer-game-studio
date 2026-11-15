import { SECTION_SIZE, worldToSection, sectionOrigin } from "./world-coordinates.js";

export const TERRAIN_CELL_SIZE = 32;
const MAX_STROKE_CELLS = 2 * (SECTION_SIZE / TERRAIN_CELL_SIZE) ** 2;

export function isTerrainBrushAsset(asset) {
  return asset?.type === "terrain-tile" && !asset.unique &&
    asset.size?.width === TERRAIN_CELL_SIZE && asset.size?.height === TERRAIN_CELL_SIZE &&
    [asset.pivot?.x, asset.pivot?.y].every(Number.isSafeInteger) &&
    (!asset.snap?.forced || ((asset.snap.x - asset.pivot.x) % TERRAIN_CELL_SIZE === 0 &&
      (asset.snap.y - asset.pivot.y) % TERRAIN_CELL_SIZE === 0));
}

export function rasterizeTerrainSegment(start, end) {
  worldToSection(start.x, start.y);
  worldToSection(end.x, end.y);
  const size = TERRAIN_CELL_SIZE;
  let x = Math.floor(start.x / size);
  let y = Math.floor(start.y / size);
  const endX = Math.floor(end.x / size);
  const endY = Math.floor(end.y / size);
  if (Math.abs(endX - x) + Math.abs(endY - y) + 1 > MAX_STROKE_CELLS) {
    throw new RangeError("Stroke exceeds the two-section working set.");
  }
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  const deltaX = dx ? size / Math.abs(dx) : Infinity;
  const deltaY = dy ? size / Math.abs(dy) : Infinity;
  let nextX = dx ? ((x + (sx > 0 ? 1 : 0)) * size - start.x) / dx : Infinity;
  let nextY = dy ? ((y + (sy > 0 ? 1 : 0)) * size - start.y) / dy : Infinity;
  const cells = [];
  const add = (cx, cy) => cells.push({ x: cx * size, y: cy * size });
  add(x, y);
  while (x !== endX || y !== endY) {
    const tx = x === endX ? Infinity : nextX;
    const ty = y === endY ? Infinity : nextY;
    if (tx === ty) {
      // Include both side cells at a corner so a fast diagonal stays connected.
      add(x + sx, y);
      add(x, y + sy);
      x += sx;
      y += sy;
      nextX += deltaX;
      nextY += deltaY;
    } else if (tx < ty) {
      x += sx;
      nextX += deltaX;
    } else {
      y += sy;
      nextY += deltaY;
    }
    add(x, y);
    if (cells.length > MAX_STROKE_CELLS) throw new RangeError("Stroke exceeds the two-section working set.");
  }
  return cells;
}

export function extendTerrainStroke(stroke, point) {
  if (stroke.error) return;
  try {
    for (const cell of rasterizeTerrainSegment(stroke.last ?? point, point)) {
      stroke.cells.set(`${cell.x},${cell.y}`, cell);
      if (stroke.cells.size > MAX_STROKE_CELLS) throw new RangeError("Stroke exceeds the two-section working set.");
    }
    stroke.last = point;
  } catch (error) {
    stroke.error = error.message;
  }
}

export function planTerrainStroke(sections, cells, { assetId, assetCatalog, layerState, createObject, validate }) {
  const asset = assetCatalog[assetId];
  if (!isTerrainBrushAsset(asset)) throw new TypeError("Select a compatible single-cell terrain asset.");
  const byPosition = new Map();
  const ids = new Set();
  for (const section of sections) {
    sectionOrigin(section.gridX, section.gridY);
    const key = `${section.gridX},${section.gridY}`;
    if (byPosition.has(key) || ids.has(section.sectionId)) throw new TypeError("Duplicate world section membership.");
    byPosition.set(key, section);
    ids.add(section.sectionId);
  }
  const targets = new Map();
  for (const cell of cells) {
    if (![cell.x, cell.y].every(value => Number.isSafeInteger(value) && value % TERRAIN_CELL_SIZE === 0)) {
      throw new RangeError("Stroke cells must be on the continuous 32px world grid.");
    }
    const local = worldToSection(cell.x, cell.y);
    const section = byPosition.get(`${local.gridX},${local.gridY}`);
    const label = `Section (${local.gridX}, ${local.gridY})`;
    if (!section?.document) throw new TypeError(`${label} is missing or unloaded; no sections were changed.`);
    if (layerState.locked || !layerState.visible) {
      throw new TypeError(`${label}: Terrain is ${layerState.locked ? "locked; unlock it" : "hidden; show it"} before painting.`);
    }
    if (!targets.has(section)) targets.set(section, new Map());
    targets.get(section).set(`${local.x},${local.y}`, local);
  }
  const updates = [];
  for (const [section, locations] of targets) {
    try {
      const original = section.document;
      if (original.id !== section.mapId || original.cellSize !== TERRAIN_CELL_SIZE ||
          original.bounds.width !== SECTION_SIZE || original.bounds.height !== SECTION_SIZE) {
        throw new TypeError("Incompatible section identity or dimensions.");
      }
      validate(structuredClone(original));
      const next = structuredClone(original);
      const occupied = new Map(next.objects.filter(object => object.type === "terrain-tile").map(object => {
        const definition = assetCatalog[object.assetId];
        return [`${object.transform.x - definition.pivot.x},${object.transform.y - definition.pivot.y}`, object];
      }));
      const objectIds = new Set(next.objects.map(object => object.id));
      let order = Math.max(-1, ...next.objects.filter(object => object.layer === "terrain").map(object => object.order)) + 1;
      let number = 1;
      for (const [key, local] of locations) {
        const existing = occupied.get(key);
        if (existing?.assetId === assetId) continue;
        let id = existing?.id;
        if (!id) {
          while (objectIds.has(`terrain-brush-${number}`)) number++;
          id = `terrain-brush-${number++}`;
          objectIds.add(id);
        }
        const object = createObject(id, assetId, {
          x: local.x + asset.pivot.x, y: local.y + asset.pivot.y
        }, existing ? existing.order : order++);
        if (existing) next.objects[next.objects.indexOf(existing)] = object;
        else next.objects.push(object);
      }
      const document = validate(next);
      if (new TextEncoder().encode(JSON.stringify(document)).byteLength > 2_000_000) {
        throw new RangeError("Section exceeds the 2 MB document limit.");
      }
      if (JSON.stringify(document) !== JSON.stringify(original)) updates.push({ sectionId: section.sectionId, document });
    } catch (error) {
      throw new TypeError(`Section (${section.gridX}, ${section.gridY}): ${error.message}`);
    }
  }
  return updates;
}
