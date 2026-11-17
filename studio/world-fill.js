import { SECTION_SIZE, sectionOrigin, worldToSection } from "./world-coordinates.js";
import { isTerrainBrushAsset, planTerrainStroke, terrainRectangle } from "./world-terrain.js";

const MAX_PLACEMENTS = 8192;

export function isRepeatableAsset(asset) {
  return Boolean(asset && !asset.unique && !asset.required && asset.repeatable !== false &&
    (isTerrainBrushAsset(asset) || ["prop", "wall"].includes(asset.type)) &&
    [asset.size?.width, asset.size?.height].every(value => Number.isSafeInteger(value) && value > 0) &&
    [asset.pivot?.x, asset.pivot?.y].every(Number.isSafeInteger));
}

export function isBorderAsset(asset) {
  return isRepeatableAsset(asset) && ["terrain-tile", "wall"].includes(asset.type) &&
    asset.size.width === 32 && asset.size.height === 32 && asset.pivot.x === 0 && asset.pivot.y === 0;
}

export function fillRectangle(start, end, asset, border = false) {
  if (isTerrainBrushAsset(asset) || border) {
    const rectangle = terrainRectangle(start, end);
    return { ...rectangle, width: rectangle.columns * 32, height: rectangle.rows * 32 };
  }
  worldToSection(start.x, start.y);
  worldToSection(end.x, end.y);
  const x = Math.floor(Math.min(start.x, end.x));
  const y = Math.floor(Math.min(start.y, end.y));
  const width = Math.max(1, Math.ceil(Math.max(start.x, end.x)) - x);
  const height = Math.max(1, Math.ceil(Math.max(start.y, end.y)) - y);
  if (![x, y, width, height, x + width, y + height].every(Number.isSafeInteger)) {
    throw new RangeError("Rectangle exceeds safe world coordinates.");
  }
  return { x, y, width, height };
}

const intersects = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x &&
  a.y < b.y + b.height && a.y + a.height > b.y;

