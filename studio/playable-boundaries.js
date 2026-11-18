import { sectionOrigin } from "./world-coordinates.js";

export const PLAYABLE_BOUNDARY_VERSION = 1;
export const PLAYABLE_BOUNDARY_CELL_SIZE = 32;
const CELLS_PER_SECTION = 2048 / PLAYABLE_BOUNDARY_CELL_SIZE;
const CELLS_PER_SECTION_MASK = CELLS_PER_SECTION * CELLS_PER_SECTION;
const MASK_BYTES = CELLS_PER_SECTION_MASK / 8;
const MAX_SECTIONS = 16;
const MAX_BOUNDARY_CELLS = MAX_SECTIONS * CELLS_PER_SECTION_MASK;
const MAX_POLYGON_POINTS = 512;
const MAX_CELL_COORDINATE = Math.floor(Number.MAX_SAFE_INTEGER / PLAYABLE_BOUNDARY_CELL_SIZE);

function fail(message) {
  throw new TypeError(message);
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) {
    fail(`${label} must contain exactly ${keys.join(", ")}.`);
  }
}

function orientation(a, b, c) {
  const abx = BigInt(b[0]) - BigInt(a[0]);
  const aby = BigInt(b[1]) - BigInt(a[1]);
  const acx = BigInt(c[0]) - BigInt(a[0]);
  const acy = BigInt(c[1]) - BigInt(a[1]);
  const cross = abx * acy - aby * acx;
  return cross < 0n ? -1 : cross > 0n ? 1 : 0;
}

function onSegment(a, b, point) {
  return Math.min(a[0], b[0]) <= point[0] && point[0] <= Math.max(a[0], b[0]) &&
    Math.min(a[1], b[1]) <= point[1] && point[1] <= Math.max(a[1], b[1]);
}

function segmentsIntersect(a, b, c, d) {
  const abC = orientation(a, b, c);
  const abD = orientation(a, b, d);
  const cdA = orientation(c, d, a);
  const cdB = orientation(c, d, b);
  if (abC * abD < 0 && cdA * cdB < 0) return true;
  return (abC === 0 && onSegment(a, b, c)) || (abD === 0 && onSegment(a, b, d)) ||
    (cdA === 0 && onSegment(c, d, a)) || (cdB === 0 && onSegment(c, d, b));
}

function validatePolygon(points) {
  if (!Array.isArray(points) || points.length < 3 || points.length > MAX_POLYGON_POINTS) {
    fail(`A polygon boundary needs 3 to ${MAX_POLYGON_POINTS} grid points.`);
  }
  const seen = new Set();
  let twiceArea = 0n;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (!Array.isArray(point) || point.length !== 2 ||
        !point.every(value => Number.isSafeInteger(value) && Math.abs(value) <= MAX_CELL_COORDINATE)) {
      fail("Polygon points must be safe integer coordinates on the 32 px grid.");
    }
    const key = `${point[0]},${point[1]}`;
    if (seen.has(key)) fail("Polygon boundaries cannot repeat a point.");
    seen.add(key);
    const next = points[(index + 1) % points.length];
    twiceArea += BigInt(point[0]) * BigInt(next[1]) - BigInt(next[0]) * BigInt(point[1]);
  }
  for (let index = 0; index < points.length; index += 1) {
    const previous = points[(index + points.length - 1) % points.length];
    const current = points[index];
    const next = points[(index + 1) % points.length];
    if (orientation(previous, current, next) === 0 && !onSegment(previous, next, current)) {
      fail("Polygon boundary backtracks over itself; draw a simple closed outline.");
    }
  }
  for (let first = 0; first < points.length; first += 1) {
    const firstEnd = (first + 1) % points.length;
    for (let second = first + 1; second < points.length; second += 1) {
      const secondEnd = (second + 1) % points.length;
      if (first === second || firstEnd === second || secondEnd === first) continue;
      if (segmentsIntersect(points[first], points[firstEnd], points[second], points[secondEnd])) {
        fail("Polygon boundary self-intersects; draw a simple closed outline.");
      }
    }
  }
  if (twiceArea === 0n) fail("Polygon boundary must enclose a non-zero area.");
  return points.map(point => [...point]);
}

