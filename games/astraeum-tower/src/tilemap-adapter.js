import { MAP_CELL_SIZE, validateMapDefinition } from "@multiplayer-game/theme-sdk";

export const TILE_CELL_SIZE = MAP_CELL_SIZE;

function assertGrid(grid, cellSize, wallMarker) {
  if (!Array.isArray(grid) || grid.length === 0 ||
      !grid.every(row => typeof row === "string" && row.length === grid[0].length) ||
      grid[0].length === 0 || !Number.isInteger(cellSize) || cellSize !== TILE_CELL_SIZE ||
      typeof wallMarker !== "string" || wallMarker.length !== 1) {
    throw new TypeError(`The tilemap must be a non-empty rectangular grid of ${TILE_CELL_SIZE} px cells.`);
  }
}

export function createTilemapDefinition(grid, {
  id,
  name,
  cellSize = TILE_CELL_SIZE,
  wallMarker = "#",
  playerSpawnMarker = "P",
  openSpawnMarker = "."
}) {
  assertGrid(grid, cellSize, wallMarker);
  const objects = [];
  const collisions = [];
  let playerSpawn;
  let reservedPlayerSpawn;

  for (let y = 0; y < grid.length; y += 1) {
    let x = 0;
    while (x < grid[y].length) {
      if (grid[y][x] === playerSpawnMarker) {
        if (playerSpawn) throw new Error("The tilemap must contain exactly one player spawn.");
        playerSpawn = { x: x * cellSize + cellSize / 2, y: y * cellSize + cellSize / 2 };
      }
      if (grid[y][x] !== wallMarker) {
        if (!reservedPlayerSpawn && grid[y][x] === openSpawnMarker) {
          reservedPlayerSpawn = { x: x * cellSize + cellSize / 2, y: y * cellSize + cellSize / 2 };
        }
        x += 1;
        continue;
      }

      const start = x;
      while (x < grid[y].length && grid[y][x] === wallMarker) x += 1;
      const width = (x - start) * cellSize;
      const objectId = `wall-${start}-${y}`;
      objects.push({
        id: objectId,
        typeId: "wall",
        position: { x: start * cellSize + width / 2, y: y * cellSize + cellSize / 2 }
      });
      collisions.push({
        id: `collision-${start}-${y}`,
        objectId,
        shape: { type: "rect", width, height: cellSize }
      });
    }
  }

  if (!playerSpawn || !reservedPlayerSpawn) {
    throw new Error("The tilemap requires a player start and an additional open player spawn.");
  }
  return validateMapDefinition({
    formatVersion: 1,
    id,
    name,
    bounds: { width: grid[0].length * cellSize, height: grid.length * cellSize },
    cellSize,
    objects,
    collisions,
    spawns: [
      { id: "aries-start", kind: "player", position: playerSpawn, radius: 4 },
      { id: "reserved-player-spawn", kind: "player", position: reservedPlayerSpawn, radius: 4 }
    ]
  });
}

export function isActorBlocked(grid, feet, {
  halfWidth = 0,
  halfHeight = 0,
  wallFacePx = 0,
  cellSize = TILE_CELL_SIZE,
  wallMarker = "#"
} = {}) {
  const width = grid[0].length;
  const height = grid.length;
  const isWall = (x, y) => x < 0 || y < 0 || x >= width || y >= height ||
    grid[y][x] === wallMarker;
  const x0 = Math.floor((feet.x - halfWidth) / cellSize);
  const x1 = Math.floor((feet.x + halfWidth) / cellSize);
  const y0 = Math.floor((feet.y - halfHeight) / cellSize);
  const y1 = Math.floor(feet.y / cellSize);

  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      if (isWall(x, y)) return true;
    }
  }
  if (feet.y - y1 * cellSize < wallFacePx) {
    for (let x = x0; x <= x1; x += 1) {
      if (isWall(x, y1 - 1)) return true;
    }
  }
  return false;
}

export function moveActor(geometry, grid, feet, delta, {
  radius = 4,
  halfWidth = 0,
  halfHeight = 0,
  wallFacePx = 0,
  blockers = [],
  cellSize = TILE_CELL_SIZE,
  wallMarker = "#"
} = {}) {
  let position = { ...feet };
  for (const axis of ["x", "y"]) {
    const change = delta[axis];
    if (change === 0) continue;
    const candidate = { ...position, [axis]: position[axis] + change };
    if (isActorBlocked(grid, candidate, { halfWidth, halfHeight, wallFacePx, cellSize, wallMarker })) continue;
    const actorLeft = candidate.x - halfWidth;
    const actorRight = candidate.x + halfWidth;
    const actorTop = candidate.y - halfHeight;
    const actorBottom = candidate.y;
    const overlapsWall = blockers.some(wall =>
      actorRight > wall.x && actorLeft < wall.x + wall.width &&
      actorBottom > wall.y && actorTop < wall.y + wall.height);
    if (overlapsWall) continue;
    const center = { x: position.x, y: position.y - 4 };
    const movement = axis === "x" ? { x: change, y: 0 } : { x: 0, y: change };
    const moved = geometry.moveCircle(center, movement, radius);
    position = { x: moved.x, y: moved.y + 4 };
  }
  return position;
}