// Pure preflight: callers publish every returned document together, with one history entry.
export function planFill(sections, rectangle, options) {
  const { assetId, assetCatalog, layers, createObject, validate,
    gapX = 0, gapY = 0, overlap = "skip", borderAssetId = null, collision = false } = options;
  const asset = assetCatalog[assetId];
  if (!isRepeatableAsset(asset)) throw new TypeError("Choose static terrain, a wall or a prop; spawns and unique gameplay objects cannot repeat.");
  if (!isTerrainBrushAsset(asset) &&
      ![gapX, gapY].every(value => Number.isSafeInteger(value) && value >= 0 && value <= SECTION_SIZE)) {
    throw new RangeError(`Spacing must be whole world pixels between 0 and ${SECTION_SIZE}.`);
  }
  if (!["skip", "allow"].includes(overlap)) throw new TypeError("Choose Skip or Allow same-layer overlaps.");
  const borderAsset = assetCatalog[borderAssetId];
  if (borderAssetId && !isBorderAsset(borderAsset)) throw new TypeError("Choose a separate 32 x 32 terrain or wall border asset.");
  const { x, y, width, height } = rectangle;
  if (![x, y, width, height, x + width, y + height].every(Number.isSafeInteger) || width < 1 || height < 1) {
    throw new RangeError("Drag a finite rectangle with a positive size.");
  }
  const first = worldToSection(x, y), last = worldToSection(x + width - 1, y + height - 1);
  const sectionCount = (last.gridX - first.gridX + 1) * (last.gridY - first.gridY + 1);
  if (sectionCount > 2) throw new RangeError("Rectangle exceeds the two-section working set.");
  if ((isTerrainBrushAsset(asset) || borderAsset) && [x, y, width, height].some(value => value % 32)) {
    throw new RangeError("Terrain and border rectangles must use the continuous 32px world grid.");
  }
  const byPosition = new Map(), ids = new Set();
  for (const section of sections) {
    sectionOrigin(section.gridX, section.gridY);
    const key = `${section.gridX},${section.gridY}`;
    if (byPosition.has(key) || ids.has(section.sectionId)) throw new TypeError("Duplicate level section membership.");
    byPosition.set(key, section);
    ids.add(section.sectionId);
  }
  const working = [];
  for (let gy = first.gridY; gy <= last.gridY; gy++) {
    for (let gx = first.gridX; gx <= last.gridX; gx++) {
      const section = byPosition.get(`${gx},${gy}`);
      if (!section?.document) throw new TypeError(`Section (${gx}, ${gy}) is missing or unloaded.`);
      const document = section.document;
      if (document.id !== section.mapId || document.cellSize !== 32) throw new TypeError("Incompatible section identity.");
      validate(structuredClone(document));
      const origin = sectionOrigin(gx, gy);
      if (Math.min(x + width, origin.x + SECTION_SIZE) > origin.x + document.bounds.width ||
          Math.min(y + height, origin.y + SECTION_SIZE) > origin.y + document.bounds.height) {
        throw new RangeError(`Section (${gx}, ${gy}): rectangle is outside the saved map bounds.`);
      }
      working.push({ ...section, document: structuredClone(document) });
    }
  }
  const checkLayer = definition => {
    const layer = layers[definition.type === "terrain-tile" ? "terrain" : definition.type === "wall" ? "walls" : "props"];
    if (!layer || layer.locked || !layer.visible) {
      throw new TypeError(`${definition.label}: target layer is ${layer?.locked ? "locked; unlock it" : "hidden; show it"} before filling.`);
    }
  };
  checkLayer(asset);
  if (borderAsset) checkLayer(borderAsset);
  const placements = [], terrain = new Map();
  let skipped = 0, overlaps = 0, seamSkipped = 0, proposed = 0, borderCount = 0;
  const boundsOf = object => {
    const definition = assetCatalog[object.assetId];
    return { x: object.transform.x - definition.pivot.x, y: object.transform.y - definition.pivot.y,
      width: definition.size.width, height: definition.size.height };
  };
  const occupancy = new Map(working.map(section => [section.sectionId, section.document.objects.map(object =>
    ({ layer: object.layer, ...boundsOf(object) }))]));
  const counters = new Map();
  const add = (id, px, py, border) => {
    if (++proposed > MAX_PLACEMENTS) throw new RangeError("Fill exceeds the 8192-placement preview limit.");
    const definition = assetCatalog[id];
    const local = worldToSection(px, py);
    const section = working.find(item => item.gridX === local.gridX && item.gridY === local.gridY);
    if (!section) throw new TypeError("Placement targets a missing section.");
    if (local.x + definition.size.width > section.document.bounds.width ||
        local.y + definition.size.height > section.document.bounds.height) {
      // Artwork never straddles ownership boundaries; the preview reports unused seam slots.
      seamSkipped++;
      return;
    }
    if (isTerrainBrushAsset(definition)) {
      if (!terrain.has(id)) terrain.set(id, []);
      terrain.get(id).push({ x: px, y: py });
    } else {
      const next = section.document;
      const layer = definition.type === "wall" ? "walls" : "props";
      const bounds = { x: local.x, y: local.y, ...definition.size };
      const occupied = occupancy.get(section.sectionId);
      const overlapping = occupied.some(other => other.layer === layer && intersects(bounds, other));
      if (overlapping) {
        overlaps++;
        if (overlap === "skip") { skipped++; return; }
      }
      let counter = counters.get(section.sectionId);
      if (!counter) {
        counter = { ids: new Set(next.objects.map(object => object.id)), number: 1,
          order: Math.max(-1, ...next.objects.map(object => object.order)) + 1 };
        counters.set(section.sectionId, counter);
      }
      while (counter.ids.has(`rectangle-fill-${counter.number}`)) counter.number++;
      const objectId = `rectangle-fill-${counter.number++}`;
      counter.ids.add(objectId);
      const object = createObject(objectId, id, {
        x: local.x + definition.pivot.x, y: local.y + definition.pivot.y
      }, counter.order++, { collision: definition.collision === "required" || (id === assetId && collision) });
      if (definition.snap?.forced &&
          ((object.transform.x - definition.snap.x) % 32 || (object.transform.y - definition.snap.y) % 32)) {
        throw new RangeError(`${definition.label} requires its configured grid alignment; adjust the rectangle or spacing.`);
      }
      next.objects.push(object);
      occupied.push({ layer, ...bounds });
    }
    placements.push({ assetId: id, x: px, y: py, ...definition.size, border });
    if (border) borderCount++;
  };
  if (borderAsset) {
    for (let py = y; py < y + height; py += 32) {
      for (let px = x; px < x + width; px += 32) {
        if (px === x || py === y || px === x + width - 32 || py === y + height - 32) {
          add(borderAssetId, px, py, true);
        }
      }
    }
  }
  const inset = borderAsset ? 32 : 0;
  const inner = { x: x + inset, y: y + inset, width: width - 2 * inset, height: height - 2 * inset };
  const stepX = asset.size.width + (isTerrainBrushAsset(asset) ? 0 : gapX);
  const stepY = asset.size.height + (isTerrainBrushAsset(asset) ? 0 : gapY);
  const columns = Math.max(0, Math.floor((inner.width - asset.size.width) / stepX) + 1);
  const rows = Math.max(0, Math.floor((inner.height - asset.size.height) / stepY) + 1);
  if (columns * rows + proposed > MAX_PLACEMENTS) throw new RangeError("Fill exceeds the 8192-placement preview limit.");
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      add(assetId, inner.x + column * stepX, inner.y + row * stepY, false);
    }
  }
  if (!proposed) throw new RangeError("No complete asset footprint fits inside this rectangle.");
  for (const [id, cells] of terrain) {
    const updates = planTerrainStroke(working, cells, { assetId: id, assetCatalog,
      layerState: layers.terrain, createObject, validate });
    for (const update of updates) working.find(section => section.sectionId === update.sectionId).document = update.document;
  }
  const updates = [];
  for (const section of working) {
    const document = validate(section.document);
    if (new TextEncoder().encode(JSON.stringify(document)).byteLength > 2_000_000) {
      throw new RangeError(`Section (${section.gridX}, ${section.gridY}) exceeds the 2 MB document limit.`);
    }
    if (JSON.stringify(document) !== JSON.stringify(byPosition.get(`${section.gridX},${section.gridY}`).document)) {
      updates.push({ sectionId: section.sectionId, document });
    }
  }
  return { updates, placements, sectionCount, count: placements.length, borderCount, skipped, overlaps, seamSkipped };
}