export function validatePlayableBoundary(boundary) {
  if (!boundary || typeof boundary !== "object" || Array.isArray(boundary)) {
    fail("Playable boundary must be a versioned object.");
  }
  if (boundary.version !== PLAYABLE_BOUNDARY_VERSION) {
    fail(`Unsupported playable boundary version ${String(boundary.version)}.`);
  }
  if (boundary.type === "grid") {
    exactKeys(boundary, ["version", "type", "sections"], "Grid playable boundary");
    if (!Array.isArray(boundary.sections) || !boundary.sections.length ||
        boundary.sections.length > MAX_SECTIONS) {
      fail(`A grid boundary must contain 1 to ${MAX_SECTIONS} occupied sections.`);
    }
    const positions = new Set();
    let totalCells = 0;
    const sections = boundary.sections.map(section => {
      exactKeys(section, ["gridX", "gridY", "mask"], "Grid boundary section");
      if (!Number.isSafeInteger(section.gridX) || !Number.isSafeInteger(section.gridY)) {
        fail("Grid boundary section positions must be safe integers.");
      }
      sectionOrigin(section.gridX, section.gridY);
      const key = `${section.gridX},${section.gridY}`;
      if (positions.has(key)) fail("Grid boundary section positions must be unique.");
      positions.add(key);
      if (typeof section.mask !== "string" || !/^[0-9a-f]{1024}$/.test(section.mask)) {
        fail("Grid boundary masks must be 4096-bit lowercase hexadecimal strings.");
      }
      for (let index = 0; index < section.mask.length; index += 2) {
        totalCells += Number.parseInt(section.mask.slice(index, index + 2), 16)
          .toString(2).replaceAll("0", "").length;
      }
      return { gridX: section.gridX, gridY: section.gridY, mask: section.mask };
    });
    if (!totalCells || totalCells > MAX_BOUNDARY_CELLS) {
      fail("A grid boundary must contain at least one playable cell.");
    }
    return { version: PLAYABLE_BOUNDARY_VERSION, type: "grid", sections };
  }
  if (boundary.type === "polygon") {
    exactKeys(boundary, ["version", "type", "points"], "Polygon playable boundary");
    return { version: PLAYABLE_BOUNDARY_VERSION, type: "polygon", points: validatePolygon(boundary.points) };
  }
  fail("Playable boundary type must be grid or polygon.");
}

function sectionIndex(sections) {
  if (!Array.isArray(sections) || !sections.length || sections.length > MAX_SECTIONS) {
    fail(`A level must contain 1 to ${MAX_SECTIONS} sections.`);
  }
  const byPosition = new Map();
  for (const section of sections) {
    if (!Number.isSafeInteger(section.gridX) || !Number.isSafeInteger(section.gridY) ||
        !section.document?.bounds || !Number.isInteger(section.document.bounds.width) ||
        !Number.isInteger(section.document.bounds.height) ||
        section.document.bounds.width < PLAYABLE_BOUNDARY_CELL_SIZE * 2 ||
        section.document.bounds.height < PLAYABLE_BOUNDARY_CELL_SIZE * 2 ||
        section.document.bounds.width > 2048 || section.document.bounds.height > 2048 ||
        section.document.bounds.width % PLAYABLE_BOUNDARY_CELL_SIZE ||
        section.document.bounds.height % PLAYABLE_BOUNDARY_CELL_SIZE) {
      fail("Playable boundary sections need valid grid positions and 32 px-aligned map bounds.");
    }
    sectionOrigin(section.gridX, section.gridY);
    const key = `${section.gridX},${section.gridY}`;
    if (byPosition.has(key)) fail(`Duplicate section position (${key}).`);
    byPosition.set(key, section);
  }
  return byPosition;
}

