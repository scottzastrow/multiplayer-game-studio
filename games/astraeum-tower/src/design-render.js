// Shared renderer for Astraeum Tower designs. Play and the Studio editor draw the
// saved design through these functions, and the editor hit-tests the same object
// bounds (project.js objectBounds/renderOrder), so what is selected is what is drawn.
import {
  ASSET_CATALOG,
  MAP_CELL_SIZE,
  cellOccupancy,
  isAutotiledWall,
  objectBounds,
  renderOrder
} from "./project.js";

const CELL = MAP_CELL_SIZE;
export const WALL_FACE_PX = 12;
export const TILE_INDEX = Object.freeze({
  "0010": 0, "0101": 1, "1011": 2, "0011": 3,
  "1001": 4, "0111": 5, "1111": 6, "1110": 7,
  "0100": 8, "1100": 9, "1101": 10, "1010": 11,
  "0000": 12, "0001": 13, "0110": 14, "1000": 15
});
const SOLID_WALL_TILE = TILE_INDEX["0000"];

export const ARTWORK_URLS = Object.freeze({
  ariesE: new URL("../assets/aries-east.png", import.meta.url),
  ariesW: new URL("../assets/aries-west.png", import.meta.url),
  ariesN: new URL("../assets/aries-north.png", import.meta.url),
  ariesS: new URL("../assets/aries-south.png", import.meta.url),
  ariesIdle: new URL("../assets/aries-idle.png", import.meta.url),
  wang: new URL("../assets/damp-corridors-wang.png", import.meta.url),
  door: new URL("../assets/door.png", import.meta.url),
  web: new URL("../assets/cobweb.png", import.meta.url),
  candle: new URL("../assets/candle.png", import.meta.url),
  barrel: new URL("../assets/barrel.png", import.meta.url),
  crate: new URL("../assets/crate.png", import.meta.url),
  pots: new URL("../assets/pots.png", import.meta.url),
  rune: new URL("../assets/rune.png", import.meta.url),
  chest: new URL("../assets/chest.png", import.meta.url),
  herb: new URL("../assets/herb.png", import.meta.url),
  amethyst: new URL("../assets/amethyst.png", import.meta.url),
  sapphire: new URL("../assets/sapphire.png", import.meta.url)
});

export async function loadArtwork() {
  const entries = await Promise.all(Object.entries(ARTWORK_URLS).map(async ([id, url]) => {
    const image = new Image();
    image.src = url.href;
    await image.decode();
    return [id, image];
  }));
  return Object.freeze(Object.fromEntries(entries));
}

function isWall(grid, x, y) {
  return x < 0 || y < 0 || y >= grid.length ||
    x >= grid[0].length || grid[y][x] === "#";
}

function findDeadEnds(grid) {
  const found = [];
  const seen = new Set();
  const width = (x, y, px, py) => {
    let count = 1;
    for (let step = 1; step < 4 && !isWall(grid, x + px * step, y + py * step); step += 1) count += 1;
    for (let step = 1; step < 4 && !isWall(grid, x - px * step, y - py * step); step += 1) count += 1;
    return count;
  };
  for (let y = 1; y < grid.length - 1; y += 1) {
    for (let x = 1; x < grid[0].length - 1; x += 1) {
      if (isWall(grid, x, y)) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (!isWall(grid, x + dx, y + dy)) continue;
        const px = dy;
        const py = dx;
        let valid = true;
        for (let back = 0; back < 3 && valid; back += 1) {
          const cx = x - dx * back;
          const cy = y - dy * back;
          if (isWall(grid, cx, cy) || width(cx, cy, px, py) > 2) valid = false;
        }
        if (!valid) continue;
        const key = `${x + (isWall(grid, x - px, y - py) ? 0 : -px)},` +
          `${y + (isWall(grid, x - px, y - py) ? 0 : -py)},${dx},${dy}`;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push([x, y]);
      }
    }
  }
  return found;
}

