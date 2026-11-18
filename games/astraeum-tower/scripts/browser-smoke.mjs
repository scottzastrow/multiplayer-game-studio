import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createWorldLightingSettings } from "../src/lighting/world-lighting.js";
import { createTowerLightingSettings, towerLightingSettings } from "../src/lighting/tower-lighting.js";

const floor1 = JSON.parse(await readFile(new URL("../src/floor1.json", import.meta.url), "utf8")).f1;
assert.deepEqual(
  towerLightingSettings,
  {
    ambientBrightness: 0.2,
    playerLightRadius: 200,
    playerLightIntensity: 1,
    playerLightSoftness: 0.55,
    fullyLit: false
  },
  "Tower defaults preserve the original Floor 1 lighting"
);
assert.equal(createTowerLightingSettings({ fullyLit: true }).fullyLit, true);
assert.throws(() => createWorldLightingSettings({ ambientBrightness: 1.1 }), TypeError,
  "lighting settings reject values outside their supported ranges");

const origin = process.env.BROWSER_TEST_ORIGIN ?? "http://127.0.0.1:5180";
const debugUrl = process.env.BROWSER_DEBUG_URL ?? "http://127.0.0.1:9223";
const versionResponse = await fetch(`${debugUrl}/json/version`);
assert.equal(versionResponse.ok, true, "Chrome DevTools must be running on port 9223.");
const version = await versionResponse.json();
const socket = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let nextId = 0;
const pending = new Map();
const exceptions = [];
socket.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data);
  if (message.method === "Runtime.exceptionThrown") {
    exceptions.push(message.params.exceptionDetails.exception?.description ?? "Browser exception");
  }
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  clearTimeout(request.timeout);
  if (message.error) request.reject(new Error(message.error.message));
  else request.resolve(message.result);
});

function cdp(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, 10_000);
    pending.set(id, { resolve, reject, timeout });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

async function evaluate(sessionId, expression) {
  const response = await cdp("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  }, sessionId);
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description ?? "Browser evaluation failed.");
  }
  return response.result.value;
}