function cellLocation(cellX, cellY, byPosition) {
  if (![cellX, cellY].every(value => Number.isSafeInteger(value) && Math.abs(value) <= MAX_CELL_COORDINATE)) {
    fail("Playable area cells must use safe integer coordinates on the 32 px grid.");
  }
  const gridX = Math.floor(cellX / CELLS_PER_SECTION);
  const gridY = Math.floor(cellY / CELLS_PER_SECTION);
  const section = byPosition.get(`${gridX},${gridY}`);
  if (!section) fail(`Playable area extends into missing section (${gridX}, ${gridY}).`);
  const localX = cellX - gridX * CELLS_PER_SECTION;
  const localY = cellY - gridY * CELLS_PER_SECTION;
  if (localX >= section.document.bounds.width / PLAYABLE_BOUNDARY_CELL_SIZE ||
      localY >= section.document.bounds.height / PLAYABLE_BOUNDARY_CELL_SIZE) {
    fail(`Playable area extends beyond the saved map bounds of section (${gridX}, ${gridY}).`);
  }
  return { section, gridX, gridY, localX, localY };
}

function maskHasCell(mask, localX, localY) {
  const bit = localY * CELLS_PER_SECTION + localX;
  const byte = Number.parseInt(mask.slice(Math.floor(bit / 8) * 2, Math.floor(bit / 8) * 2 + 2), 16);
  return Boolean(byte & (1 << (bit % 8)));
}

function pointInPolygon(x, y, points) {
  let inside = false;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index, index += 1) {
    const [x1, y1] = points[index];
    const [x2, y2] = points[previous];
    if ((y1 > y) !== (y2 > y) && x < (x2 - x1) * (y - y1) / (y2 - y1) + x1) inside = !inside;
  }
  return inside;
}

function polygonCells(points, byPosition) {
  const minX = Math.min(...points.map(point => point[0]));
  const maxX = Math.max(...points.map(point => point[0]));
  const minY = Math.min(...points.map(point => point[1]));
  const maxY = Math.max(...points.map(point => point[1]));
  const width = maxX - minX;
  const height = maxY - minY;
  if (!width || !height || width * height > MAX_BOUNDARY_CELLS) {
    fail("Polygon boundary is empty or too large to validate safely.");
  }
  const cells = new Set();
  for (let cellY = minY; cellY < maxY; cellY += 1) {
    for (let cellX = minX; cellX < maxX; cellX += 1) {
      if (!pointInPolygon(cellX + 0.5, cellY + 0.5, points)) continue;
      cellLocation(cellX, cellY, byPosition);
      cells.add(`${cellX},${cellY}`);
    }
  }
  if (!cells.size) fail("Polygon boundary does not include any complete 32 px playable cells.");
  return cells;
}

export function defaultBoundaryCells(sections) {
  const byPosition = sectionIndex(sections);
  const cells = new Set();
  for (const section of byPosition.values()) {
    const columns = section.document.bounds.width / PLAYABLE_BOUNDARY_CELL_SIZE;
    const rows = section.document.bounds.height / PLAYABLE_BOUNDARY_CELL_SIZE;
    const firstX = section.gridX * CELLS_PER_SECTION;
    const firstY = section.gridY * CELLS_PER_SECTION;
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < columns; x += 1) cells.add(`${firstX + x},${firstY + y}`);
    }
  }
  return cells;
}

export function playableBoundaryCells(boundary, sections) {
  const validated = validatePlayableBoundary(boundary);
  const byPosition = sectionIndex(sections);
  if (validated.type === "polygon") return polygonCells(validated.points, byPosition);
  const cells = new Set();
  for (const maskSection of validated.sections) {
    const section = byPosition.get(`${maskSection.gridX},${maskSection.gridY}`);
    if (!section) {
      fail(`Playable area extends into missing section (${maskSection.gridX}, ${maskSection.gridY}).`);
    }
    for (let localY = 0; localY < CELLS_PER_SECTION; localY += 1) {
      for (let localX = 0; localX < CELLS_PER_SECTION; localX += 1) {
        if (!maskHasCell(maskSection.mask, localX, localY)) continue;
        const cellX = maskSection.gridX * CELLS_PER_SECTION + localX;
        const cellY = maskSection.gridY * CELLS_PER_SECTION + localY;
        cellLocation(cellX, cellY, byPosition);
        cells.add(`${cellX},${cellY}`);
      }
    }
  }
  return cells;
}