/** Procedural door, cobwebs and candles derived from the design grid (not editable objects). */
export function fixedDecorations(artwork, grid, map) {
  const start = map.spawns.find(spawn => spawn.kind === "player").position;
  const startTile = { x: Math.floor(start.x / CELL), y: Math.floor(start.y / CELL) };
  let y = startTile.y;
  while (y > 0 && !isWall(grid, startTile.x, y - 1)) y -= 1;
  const door = y > 0 && isWall(grid, startTile.x - 1, y - 1) &&
    isWall(grid, startTile.x + 1, y - 1)
    ? { x: startTile.x * CELL + 16, y: y * CELL + WALL_FACE_PX }
    : undefined;
  let seed = 99 + 131;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const forcedWebs = [[9, 10], [5, 12]];
  const noWebs = [[8, 12]];
  const has = (positions, x, y) => positions.some(([px, py]) => px === x && py === y);
  const busy = (x, y) => {
    const cell = grid[y]?.[x];
    return cell !== undefined && cell !== "." && cell !== "#";
  };
  const noCandle = new Set();
  for (const [x, y] of findDeadEnds(grid)) {
    for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      noCandle.add((y + dy) * grid[0].length + x + dx);
    }
  }
  const candles = [];
  const webs = [];
  const candleAllowed = (x, y) => !noCandle.has(Math.floor(y / CELL) * grid[0].length +
    Math.floor(x / CELL)) &&
    !grid.some((row, cy) => [...row].some((cell, cx) => cell === "C" &&
      Math.hypot((cx + 0.5) * CELL - x, (cy + 0.75) * CELL - y) < 6 * CELL)) &&
    !candles.some(candle => Math.hypot(candle.x - x, candle.y - y) < 5 * CELL);
  const placeCandle = (x, y) => {
    if (!candleAllowed(x, y) || random() > 1 / 3) return;
    const phase = random() * 6;
    candles.push({
      x,
      y,
      light: {
        x,
        y: y - artwork.candle.height + 4,
        radius: 80,
        color: "#ffc070",
        phase
      }
    });
  };
  let flip = random() < 0.5;
  for (let ty = 1; ty < grid.length - 1; ty += 1) {
    for (let tx = 1; tx < grid[0].length - 1; tx += 1) {
      if (isWall(grid, tx, ty) || busy(tx, ty)) continue;
      const up = isWall(grid, tx, ty - 1);
      const down = isWall(grid, tx, ty + 1);
      const left = isWall(grid, tx - 1, ty);
      const right = isWall(grid, tx + 1, ty);
      if (Number(up) + Number(down) + Number(left) + Number(right) !== 2 ||
          (up && down) || (left && right)) continue;
      const px = tx * CELL;
      const py = ty * CELL;
      if (up) {
        const forceWeb = has(forcedWebs, tx, ty);
        const banWeb = has(noWebs, tx, ty);
        if (!forceWeb && random() > 0.75) continue;
        flip = !flip;
        if (forceWeb || (flip && !banWeb)) webs.push({ x: tx, y: ty, flip: !left });
        else placeCandle(left ? px + 9 : px + CELL - 9, py + WALL_FACE_PX + 14);
      } else if (random() < 0.5) {
        placeCandle(left ? px + 9 : px + CELL - 9, py + 26);
      }
    }
  }
  return { door, webs, candles };
}

function drawWangTile(context, artwork, tile, x, y) {
  context.drawImage(artwork.wang,
    (tile % 4) * CELL, Math.floor(tile / 4) * CELL, CELL, CELL, x, y, CELL, CELL);
}

/**
 * Terrain tiles and grid-aligned walls share the Damp Corridors dual-grid Wang
 * autotile, exactly as the original game drew them. A corner counts as floor when
 * its cell has a visible terrain tile and no visible aligned wall.
 */
function drawTerrainAndAlignedWalls(context, artwork, design, visible) {
  const { floor, wall } = cellOccupancy(design);
  const rows = floor.length;
  const columns = floor[0].length;
  if (visible.terrain) {
    const corner = (x, y) => x >= 0 && y >= 0 && x < columns && y < rows &&
      floor[y][x] && !(visible.walls && wall[y][x]) ? "1" : "0";
    for (let y = -1; y < rows; y += 1) {
      for (let x = -1; x < columns; x += 1) {
        const tile = TILE_INDEX[corner(x, y) + corner(x + 1, y) + corner(x, y + 1) + corner(x + 1, y + 1)];
        drawWangTile(context, artwork, tile, x * CELL + CELL / 2, y * CELL + CELL / 2);
      }
    }
  } else if (visible.walls) {
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < columns; x += 1) {
        if (wall[y][x]) drawWangTile(context, artwork, SOLID_WALL_TILE, x * CELL, y * CELL);
      }
    }
  }
}

function drawPlaceholder(context, asset, bounds) {
  const { glyph, color } = asset.placeholder ?? { glyph: "?", color: "#d0c8e0" };
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  context.save();
  context.fillStyle = "rgba(10, 8, 16, 0.75)";
  context.strokeStyle = color;
  context.lineWidth = 1.5;
  context.setLineDash([3, 2]);
  context.beginPath();
  context.arc(cx, cy, Math.min(bounds.width, bounds.height) / 2 - 1, 0, Math.PI * 2);
  context.fill();
  context.stroke();
  context.setLineDash([]);
  context.fillStyle = color;
  context.font = "bold 12px system-ui, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(glyph, cx, cy + 0.5);
  context.restore();
}

