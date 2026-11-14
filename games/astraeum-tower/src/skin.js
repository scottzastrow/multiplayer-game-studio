import { floor1Grid, floor1Map } from "./map.js";
import { drawWorldLighting } from "./lighting/world-lighting.js";
import {
  createTowerLightingSettings,
  TOWER_AMBIENT_COLOR,
  TOWER_PLAYER_LIGHT_OFFSET_Y,
  towerLightingSettings
} from "./lighting/tower-lighting.js";

const CELL = 32;
const WALL_FACE_PX = 12;
const TILE_INDEX = Object.freeze({
  "0010": 0, "0101": 1, "1011": 2, "0011": 3,
  "1001": 4, "0111": 5, "1111": 6, "1110": 7,
  "0100": 8, "1100": 9, "1101": 10, "1010": 11,
  "0000": 12, "0001": 13, "0110": 14, "1000": 15
});
const SPRITES = Object.freeze({
  north: { id: "ariesN", frameWidth: 80, anchorX: 39, anchorY: 65 },
  south: { id: "ariesS", frameWidth: 96, anchorX: 48, anchorY: 75 },
  west: { id: "ariesW", frameWidth: 96, anchorX: 48, anchorY: 75 },
  east: { id: "ariesE", frameWidth: 96, anchorX: 45, anchorY: 75 }
});
const IDLE = { id: "ariesIdle", frameWidth: 64, anchorX: 31, anchorY: 59 };
const ARTWORK_URLS = Object.freeze({
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
  pots: new URL("../assets/pots.png", import.meta.url)
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

function isWall(x, y) {
  return x < 0 || y < 0 || y >= floor1Grid.length ||
    x >= floor1Grid[0].length || floor1Grid[y][x] === "#";
}

function findDeadEnds() {
  const found = [];
  const seen = new Set();
  const width = (x, y, px, py) => {
    let count = 1;
    for (let step = 1; step < 4 && !isWall(x + px * step, y + py * step); step += 1) count += 1;
    for (let step = 1; step < 4 && !isWall(x - px * step, y - py * step); step += 1) count += 1;
    return count;
  };
  for (let y = 1; y < floor1Grid.length - 1; y += 1) {
    for (let x = 1; x < floor1Grid[0].length - 1; x += 1) {
      if (isWall(x, y)) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (!isWall(x + dx, y + dy)) continue;
        const px = dy;
        const py = dx;
        let valid = true;
        for (let back = 0; back < 3 && valid; back += 1) {
          const cx = x - dx * back;
          const cy = y - dy * back;
          if (isWall(cx, cy) || width(cx, cy, px, py) > 2) valid = false;
        }
        if (!valid) continue;
        const key = `${x + (isWall(x - px, y - py) ? 0 : -px)},` +
          `${y + (isWall(x - px, y - py) ? 0 : -py)},${dx},${dy}`;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push([x, y]);
      }
    }
  }
  return found;
}

function fixedDecorations(artwork) {
  const start = floor1Map.spawns.find(spawn => spawn.kind === "player").position;
  const startTile = { x: Math.floor(start.x / CELL), y: Math.floor(start.y / CELL) };
  let y = startTile.y;
  while (y > 0 && !isWall(startTile.x, y - 1)) y -= 1;
  const door = y > 0 && isWall(startTile.x - 1, y - 1) && isWall(startTile.x + 1, y - 1)
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
    const cell = floor1Grid[y]?.[x];
    return cell !== undefined && cell !== "." && cell !== "#";
  };
  const noCandle = new Set();
  for (const [x, y] of findDeadEnds()) {
    for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      noCandle.add((y + dy) * floor1Grid[0].length + x + dx);
    }
  }
  const candles = [];
  const webs = [];
  const candleAllowed = (x, y) => !noCandle.has(Math.floor(y / CELL) * floor1Grid[0].length +
    Math.floor(x / CELL)) &&
    !floor1Grid.some((row, cy) => [...row].some((cell, cx) => cell === "C" &&
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
  for (let ty = 1; ty < floor1Grid.length - 1; ty += 1) {
    for (let tx = 1; tx < floor1Grid[0].length - 1; tx += 1) {
      if (isWall(tx, ty) || busy(tx, ty)) continue;
      const up = isWall(tx, ty - 1);
      const down = isWall(tx, ty + 1);
      const left = isWall(tx - 1, ty);
      const right = isWall(tx + 1, ty);
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

function drawTerrain(context, artwork) {
  context.fillStyle = "#0b0910";
  context.fillRect(0, 0, floor1Map.bounds.width, floor1Map.bounds.height);
  for (let y = -1; y < floor1Grid.length; y += 1) {
    for (let x = -1; x < floor1Grid[0].length; x += 1) {
      const floor = (tx, ty) => isWall(tx, ty) ? "0" : "1";
      const tile = TILE_INDEX[
        floor(x, y) + floor(x + 1, y) + floor(x, y + 1) + floor(x + 1, y + 1)
      ];
      context.drawImage(
        artwork.wang,
        (tile % 4) * CELL, Math.floor(tile / 4) * CELL, CELL, CELL,
        x * CELL + CELL / 2, y * CELL + CELL / 2, CELL, CELL
      );
    }
  }
}

function drawProps(context, artwork) {
  const images = { B: artwork.barrel, X: artwork.crate, o: artwork.pots };
  for (let y = 0; y < floor1Grid.length; y += 1) {
    for (let x = 0; x < floor1Grid[y].length; x += 1) {
      const image = images[floor1Grid[y][x]];
      if (image) {
        const px = x * CELL + CELL / 2;
        const py = y * CELL + 24;
        context.drawImage(image, Math.round(px - image.width / 2), Math.round(py - image.height + 2));
      }
    }
  }
  const decor = fixedDecorations(artwork);
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
  return decor.candles.map(candle => candle.light);
}

function directionFor(keys) {
  return [...keys.values()].sort((left, right) => right.order - left.order)[0]?.direction ?? null;
}

function cameraOffset(player, width, height) {
  const axis = (position, viewSize, worldSize) => viewSize >= worldSize
    ? (worldSize - viewSize) / 2
    : Math.max(0, Math.min(worldSize - viewSize, position - viewSize / 2));
  return {
    x: axis(player.x, width, floor1Map.bounds.width),
    y: axis(player.y, height, floor1Map.bounds.height)
  };
}

function drawPlayer(context, artwork, player) {
  if (!player) return;
  if (!player.moving) {
    const idle = artwork[IDLE.id];
    context.drawImage(idle, 0, 0, IDLE.frameWidth, IDLE.frameWidth,
      Math.round(player.x - IDLE.anchorX), Math.round(player.y - IDLE.anchorY),
      IDLE.frameWidth, IDLE.frameWidth);
    return;
  }
  const sprite = SPRITES[player.facing];
  const image = artwork[sprite.id];
  const frameCount = Math.max(1, Math.floor(image.naturalWidth / sprite.frameWidth));
  const frame = player.frame % frameCount;
  context.drawImage(image, frame * sprite.frameWidth, 0, sprite.frameWidth, sprite.frameWidth,
    Math.round(player.x - sprite.anchorX), Math.round(player.y - sprite.anchorY),
    sprite.frameWidth, sprite.frameWidth);
}

function createLightingControls(container, initialSettings, updateSettings) {
  const fieldset = document.createElement("fieldset");
  fieldset.dataset.testid = "astraeum-lighting-controls";
  fieldset.style.cssText = "display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;margin:0;padding:8px 12px;border:1px solid #625477;border-radius:8px;color:#eee8f5";
  const legend = document.createElement("legend");
  legend.textContent = "World lighting";
  fieldset.append(legend);

  const ranges = [
    { key: "ambientBrightness", label: "Ambient brightness", min: 0, max: 1, step: 0.01 },
    { key: "playerLightRadius", label: "Player-light radius", min: 1, max: 1000, step: 1 },
    { key: "playerLightIntensity", label: "Player-light intensity", min: 0, max: 1, step: 0.01 },
    { key: "playerLightSoftness", label: "Player-light softness", min: 0.01, max: 0.99, step: 0.01 }
  ];
  for (const range of ranges) {
    const label = document.createElement("label");
    label.style.cssText = "display:grid;gap:4px;min-width:160px;font-size:12px";
    label.textContent = range.label;
    const input = document.createElement("input");
    input.type = "range";
    input.dataset.setting = range.key;
    input.min = String(range.min);
    input.max = String(range.max);
    input.step = String(range.step);
    input.value = String(initialSettings[range.key]);
    input.setAttribute("aria-label", range.label);
    const output = document.createElement("output");
    output.dataset.valueFor = range.key;
    output.textContent = input.value;
    input.addEventListener("input", () => {
      const value = Number(input.value);
      updateSettings({ [range.key]: value });
      output.textContent = input.value;
    });
    label.append(input, output);
    fieldset.append(label);
  }
  const fullyLitLabel = document.createElement("label");
  fullyLitLabel.style.cssText = "display:flex;gap:8px;align-items:center;font-size:12px";
  const fullyLit = document.createElement("input");
  fullyLit.type = "checkbox";
  fullyLit.dataset.setting = "fullyLit";
  fullyLit.checked = initialSettings.fullyLit;
  fullyLit.setAttribute("aria-label", "Fully lit");
  fullyLit.addEventListener("change", () => updateSettings({ fullyLit: fullyLit.checked }));
  fullyLitLabel.append(fullyLit, document.createTextNode("Fully lit"));
  fieldset.append(fullyLitLabel);
  container.append(fieldset);
  return fieldset;
}

function flickeringCandleLights(candles, time) {
  const candlesAtTime = candles.map(candle => {
    const flicker = Math.sin(time * 0.25 + candle.phase) * 1.2 +
      Math.sin(time * 0.61 + candle.phase) * 0.8;
    return {
      ...candle,
      radius: candle.radius + flicker * 6,
      softness: 0.55,
      intensity: 1,
      glowRadius: 10 + flicker,
      glowIntensity: 0.55,
      glowColor: "#ffc86e",
      glowEndColor: "#ffa03c"
    };
  });
  const stairs = [];
  for (let y = 0; y < floor1Grid.length; y += 1) {
    for (let x = 0; x < floor1Grid[y].length; x += 1) {
      if (floor1Grid[y][x] === ">") {
        stairs.push({
          x: x * CELL + 16,
          y: y * CELL + 24,
          radius: 70,
          color: "#a070ff",
          softness: 0.55,
          intensity: 0.35
        });
      }
    }
  }
  return [...candlesAtTime, ...stairs];
}

export function towerSkinFactory(artwork, lightingOptions = towerLightingSettings) {
  const initialLightingSettings = createTowerLightingSettings(lightingOptions);
  return Object.freeze({
    metadata: Object.freeze({
      id: "astraeum-tower-floor-one-skin",
      version: "1.0.0",
      acceptedModuleId: "astraeum-tower-floor-one",
      acceptedStateSchemaVersions: Object.freeze([1])
    }),

    mount(host) {
      const worldSlot = host.slots.get("world");
      const hudSlot = host.slots.get("hud");
      const controlsSlot = host.slots.get("controls");
      if (!worldSlot || !hudSlot || !controlsSlot) {
        throw new Error("The Tower skin requires world, hud and controls slots.");
      }

      const world = document.createElement("section");
      const canvas = document.createElement("canvas");
      canvas.dataset.testid = "astraeum-world";
      canvas.dataset.mapWidth = String(floor1Grid[0].length);
      canvas.dataset.mapHeight = String(floor1Grid.length);
      canvas.dataset.cellSize = String(CELL);
      canvas.dataset.worldWidth = String(floor1Map.bounds.width);
      canvas.dataset.worldHeight = String(floor1Map.bounds.height);
      canvas.dataset.collisionRectangles = String(floor1Map.collisions.length);
      canvas.setAttribute("role", "img");
      canvas.setAttribute("aria-label", "Astraeum Tower Floor 1: Damp Corridors");
      canvas.tabIndex = 0;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("Canvas 2D rendering is unavailable.");
      context.imageSmoothingEnabled = false;
      const background = document.createElement("canvas");
      background.width = floor1Map.bounds.width;
      background.height = floor1Map.bounds.height;
      const backgroundContext = background.getContext("2d", { alpha: false });
      if (!backgroundContext) throw new Error("Canvas 2D background rendering is unavailable.");
      backgroundContext.imageSmoothingEnabled = false;
      drawTerrain(backgroundContext, artwork);
      const candles = drawProps(backgroundContext, artwork);

      const position = document.createElement("output");
      position.dataset.testid = "astraeum-position";
      const hud = document.createElement("output");
      hud.dataset.testid = "astraeum-hud";
      hud.textContent = "Aries · 2 px/frame at 60 fps · Wall collision enabled";
      const help = document.createElement("p");
      help.textContent = "Move: arrows or WASD. Combat, loot, chests and floor completion are not implemented.";
      controlsSlot.append(help);
      let lightingSettings = initialLightingSettings;
      const lightingControls = createLightingControls(controlsSlot, lightingSettings, patch => {
        lightingSettings = createTowerLightingSettings({ ...lightingSettings, ...patch });
        canvas.dataset.ambientBrightness = String(lightingSettings.ambientBrightness);
        canvas.dataset.playerLightRadius = String(lightingSettings.playerLightRadius);
        canvas.dataset.playerLightIntensity = String(lightingSettings.playerLightIntensity);
        canvas.dataset.playerLightSoftness = String(lightingSettings.playerLightSoftness);
        canvas.dataset.fullyLit = String(lightingSettings.fullyLit);
      });
      world.append(canvas);
      worldSlot.append(world);
      hudSlot.append(hud, position);

      const listener = new AbortController();
      const keys = new Map();
      let keyOrder = 0;
      let current;
      let disposed = false;
      let viewportWidth = 1;
      let viewportHeight = 1;
      let pixelRatio = 1;
      const bindings = new Map([
        ["ArrowUp", "north"], ["KeyW", "north"],
        ["ArrowDown", "south"], ["KeyS", "south"],
        ["ArrowLeft", "west"], ["KeyA", "west"],
        ["ArrowRight", "east"], ["KeyD", "east"]
      ]);
      const sendInput = () => host.dispatchInput({
        type: "move",
        direction: directionFor(keys)
      });
      const neutral = () => {
        keys.clear();
        sendInput();
      };
      canvas.addEventListener("keydown", event => {
        const direction = bindings.get(event.code);
        if (!direction) return;
        event.preventDefault();
        if (!keys.has(event.code)) keys.set(event.code, { direction, order: ++keyOrder });
        sendInput();
      }, { signal: listener.signal });
      window.addEventListener("keyup", event => {
        if (!bindings.has(event.code)) return;
        keys.delete(event.code);
        sendInput();
      }, { signal: listener.signal });
      canvas.addEventListener("blur", neutral, { signal: listener.signal });
      window.addEventListener("blur", neutral, { signal: listener.signal });
      document.addEventListener("visibilitychange", () => {
        if (document.hidden) neutral();
      }, { signal: listener.signal });
      canvas.addEventListener("pointerdown", () => canvas.focus(), { signal: listener.signal });
      canvas.style.imageRendering = "pixelated";
      canvas.focus();

      return {
        handleSnapshot(snapshot) {
          if (!disposed) current = snapshot;
        },
        handleEvents() {},
        render() {
          if (disposed || !current?.player) return;
          const player = current.player;
          const camera = cameraOffset(player, viewportWidth, viewportHeight);
          context.clearRect(0, 0, canvas.width, canvas.height);
          context.imageSmoothingEnabled = false;
          context.save();
          context.translate(-camera.x, -camera.y);
          context.drawImage(background, 0, 0);
          drawPlayer(context, artwork, player);
          context.restore();
          const cameraAnchor = host.cameraAnchor ?? player;
          const playerLight = {
            x: cameraAnchor.x,
            y: cameraAnchor.y + TOWER_PLAYER_LIGHT_OFFSET_Y
          };
          canvas.dataset.lightingCenterX = String(playerLight.x);
          canvas.dataset.lightingCenterY = String(playerLight.y);
          canvas.dataset.cameraX = String(camera.x);
          canvas.dataset.cameraY = String(camera.y);
          canvas.dataset.playerScreenX = String(player.x - camera.x);
          canvas.dataset.playerScreenY = String(player.y - camera.y);
          canvas.dataset.lightingScreenX = String(playerLight.x - camera.x);
          canvas.dataset.lightingScreenY = String(playerLight.y - camera.y);
          const time = performance.now() / (1000 / 60);
          drawWorldLighting(
            context,
            playerLight,
            flickeringCandleLights(candles, time),
            lightingSettings,
            {
              cameraX: camera.x,
              cameraY: camera.y,
              scaleX: 1,
              scaleY: 1,
              ambientColor: TOWER_AMBIENT_COLOR,
              pixelRatio
            }
          );
          canvas.dataset.x = String(player.x);
          canvas.dataset.y = String(player.y);
          canvas.dataset.facing = player.facing;
          canvas.dataset.frame = String(player.frame);
          canvas.dataset.smoothing = String(context.imageSmoothingEnabled);
          canvas.dataset.ambientBrightness = String(lightingSettings.ambientBrightness);
          canvas.dataset.playerLightRadius = String(lightingSettings.playerLightRadius);
          canvas.dataset.playerLightIntensity = String(lightingSettings.playerLightIntensity);
          canvas.dataset.playerLightSoftness = String(lightingSettings.playerLightSoftness);
          canvas.dataset.fullyLit = String(lightingSettings.fullyLit);
          position.textContent = `Aries position: ${player.x.toFixed(1)}, ${player.y.toFixed(1)}`;
        },
        handleViewport(width, height, devicePixelRatio) {
          viewportWidth = Math.max(1, Math.floor(width));
          viewportHeight = Math.max(1, Math.floor(height));
          pixelRatio = Math.max(1, devicePixelRatio);
          canvas.dataset.viewportWidth = String(viewportWidth);
          canvas.dataset.viewportHeight = String(viewportHeight);
          canvas.dataset.viewportDevicePixelRatio = String(pixelRatio);
          canvas.width = Math.max(1, Math.round(viewportWidth * pixelRatio));
          canvas.height = Math.max(1, Math.round(viewportHeight * pixelRatio));
          canvas.style.width = `${viewportWidth}px`;
          canvas.style.height = `${viewportHeight}px`;
          context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
          context.imageSmoothingEnabled = false;
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          neutral();
          listener.abort();
          world.remove();
          help.remove();
          lightingControls.remove();
          hud.remove();
          current = undefined;
        }
      };
    }
  });
}