export function validatePlayableBoundaryForSections(boundary, sections) {
  return playableBoundaryCells(boundary, sections);
}

export function createGridBoundary(cells, sections) {
  const byPosition = sectionIndex(sections);
  const masks = new Map();
  if (!cells || typeof cells[Symbol.iterator] !== "function") fail("Grid selection cells must be iterable.");
  const entries = [...cells].map(cell => typeof cell === "string" ? cell : `${cell?.x},${cell?.y}`);
  if (!entries.length || entries.length > MAX_BOUNDARY_CELLS) {
    fail(`Grid selection must contain 1 to ${MAX_BOUNDARY_CELLS} cells.`);
  }
  for (const entry of entries) {
    const [cellX, cellY] = typeof entry === "string" ? entry.split(",").map(Number) : [NaN, NaN];
    const { gridX, gridY, localX, localY } = cellLocation(cellX, cellY, byPosition);
    const key = `${gridX},${gridY}`;
    if (!masks.has(key)) masks.set(key, { gridX, gridY, bytes: new Uint8Array(MASK_BYTES) });
    const bit = localY * CELLS_PER_SECTION + localX;
    masks.get(key).bytes[Math.floor(bit / 8)] |= 1 << (bit % 8);
  }
  const boundary = validatePlayableBoundary({
    version: PLAYABLE_BOUNDARY_VERSION,
    type: "grid",
    sections: [...masks.values()].map(({ gridX, gridY, bytes }) => ({
      gridX, gridY, mask: [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("")
    }))
  });
  return { boundary, cells: playableBoundaryCells(boundary, sections) };
}

export function createGridRectangleBoundary(start, end, sections) {
  const left = Math.min(start.x, end.x);
  const right = Math.max(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const bottom = Math.max(start.y, end.y);
  const width = right - left + 1;
  const height = bottom - top + 1;
  if (![left, right, top, bottom].every(Number.isSafeInteger) || width * height > MAX_BOUNDARY_CELLS) {
    fail(`Grid selection exceeds the ${MAX_BOUNDARY_CELLS}-cell limit.`);
  }
  const cells = new Set();
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) cells.add(`${x},${y}`);
  }
  return createGridBoundary(cells, sections);
}

export function createPolygonBoundary(points, sections) {
  const boundary = validatePlayableBoundary({
    version: PLAYABLE_BOUNDARY_VERSION, type: "polygon", points
  });
  return { boundary, cells: playableBoundaryCells(boundary, sections) };
}

export function boundaryEdges(cells) {
  const edges = [];
  for (const key of cells) {
    const [x, y] = key.split(",").map(Number);
    if (!cells.has(`${x},${y - 1}`)) edges.push({ x1: x, y1: y, x2: x + 1, y2: y });
    if (!cells.has(`${x + 1},${y}`)) edges.push({ x1: x + 1, y1: y, x2: x + 1, y2: y + 1 });
    if (!cells.has(`${x},${y + 1}`)) edges.push({ x1: x, y1: y + 1, x2: x + 1, y2: y + 1 });
    if (!cells.has(`${x - 1},${y}`)) edges.push({ x1: x, y1: y, x2: x, y2: y + 1 });
  }
  return edges;
}

export function boundaryCollisionRectangles(boundary, document) {
  const section = { gridX: 0, gridY: 0, document };
  const playable = playableBoundaryCells(boundary, [section]);
  const all = defaultBoundaryCells([section]);
  const blocked = new Set([...all].filter(cell => !playable.has(cell)));
  return cellRectangles(blocked).map(rectangle => ({
    x: rectangle.x * PLAYABLE_BOUNDARY_CELL_SIZE,
    y: rectangle.y * PLAYABLE_BOUNDARY_CELL_SIZE,
    width: rectangle.width * PLAYABLE_BOUNDARY_CELL_SIZE,
    height: rectangle.height * PLAYABLE_BOUNDARY_CELL_SIZE
  }));
}

