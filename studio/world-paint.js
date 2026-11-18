import { sectionOrigin, worldToSection } from "./world-coordinates.js";
import { isRepeatableAsset } from "./world-fill.js";
import { isTerrainBrushAsset, planTerrainStroke } from "./world-terrain.js";

export function isPaintBrushAsset(asset) {
  return isRepeatableAsset(asset) &&
    (!asset.imported || asset.importedInfo?.category === "prop") &&
    (asset.paint === "static" || (asset.paint === "terrain" && isTerrainBrushAsset(asset)));
}

function probability(seed, x, y) {
  let hash = seed >>> 0;
  for (const value of [x, y]) {
    hash = Math.imul(hash ^ (value >>> 0), 0x45d9f3b);
    hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
    hash ^= hash >>> 16;
  }
  return (hash >>> 0) / 4294967296;
}

const tooClose = (a, b, gap) => a.x < b.x + b.width + gap && a.x + a.width + gap > b.x &&
  a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;

// Pure preflight, using Fill's eligibility, footprint/pivot and section-ownership rules.
export function planPaintStroke(sections, cells, {
  assetId, assetCatalog, layers, createObject, validate, density = 100, spacing = 0, seed = 1
}) {
  const asset = assetCatalog[assetId];
  if (!isPaintBrushAsset(asset)) throw new TypeError("This asset supports single placement only; choose repeatable static artwork.");
  if (!Number.isInteger(density) || density < 1 || density > 100) {
    throw new RangeError("Density must be a whole percentage from 1 to 100.");
  }
  if (!Number.isSafeInteger(spacing) || spacing < 0 || spacing > 2048) {
    throw new RangeError("Minimum spacing must be whole world pixels from 0 to 2048.");
  }
  if (!Number.isSafeInteger(seed)) throw new RangeError("Paint requires a stable integer stroke seed.");
  const terrain = isTerrainBrushAsset(asset);
  const layerId = terrain ? "terrain" : asset.type === "wall" ? "walls" : "props";
  const layer = layers[layerId];
  if (!layer || layer.locked || !layer.visible) {
    throw new TypeError(`${asset.label}: target layer is ${layer?.locked ? "locked; unlock it" : "hidden; show it"} before painting.`);
  }
  const byPosition = new Map(), ids = new Set();
  for (const section of sections) {
    sectionOrigin(section.gridX, section.gridY);
    const key = `${section.gridX},${section.gridY}`;
    if (byPosition.has(key) || ids.has(section.sectionId)) throw new TypeError("Duplicate level section membership.");
    byPosition.set(key, section);
    ids.add(section.sectionId);
  }
  const touched = new Set(), candidates = new Map();
  const aligned = terrain || asset.snap?.forced;
  const step = size => aligned ? Math.ceil((size + spacing) / 32) * 32 : size + spacing;
  const stepX = step(asset.size.width), stepY = step(asset.size.height);
  const offsetX = asset.snap?.forced ? ((asset.snap.x - asset.pivot.x) % 32 + 32) % 32 : 0;
  const offsetY = asset.snap?.forced ? ((asset.snap.y - asset.pivot.y) % 32 + 32) % 32 : 0;
  let cellCount = 0;
  for (const cell of cells) {
    if (++cellCount > 8192) throw new RangeError("Stroke exceeds the two-section working set; use a shorter stroke.");
    if (![cell.x, cell.y].every(value => Number.isSafeInteger(value) && value % 32 === 0)) {
      throw new RangeError("Paint cells must use the continuous 32px world grid.");
    }
    const local = worldToSection(cell.x, cell.y);
    const section = byPosition.get(`${local.gridX},${local.gridY}`);
    if (!section?.document) throw new TypeError(`Section (${local.gridX}, ${local.gridY}) is missing or unloaded; add it before painting.`);
    if (local.x + 32 > section.document.bounds.width || local.y + 32 > section.document.bounds.height) {
      throw new RangeError("Brush extends outside the saved map bounds; move it inside the map.");
    }
    touched.add(section);
    if (touched.size > 2) throw new RangeError("Stroke exceeds the two-section working set; use a shorter stroke.");
    for (let gy = Math.ceil((cell.y - offsetY) / stepY); offsetY + gy * stepY < cell.y + 32; gy++) {
      for (let gx = Math.ceil((cell.x - offsetX) / stepX); offsetX + gx * stepX < cell.x + 32; gx++) {
        const x = offsetX + gx * stepX, y = offsetY + gy * stepY;
        if (probability(seed, gx, gy) < density / 100) candidates.set(`${gx},${gy}`, { x, y, ...asset.size });
        if (candidates.size > 8192) throw new RangeError("Stroke exceeds 8192 placements; reduce brush size or shorten the stroke.");
      }
    }
  }
  for (const section of touched) {
    if (section.document.id !== section.mapId || section.document.cellSize !== 32) throw new TypeError("Incompatible section identity.");
    validate(structuredClone(section.document));
  }
  const occupancy = [];
  for (const section of sections) {
    const origin = sectionOrigin(section.gridX, section.gridY);
    for (const object of section.document.objects) {
      if (object.layer !== layerId) continue;
      const definition = assetCatalog[object.assetId];
      occupancy.push({ x: origin.x + object.transform.x - definition.pivot.x,
        y: origin.y + object.transform.y - definition.pivot.y, ...definition.size });
    }
  }
  const placements = [], working = new Map(), counters = new Map();
  let skipped = 0, seamSkipped = 0;
  for (const bounds of candidates.values()) {
    const local = worldToSection(bounds.x, bounds.y);
    const section = byPosition.get(`${local.gridX},${local.gridY}`);
    if (!section?.document || local.x + bounds.width > section.document.bounds.width ||
        local.y + bounds.height > section.document.bounds.height) {
      // Like Fill, omit complete static slots at ownership edges; never split or resize art.
      seamSkipped++;
      continue;
    }
    // At gap zero terrain retains its original replace-cell semantics.
    const blocked = occupancy.some(other => {
      if (terrain && spacing === 0 && other.x === bounds.x && other.y === bounds.y) return false;
      return tooClose(bounds, other, spacing);
    });
    if (blocked) { skipped++; continue; }
    placements.push({ assetId, ...bounds });
    if (terrain) continue;
    if (!working.has(section)) working.set(section, structuredClone(section.document));
    const next = working.get(section);
    let counter = counters.get(section);
    if (!counter) {
      counter = { ids: new Set(next.objects.map(object => object.id)), number: 1,
        order: Math.max(-1, ...next.objects.map(object => object.order)) + 1 };
      counters.set(section, counter);
    }
    while (counter.ids.has(`paint-${counter.number}`)) counter.number++;
    const id = `paint-${counter.number++}`;
    counter.ids.add(id);
    next.objects.push(createObject(id, assetId, {
      x: local.x + asset.pivot.x, y: local.y + asset.pivot.y
    }, counter.order++));
  }
  const updates = terrain ? planTerrainStroke(sections, placements, {
    assetId, assetCatalog, layerState: layer, createObject, validate
  }) : [...working].map(([section, next]) => {
    const document = validate(next);
    if (new TextEncoder().encode(JSON.stringify(document)).byteLength > 2_000_000) {
      throw new RangeError("Section exceeds the 2 MB document limit; use a shorter stroke.");
    }
    return { sectionId: section.sectionId, document };
  });
  return { updates, placements, skipped, seamSkipped };
}