function drawCollisionBox(context, bounds) {
  context.save();
  context.fillStyle = "rgba(255, 70, 90, 0.18)";
  context.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
  context.strokeStyle = "rgba(255, 110, 120, 0.95)";
  context.lineWidth = 1;
  context.setLineDash([4, 3]);
  context.strokeRect(bounds.x + 0.5, bounds.y + 0.5, bounds.width - 1, bounds.height - 1);
  context.setLineDash([]);
  context.beginPath();
  context.moveTo(bounds.x, bounds.y);
  context.lineTo(bounds.x + bounds.width, bounds.y + bounds.height);
  context.moveTo(bounds.x + bounds.width, bounds.y);
  context.lineTo(bounds.x, bounds.y + bounds.height);
  context.stroke();
  context.restore();
}

/** Draws one asset with its pivot at `transform`; also used for palette previews. */
export function drawAsset(context, artwork, assetId, transform, { alpha = 1, assetCatalog = ASSET_CATALOG } = {}) {
  const asset = assetCatalog[assetId];
  const bounds = objectBounds({ assetId, transform }, assetCatalog);
  context.save();
  context.globalAlpha *= alpha * asset.alpha;
  if (asset.type === "collision") {
    drawCollisionBox(context, bounds);
  } else if (asset.imported) {
    const image = artwork.imported[assetId];
    context.drawImage(image, 0, 0, image.naturalWidth, image.naturalHeight,
      bounds.x, bounds.y, bounds.width, bounds.height);
  } else if (asset.artwork) {
    const { image, region } = asset.artwork;
    context.drawImage(artwork[image], region.x, region.y, region.width, region.height,
      bounds.x, bounds.y, bounds.width, bounds.height);
  } else {
    drawPlaceholder(context, asset, bounds);
  }
  context.restore();
  return bounds;
}

function drawDecorations(context, artwork, decor) {
  if (decor.door) {
    const { door } = decor;
    context.drawImage(artwork.door,
      Math.round(door.x - artwork.door.width / 2),
      Math.round(door.y - artwork.door.height));
  }
  for (const web of decor.webs) {
    const image = artwork.web;
    const x = web.x * CELL;
    const y = web.y * CELL + WALL_FACE_PX - 2;
    if (!web.flip) {
      context.drawImage(image, x, y);
    } else {
      context.save();
      context.translate(x + CELL, 0);
      context.scale(-1, 1);
      context.drawImage(image, 0, y);
      context.restore();
    }
  }
  for (const candle of decor.candles) {
    const image = artwork.candle;
    context.drawImage(image, Math.round(candle.x - image.width / 2),
      Math.round(candle.y - image.height));
  }
}

const ALL_VISIBLE = Object.freeze({
  terrain: true, walls: true, props: true, items: true, spawns: true, collision: true
});

/**
 * Draws a design in render order. mode "play" draws only what Play shows; mode
 * "editor" also draws editor-only objects (items, spawns, the stairs rune and
 * collision boxes). Derived decorations draw after props, as in the original.
 * Returns the derived candle lights.
 */
export function drawDesign(context, artwork, design, { grid, map, mode = "play",
  visible = ALL_VISIBLE, decorations = true, assetCatalog = ASSET_CATALOG } = {}) {
  context.fillStyle = "#0b0910";
  context.fillRect(0, 0, design.bounds.width, design.bounds.height);
  drawTerrainAndAlignedWalls(context, artwork, design, visible);
  const ordered = renderOrder(design);
  const draw = object => drawAsset(context, artwork, object.assetId, object.transform, { assetCatalog });
  // Off-grid walls cannot join the dual-grid autotile, so they use the solid-wall tile
  // at their own rectangle (never the floor tile).
  for (const object of ordered) {
    if (object.type === "wall" && visible.walls && !isAutotiledWall(object)) {
      drawWangTile(context, artwork, SOLID_WALL_TILE, object.transform.x, object.transform.y);
    }
  }
  for (const object of ordered) {
    if (object.type !== "prop" || !visible.props) continue;
    if (mode === "play" && assetCatalog[object.assetId].playVisible === false) continue;
    draw(object);
  }
  const decor = decorations && visible.terrain && visible.walls
    ? fixedDecorations(artwork, grid, map)
    : { webs: [], candles: [] };
  drawDecorations(context, artwork, decor);
  if (mode === "editor") {
    for (const object of ordered) {
      if (["item", "spawn", "collision"].includes(object.type) && visible[object.layer]) draw(object);
    }
  }
  return decor.candles.map(candle => candle.light);
}