export function cellRectangles(cells) {
  const rows = new Map();
  for (const key of cells) {
    const [x, y] = key.split(",").map(Number);
    if (!rows.has(y)) rows.set(y, []);
    rows.get(y).push(x);
  }
  const result = [];
  const active = new Map();
  const ys = [...rows.keys()].sort((a, b) => a - b);
  let previousY = null;
  for (const y of ys) {
    if (previousY !== null && y !== previousY + 1) {
      result.push(...active.values());
      active.clear();
    }
    const xs = rows.get(y).sort((a, b) => a - b);
    const runs = [];
    for (const x of xs) {
      const last = runs.at(-1);
      if (last && last.x + last.width === x) last.width += 1;
      else runs.push({ x, y, width: 1, height: 1 });
    }
    const next = new Map();
    for (const run of runs) {
      const key = `${run.x},${run.width}`;
      const prior = active.get(key);
      if (prior) {
        prior.height += 1;
        next.set(key, prior);
      } else next.set(key, run);
    }
    for (const [key, rectangle] of active) {
      if (!next.has(key)) result.push(rectangle);
    }
    active.clear();
    for (const [key, rectangle] of next) active.set(key, rectangle);
    previousY = y;
  }
  result.push(...active.values());
  return result;
}

export function appendPlayableBoundaryCollisions(map, document) {
  if (!document.playableBoundary) return map;
  const rectangles = boundaryCollisionRectangles(document.playableBoundary, document);
  return appendCollisionRectangles(map, rectangles);
}

export function appendCollisionRectangles(map, rectangles) {
  if (map.objects.length + rectangles.length > 4096 || map.collisions.length + rectangles.length > 4096) {
    fail("The installed public map contract allows at most 4096 objects and collisions; the playable boundary exceeds that limit.");
  }
  const objectIds = new Set(map.objects.map(object => object.id));
  const collisionIds = new Set(map.collisions.map(collision => collision.id));
  const objects = [...map.objects];
  const collisions = [...map.collisions];
  rectangles.forEach((rect, index) => {
    let objectId = `playable-boundary:${index}`;
    while (objectIds.has(objectId)) objectId += ":x";
    let collisionId = `collision-${objectId}`;
    while (collisionIds.has(collisionId)) collisionId += ":x";
    objectIds.add(objectId);
    collisionIds.add(collisionId);
    objects.push({
      id: objectId,
      typeId: "playable-boundary",
      position: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    });
    collisions.push({
      id: collisionId,
      objectId,
      shape: { type: "rect", width: rect.width, height: rect.height }
    });
  });
  return { ...map, objects, collisions };
}

export function boundaryContainsCircle(boundary, document, position, radius) {
  if (!boundary) return true;
  const cells = playableBoundaryCells(boundary, [{ gridX: 0, gridY: 0, document }]);
  const minX = Math.floor((position.x - radius) / PLAYABLE_BOUNDARY_CELL_SIZE);
  const maxX = Math.floor((position.x + radius) / PLAYABLE_BOUNDARY_CELL_SIZE);
  const minY = Math.floor((position.y - radius) / PLAYABLE_BOUNDARY_CELL_SIZE);
  const maxY = Math.floor((position.y + radius) / PLAYABLE_BOUNDARY_CELL_SIZE);
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if (cells.has(`${x},${y}`)) continue;
      const closestX = Math.max(x * PLAYABLE_BOUNDARY_CELL_SIZE,
        Math.min(position.x, (x + 1) * PLAYABLE_BOUNDARY_CELL_SIZE));
      const closestY = Math.max(y * PLAYABLE_BOUNDARY_CELL_SIZE,
        Math.min(position.y, (y + 1) * PLAYABLE_BOUNDARY_CELL_SIZE));
      if ((position.x - closestX) ** 2 + (position.y - closestY) ** 2 < radius ** 2) return false;
    }
  }
  return true;
}
