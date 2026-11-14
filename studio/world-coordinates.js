export const SECTION_SIZE = 2048;

export function sectionOrigin(gridX, gridY) {
  if (!Number.isSafeInteger(gridX) || !Number.isSafeInteger(gridY)) {
    throw new RangeError("Section grid coordinates must be safe integers.");
  }
  const x = gridX * SECTION_SIZE;
  const y = gridY * SECTION_SIZE;
  if (![x, y, x + SECTION_SIZE, y + SECTION_SIZE].every(Number.isSafeInteger)) {
    throw new RangeError("Section bounds exceed safe integer coordinates.");
  }
  return { x, y };
}

export function worldToSection(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new RangeError("World coordinates must be finite.");
  const gridX = Math.floor(x / SECTION_SIZE);
  const gridY = Math.floor(y / SECTION_SIZE);
  const origin = sectionOrigin(gridX, gridY);
  return { gridX, gridY, x: x - origin.x, y: y - origin.y };
}

export function sectionToWorld(gridX, gridY, x, y) {
  const origin = sectionOrigin(gridX, gridY);
  if (![x, y].every(value => Number.isFinite(value) && value >= 0 && value < SECTION_SIZE)) {
    throw new RangeError("Local coordinates must be within the section.");
  }
  return { x: origin.x + x, y: origin.y + y };
}