async function waitFor(sessionId, expression, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(sessionId, expression)) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for browser condition: ${expression}`);
}

async function key(sessionId, type, code, value) {
  await cdp("Input.dispatchKeyEvent", {
    type,
    code,
    key: value,
    windowsVirtualKeyCode: value.length === 1 ? value.toUpperCase().charCodeAt(0) : undefined
  }, sessionId);
}

async function readPixel(sessionId, x, y) {
  return evaluate(sessionId, `(() => {
    const canvas = document.querySelector('[data-testid="astraeum-world"]');
    const ratio = Number(canvas.dataset.viewportDevicePixelRatio);
    return [...canvas.getContext("2d").getImageData(
      Math.round(${x} * ratio), Math.round(${y} * ratio), 1, 1
    ).data];
  })()`);
}

function luminance(pixel) {
  return pixel[0] * 0.2126 + pixel[1] * 0.7152 + pixel[2] * 0.0722;
}

async function keyUntil(sessionId, code, value, condition, direction) {
  await key(sessionId, "keyDown", code, value);
  try {
    return await evaluate(sessionId, `new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for ${direction} movement.")), 8000);
      const poll = () => {
        const canvas = document.querySelector('[data-testid="astraeum-world"]');
        if (${condition}) {
          clearTimeout(timeout);
          window.dispatchEvent(new KeyboardEvent("keyup", {
            key: ${JSON.stringify(value)}, code: ${JSON.stringify(code)}, bubbles: true
          }));
          resolve({ x: Number(canvas.dataset.x), y: Number(canvas.dataset.y) });
          return;
        }
        requestAnimationFrame(poll);
      };
      requestAnimationFrame(poll);
    })`);
  } finally {
    await key(sessionId, "keyUp", code, value);
  }
}

function isOriginalPlayerBlocked(grid, feet) {
  const isWall = (x, y) => x < 0 || y < 0 || y >= grid.length ||
    x >= grid[0].length || grid[y][x] === "#";
  const x0 = Math.floor((feet.x - 9) / 32);
  const x1 = Math.floor((feet.x + 9) / 32);
  const y0 = Math.floor((feet.y - 8) / 32);
  const y1 = Math.floor(feet.y / 32);
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      if (isWall(x, y)) return true;
    }
  }
  if (feet.y - y1 * 32 < 12) {
    for (let x = x0; x <= x1; x += 1) {
      if (isWall(x, y1 - 1)) return true;
    }
  }
  return false;
}

function findOriginalCollisionPath(grid, start, target) {
  // The 30 Hz preview applies two 2 px movement substeps per tick.
  const columns = grid[0].length * 8;
  const rows = grid.length * 8;
  const indexFor = (x, y) => y * columns + x;
  const startX = Math.round(start.x / 4);
  const startY = Math.round(start.y / 4);
  const targetX = Math.round(target.x / 4);
  const targetY = Math.round(target.y / 4);
  const startIndex = indexFor(startX, startY);
  const previous = new Int32Array(columns * rows).fill(-2);
  const directionTo = new Uint8Array(columns * rows);
  const queue = new Int32Array(columns * rows);
  let head = 0;
  let tail = 0;
  queue[tail++] = startIndex;
  previous[startIndex] = -1;
  const moves = [
    { dx: 0, dy: 1, direction: "south" },
    { dx: 0, dy: -1, direction: "north" },
    { dx: 1, dy: 0, direction: "east" },
    { dx: -1, dy: 0, direction: "west" }
  ];

  while (head < tail) {
    const index = queue[head++];
    const x = index % columns;
    const y = Math.floor(index / columns);
    if (x === targetX && y === targetY) break;
    for (let move = 0; move < moves.length; move += 1) {
      const { dx, dy } = moves[move];
      const nextX = x + dx;
      const nextY = y + dy;
      if (nextX < 0 || nextY < 0 || nextX >= columns || nextY >= rows) continue;
      const next = indexFor(nextX, nextY);
      const midpoint = { x: (x + nextX) * 2, y: (y + nextY) * 2 };
      if (previous[next] !== -2 ||
          isOriginalPlayerBlocked(grid, midpoint) ||
          isOriginalPlayerBlocked(grid, { x: nextX * 4, y: nextY * 4 })) continue;
      previous[next] = index;
      directionTo[next] = move;
      queue[tail++] = next;
    }
  }

  const targetIndex = indexFor(targetX, targetY);
  if (previous[targetIndex] === -2) {
    throw new Error(`Original collision rules have no route from ${start.x},${start.y} to ${target.x},${target.y}.`);
  }
  const directions = [];
  for (let index = targetIndex; previous[index] !== -1; index = previous[index]) {
    directions.push(directionTo[index]);
  }
  directions.reverse();
  const segments = [];
  let x = startX * 4;
  let y = startY * 4;
  for (const move of directions) {
    const { dx, dy, direction } = moves[move];
    x += dx * 4;
    y += dy * 4;
    const last = segments.at(-1);
    if (last?.direction === direction) {
      last.x = x;
      last.y = y;
    } else {
      segments.push({ direction, x, y });
    }
  }
  return segments;
}

async function navigateByOriginalCollision(sessionId, target, onStep) {
  const keyFor = {
    east: ["KeyD", "d"], west: ["KeyA", "a"],
    north: ["KeyW", "w"], south: ["KeyS", "s"]
  };
  let turns = 0;
  for (; turns < 200; turns += 1) {
    const position = await evaluate(sessionId, `(() => {
      const canvas = document.querySelector('[data-testid="astraeum-world"]');
      return { x: Number(canvas.dataset.x), y: Number(canvas.dataset.y) };
    })()`);
    if (Math.abs(position.x - target.x) < 2 && Math.abs(position.y - target.y) < 2) return turns;
    const segments = findOriginalCollisionPath(floor1, position, target);
    const segment = segments[0];
    if (!segment) throw new Error(`No path segment from ${position.x},${position.y} to ${target.x},${target.y}.`);
    const [code, value] = keyFor[segment.direction];
    const nextSegment = segments[1];
    const distance = segment.direction === "east" ? segment.x - position.x
      : segment.direction === "west" ? position.x - segment.x
        : segment.direction === "south" ? segment.y - position.y : position.y - segment.y;
    const stopShort = nextSegment && distance > 4 ? 4 : 0;
    const stopX = segment.x - (segment.direction === "east" ? stopShort
      : segment.direction === "west" ? -stopShort : 0);
    const stopY = segment.y - (segment.direction === "south" ? stopShort
      : segment.direction === "north" ? -stopShort : 0);
    const condition = segment.direction === "east"
      ? `Number(document.querySelector('[data-testid="astraeum-world"]').dataset.x) >= ${stopX}`
      : segment.direction === "west"
        ? `Number(document.querySelector('[data-testid="astraeum-world"]').dataset.x) <= ${stopX}`
        : segment.direction === "south"
            ? `Number(document.querySelector('[data-testid="astraeum-world"]').dataset.y) >= ${stopY}`
            : `Number(document.querySelector('[data-testid="astraeum-world"]').dataset.y) <= ${stopY}`;
    try {
      const next = await keyUntil(sessionId, code, value, condition, segment.direction);
      onStep?.({ from: position, to: next, direction: segment.direction });
    } catch (error) {
      const current = await evaluate(sessionId, `(() => {
        const canvas = document.querySelector('[data-testid="astraeum-world"]');
        return { x: Number(canvas.dataset.x), y: Number(canvas.dataset.y),
          facing: canvas.dataset.facing };
      })()`);
      throw new Error(`Stalled moving ${segment.direction} toward ${segment.x},${segment.y} ` +
        `at ${current.x},${current.y} facing ${current.facing}: ${error.message}`);
    }
  }
  throw new Error(`Navigation exceeded ${turns} turns before reaching ${target.x},${target.y}.`);
}

let targetId;
let sessionId;
try {
  const target = await cdp("Target.createTarget", { url: origin });
  targetId = target.targetId;
  ({ sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true }));
  await cdp("Page.enable", {}, sessionId);
  await cdp("Runtime.enable", {}, sessionId);
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 800, height: 640, deviceScaleFactor: 1, mobile: false
  }, sessionId);
  await cdp("Page.reload", {}, sessionId);
  await waitFor(sessionId,
    `document.querySelector("#preview-status")?.textContent.includes("Aries is ready") &&
    document.querySelector('[data-testid="astraeum-world"]')?.dataset.x !== undefined`);

  const map = await evaluate(sessionId, `(() => {
    const canvas = document.querySelector('[data-testid="astraeum-world"]');
    return {
      width: Number(canvas.dataset.mapWidth),
      height: Number(canvas.dataset.mapHeight),
      cell: Number(canvas.dataset.cellSize),
      collisionRectangles: Number(canvas.dataset.collisionRectangles),
      worldWidth: Number(canvas.dataset.worldWidth),
      worldHeight: Number(canvas.dataset.worldHeight),
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      viewportWidth: Number(canvas.dataset.viewportWidth),
      viewportHeight: Number(canvas.dataset.viewportHeight),
      pixelRatio: Number(canvas.dataset.viewportDevicePixelRatio),
      cssWidth: canvas.getBoundingClientRect().width,
      cssHeight: canvas.getBoundingClientRect().height,
      cameraX: Number(canvas.dataset.cameraX),
      cameraY: Number(canvas.dataset.cameraY),
      smoothing: canvas.dataset.smoothing,
      imageRendering: canvas.style.imageRendering,
      x: Number(canvas.dataset.x),
      y: Number(canvas.dataset.y)
    };
  })()`);
  assert.deepEqual(
    { width: map.width, height: map.height, cell: map.cell,
      worldWidth: map.worldWidth, worldHeight: map.worldHeight },
    { width: 36, height: 22, cell: 32, worldWidth: 1152, worldHeight: 704 },
    "the original Floor 1 dimensions are retained"
  );
  assert.ok(map.viewportWidth < map.worldWidth && map.viewportHeight < map.worldHeight,
    "the camera is tested through a viewport smaller than the original map");
  assert.equal(map.cssWidth, map.viewportWidth, "the world viewport is displayed at CSS-pixel size");
  assert.equal(map.cssHeight, map.viewportHeight, "the world viewport height is not stretched");
  assert.equal(map.canvasWidth, map.viewportWidth * map.pixelRatio,
    "the canvas backing store matches viewport CSS pixels and device scale");
  assert.equal(map.canvasHeight, map.viewportHeight * map.pixelRatio,
    "the canvas backing store matches viewport CSS pixels and device scale");
  assert.equal(map.cameraX, 0, "the starting camera clamps to the map's left boundary");
  assert.equal(map.cameraY, 0, "the starting camera clamps to the map's top boundary");
  assert.ok(map.collisionRectangles > 0, "wall runs are represented by public collision rectangles");
  assert.equal(map.smoothing, "false", "Canvas image smoothing is disabled");
  assert.equal(map.imageRendering, "pixelated", "CSS keeps scaled pixel art crisp");
  const lighting = await evaluate(sessionId, `(() => {
    const canvas = document.querySelector('[data-testid="astraeum-world"]');
    return {
      ambientBrightness: Number(canvas.dataset.ambientBrightness),
      playerLightRadius: Number(canvas.dataset.playerLightRadius),
      playerLightIntensity: Number(canvas.dataset.playerLightIntensity),
      playerLightSoftness: Number(canvas.dataset.playerLightSoftness),
      fullyLit: canvas.dataset.fullyLit
    };
  })()`);
  assert.deepEqual(lighting, {
    ambientBrightness: 0.2,
    playerLightRadius: 200,
    playerLightIntensity: 1,
    playerLightSoftness: 0.55,
    fullyLit: "false"
  }, "the mounted skin exposes the original validated lighting settings");
  const initialNearPixel = await readPixel(sessionId, 254, 132);
  const initialFarPixel = await readPixel(sessionId, 500, 400);
  assert.ok(luminance(initialNearPixel) > luminance(initialFarPixel),
    "the player light reveals nearby world terrain more than distant terrain");

  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 1400, height: 1200, deviceScaleFactor: 2, mobile: false
  }, sessionId);
  await cdp("Runtime.evaluate", {
    expression: "window.dispatchEvent(new Event('resize'))"
  }, sessionId);
  await waitFor(sessionId, `(() => {
    const canvas = document.querySelector('[data-testid="astraeum-world"]');
    return Number(canvas.dataset.viewportWidth) > 1152 &&
      Number(canvas.dataset.viewportHeight) > 704 &&
      Number(canvas.dataset.viewportDevicePixelRatio) === 2 &&
      Number(canvas.dataset.cameraX) < 0 && Number(canvas.dataset.cameraY) < 0;
  })()`);
  const centeredCamera = await evaluate(sessionId, `(() => {
    const canvas = document.querySelector('[data-testid="astraeum-world"]');
    return {
      width: Number(canvas.dataset.viewportWidth),
      height: Number(canvas.dataset.viewportHeight),
      pixelRatio: Number(canvas.dataset.viewportDevicePixelRatio),
      cameraX: Number(canvas.dataset.cameraX),
      cameraY: Number(canvas.dataset.cameraY),
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      cssWidth: canvas.getBoundingClientRect().width,
      cssHeight: canvas.getBoundingClientRect().height,
      playerScreenX: Number(canvas.dataset.playerScreenX),
      playerScreenY: Number(canvas.dataset.playerScreenY),
      lightScreenX: Number(canvas.dataset.lightingScreenX),
      lightScreenY: Number(canvas.dataset.lightingScreenY)
    };
  })()`);
  assert.ok(centeredCamera.cameraX < 0 && centeredCamera.cameraY < 0,
    "maps smaller than the viewport are centered without scaling");
  assert.equal(centeredCamera.canvasWidth, centeredCamera.width * centeredCamera.pixelRatio,
    "high-DPI rendering keeps the world at one CSS pixel per world pixel");
  assert.equal(centeredCamera.canvasHeight, centeredCamera.height * centeredCamera.pixelRatio,
    "high-DPI rendering preserves vertical world scale");
  assert.equal(centeredCamera.cssWidth, centeredCamera.width);
  assert.equal(centeredCamera.cssHeight, centeredCamera.height);
  assert.equal(centeredCamera.lightScreenX, centeredCamera.playerScreenX,
    "the player light uses the same horizontal camera transform as Aries");
  assert.equal(centeredCamera.lightScreenY, centeredCamera.playerScreenY - 20,
    "the player light keeps its world-space offset through camera centering");
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 800, height: 640, deviceScaleFactor: 1, mobile: false
  }, sessionId);
  await cdp("Runtime.evaluate", {
    expression: "window.dispatchEvent(new Event('resize'))"
  }, sessionId);
  await waitFor(sessionId, `Number(document.querySelector('[data-testid="astraeum-world"]')
    .dataset.viewportWidth) === ${map.viewportWidth}`);

  const statusBeforeLighting = await evaluate(sessionId,
    `document.querySelector("#preview-status").textContent`);
  await evaluate(sessionId, `(() => {
    const option = document.querySelector('[data-setting="fullyLit"]');
    option.checked = true;
    option.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await new Promise(resolve => setTimeout(resolve, 120));
  await waitFor(sessionId,
    `document.querySelector('[data-testid="astraeum-world"]').dataset.fullyLit === "true"`);
  const fullyLitFarPixel = await readPixel(sessionId, 500, 400);
  assert.ok(luminance(fullyLitFarPixel) > luminance(initialFarPixel) + 8,
    `fully lit mode removes ambient darkness (dark=${initialFarPixel}, lit=${fullyLitFarPixel})`);
  assert.equal(await evaluate(sessionId,
    `document.querySelector("#preview-status").textContent`), statusBeforeLighting,
  "world lighting does not alter the independent HUD/status UI");

  await evaluate(sessionId, `(() => {
    const option = document.querySelector('[data-setting="fullyLit"]');
    option.checked = false;
    option.dispatchEvent(new Event("change", { bubbles: true }));
    const radius = document.querySelector('[data-setting="playerLightRadius"]');
    radius.value = "50";
    radius.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await waitFor(sessionId,
    `document.querySelector('[data-testid="astraeum-world"]').dataset.playerLightRadius === "50"`);
  await new Promise(resolve => setTimeout(resolve, 120));
  const shortRadiusPixel = await readPixel(sessionId, 254, 132);
  assert.ok(luminance(initialNearPixel) > luminance(shortRadiusPixel) + 8,
    "the validated radius setting changes the world-space light reach");
  await evaluate(sessionId, `(() => {
    const radius = document.querySelector('[data-setting="playerLightRadius"]');
    radius.value = "200";
    radius.dispatchEvent(new Event("input", { bubbles: true }));
    const intensity = document.querySelector('[data-setting="playerLightIntensity"]');
    intensity.value = "0";
    intensity.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await waitFor(sessionId,
    `document.querySelector('[data-testid="astraeum-world"]').dataset.playerLightIntensity === "0"`);
  await new Promise(resolve => setTimeout(resolve, 120));
  const noIntensityPixel = await readPixel(sessionId, 254, 132);
  assert.ok(luminance(initialNearPixel) > luminance(noIntensityPixel) + 8,
    "zero light intensity leaves ambient darkness intact");
  await evaluate(sessionId, `(() => {
    const intensity = document.querySelector('[data-setting="playerLightIntensity"]');
    intensity.value = "1";
    intensity.dispatchEvent(new Event("input", { bubbles: true }));
    const softness = document.querySelector('[data-setting="playerLightSoftness"]');
    softness.value = "0.2";
    softness.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await waitFor(sessionId,
    `document.querySelector('[data-testid="astraeum-world"]').dataset.playerLightSoftness === "0.2"`);
  await new Promise(resolve => setTimeout(resolve, 120));
  const harderFalloffPixel = await readPixel(sessionId, 254, 132);
  assert.ok(luminance(initialNearPixel) > luminance(harderFalloffPixel) + 4,
    "the validated softness setting changes radial falloff");
  await evaluate(sessionId, `(() => {
    const softness = document.querySelector('[data-setting="playerLightSoftness"]');
    softness.value = "0.55";
    softness.dispatchEvent(new Event("input", { bubbles: true }));
    const ambient = document.querySelector('[data-setting="ambientBrightness"]');
    ambient.value = "1";
    ambient.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await waitFor(sessionId,
    `document.querySelector('[data-testid="astraeum-world"]').dataset.ambientBrightness === "1"`);
  await new Promise(resolve => setTimeout(resolve, 120));
  const fullAmbientPixel = await readPixel(sessionId, 500, 400);
  assert.ok(luminance(fullAmbientPixel) >= luminance(fullyLitFarPixel) - 2,
    "ambient brightness can independently remove ambient darkness");
  await evaluate(sessionId, `(() => {
    const ambient = document.querySelector('[data-setting="ambientBrightness"]');
    ambient.value = "0.2";
    ambient.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await waitFor(sessionId,
    `document.querySelector('[data-testid="astraeum-world"]').dataset.ambientBrightness === "0.2"`);
  await new Promise(resolve => setTimeout(resolve, 150));
  const widthBeforeResize = await evaluate(sessionId, `(() =>
    document.querySelector('[data-testid="astraeum-world"]').getBoundingClientRect().width)()`);
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: 640, height: 720, deviceScaleFactor: 1, mobile: false
  }, sessionId);
  await cdp("Runtime.evaluate", {
    expression: "window.dispatchEvent(new Event('resize'))"
  }, sessionId);
  await waitFor(sessionId, `document.querySelector('[data-testid="astraeum-world"]')
    .getBoundingClientRect().width < ${widthBeforeResize - 20}`);
  const resizeState = await evaluate(sessionId, `(() => {
    const canvas = document.querySelector('[data-testid="astraeum-world"]');
    return { width: canvas.width, height: canvas.height,
      viewportWidth: Number(canvas.dataset.viewportWidth),
      viewportHeight: Number(canvas.dataset.viewportHeight),
      displayWidth: canvas.getBoundingClientRect().width,
      cameraX: Number(canvas.dataset.cameraX),
      cameraY: Number(canvas.dataset.cameraY) };
  })()`);
  assert.equal(resizeState.width, resizeState.viewportWidth, "resizing updates the canvas width in CSS pixels");
  assert.equal(resizeState.height, resizeState.viewportHeight, "resizing updates the canvas height in CSS pixels");
  assert.equal(resizeState.displayWidth, resizeState.viewportWidth,
    "the world viewport responds to resizing without stretching");
  assert.ok(resizeState.displayWidth < widthBeforeResize, "the world viewport responds to resizing");
  assert.equal(resizeState.cameraX, 0, "resizing retains left-boundary camera clamping at the spawn");
  assert.equal(resizeState.cameraY, 0, "resizing retains top-boundary camera clamping at the spawn");
  const afterResizePixel = await readPixel(sessionId, 500, 400);
  assert.ok(Math.abs(luminance(afterResizePixel) - luminance(initialFarPixel)) < 12,
    "lighting remains in world coordinates after the viewport is resized");
  await cdp("Emulation.clearDeviceMetricsOverride", {}, sessionId);

  const directions = { east: ["KeyD", "d"], north: ["KeyW", "w"] };
  const start = { x: map.x, y: map.y };
  await key(sessionId, "keyDown", ...directions.east);
  await waitFor(sessionId, `Number(document.querySelector('[data-testid="astraeum-world"]').dataset.x) > ${start.x + 2} &&
    Number(document.querySelector('[data-testid="astraeum-world"]').dataset.frame) > 0`);
  const afterEast = await evaluate(sessionId, `(() => {
    const canvas = document.querySelector('[data-testid="astraeum-world"]');
    return {
      x: Number(canvas.dataset.x), y: Number(canvas.dataset.y),
      lightX: Number(canvas.dataset.lightingCenterX),
      lightY: Number(canvas.dataset.lightingCenterY)
    };
  })()`);
  assert.equal(afterEast.y, start.y, "horizontal input does not add unintended diagonal movement");
  assert.equal(afterEast.lightX, afterEast.x, "the world-space light follows player movement");
  assert.equal(afterEast.lightY, afterEast.y - 20, "the light keeps the original player-relative offset");
  await key(sessionId, "keyDown", ...directions.north);
  await waitFor(sessionId, `document.querySelector('[data-testid="astraeum-world"]').dataset.facing === "north" &&
    Number(document.querySelector('[data-testid="astraeum-world"]').dataset.y) < ${start.y - 2}`);
  const afterNorth = await evaluate(sessionId, `(() => {
    const canvas = document.querySelector('[data-testid="astraeum-world"]');
    return { x: Number(canvas.dataset.x), y: Number(canvas.dataset.y) };
  })()`);
  assert.equal(afterNorth.x, afterEast.x, "latest directional key wins instead of diagonal movement");
  await key(sessionId, "keyUp", ...directions.north);
  await waitFor(sessionId, `document.querySelector('[data-testid="astraeum-world"]').dataset.facing === "east"`);
  await key(sessionId, "keyUp", ...directions.east);
  const animationFrame = await evaluate(sessionId,
    `Number(document.querySelector('[data-testid="astraeum-world"]').dataset.frame)`);
  await cdp("Page.reload", {}, sessionId);
  await waitFor(sessionId,
    `document.querySelector("#preview-status")?.textContent.includes("Aries is ready") &&
    Number(document.querySelector('[data-testid="astraeum-world"]').dataset.x) === ${start.x} &&
    Number(document.querySelector('[data-testid="astraeum-world"]').dataset.y) === ${start.y}`);

  const doorwayTurns = await navigateByOriginalCollision(sessionId, { x: 144, y: 88 });
  await navigateByOriginalCollision(sessionId, { x: 144, y: 152 });

  const exit = { x: 33 * 32 + 16, y: 19 * 32 + 24 };
  let passedPreviouslyBlockedCorner = false;
  const traversalTurns = await navigateByOriginalCollision(sessionId, exit, ({ from, to, direction }) => {
    if (direction === "east" && from.x <= 664 && to.x > 664 &&
        Math.abs(from.y - 412) < 2 && Math.abs(to.y - 412) < 2) {
      passedPreviouslyBlockedCorner = true;
    }
  });
  assert.ok(passedPreviouslyBlockedCorner,
    "Aries traverses the corner that was blocked by the old feet-anchored circle");
  const atExit = await evaluate(sessionId, `(() => {
    const canvas = document.querySelector('[data-testid="astraeum-world"]');
    return {
      x: Number(canvas.dataset.x),
      y: Number(canvas.dataset.y),
      cameraX: Number(canvas.dataset.cameraX),
      cameraY: Number(canvas.dataset.cameraY),
      worldWidth: Number(canvas.dataset.worldWidth),
      worldHeight: Number(canvas.dataset.worldHeight),
      viewportWidth: Number(canvas.dataset.viewportWidth),
      viewportHeight: Number(canvas.dataset.viewportHeight),
      playerScreenX: Number(canvas.dataset.playerScreenX),
      playerScreenY: Number(canvas.dataset.playerScreenY),
      lightScreenX: Number(canvas.dataset.lightingScreenX),
      lightScreenY: Number(canvas.dataset.lightingScreenY)
    };
  })()`);
  assert.equal(atExit.cameraX, atExit.worldWidth - atExit.viewportWidth,
    "the camera clamps to the map's right edge after scrolling with Aries");
  assert.equal(atExit.cameraY, atExit.worldHeight - atExit.viewportHeight,
    "the camera clamps to the map's bottom edge after scrolling with Aries");
  assert.equal(atExit.playerScreenX, atExit.x - atExit.cameraX,
    "the visible player position shares the world camera transform");
  assert.equal(atExit.playerScreenY, atExit.y - atExit.cameraY,
    "the visible player position shares the world camera transform vertically");
  assert.equal(atExit.lightScreenX, atExit.playerScreenX,
    "the player light remains horizontally aligned after camera scrolling");
  assert.equal(atExit.lightScreenY, atExit.playerScreenY - 20,
    "the player light retains its offset after camera scrolling");
  await key(sessionId, "keyDown", "KeyD", "d");
  await new Promise(resolve => setTimeout(resolve, 600));
  const blockedAtEdge = await evaluate(sessionId,
    `Number(document.querySelector('[data-testid="astraeum-world"]').dataset.x)`);
  await new Promise(resolve => setTimeout(resolve, 250));
  const afterWall = await evaluate(sessionId,
    `Number(document.querySelector('[data-testid="astraeum-world"]').dataset.x)`);
  await key(sessionId, "keyUp", "KeyD", "d");
  assert.ok(blockedAtEdge > atExit.x, "movement reaches the wall from inside the exit room");
  assert.equal(afterWall, blockedAtEdge, "continued input cannot move through the outer wall");
  await key(sessionId, "keyDown", "KeyD", "d");
  await key(sessionId, "keyDown", "KeyW", "w");
  await waitFor(sessionId,
    `Number(document.querySelector('[data-testid="astraeum-world"]').dataset.y) < ${atExit.y - 2}`);
  const wallSlide = await evaluate(sessionId, `(() => {
    const canvas = document.querySelector('[data-testid="astraeum-world"]');
    return { x: Number(canvas.dataset.x), y: Number(canvas.dataset.y) };
  })()`);
  assert.equal(wallSlide.x, blockedAtEdge, "movement slides along the wall without crossing it");
  await key(sessionId, "keyUp", "KeyW", "w");
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(await evaluate(sessionId,
    `Number(document.querySelector('[data-testid="astraeum-world"]').dataset.x)`),
  blockedAtEdge, "resuming eastward input remains blocked by the same wall");
  await key(sessionId, "keyUp", "KeyD", "d");

  assert.ok(animationFrame > 0, "walking selects a frame from Aries's directional sheet");
  assert.deepEqual(exceptions, [], "the browser reports no uncaught exceptions");
  console.log(`Floor 1 traversal passed: doorway (${doorwayTurns} turns), ${traversalTurns} turns to exit, ` +
    `diagonal key-priority behavior, impassable edge; ${map.collisionRectangles} public wall rectangles, ` +
    `4 px public circle inside the original 18x8 px footprint, ` +
    `Aries animation frame ${animationFrame} and crisp pixels.`);
} finally {
  if (targetId) await cdp("Target.closeTarget", { targetId }).catch(() => {});
  socket.close();
}
