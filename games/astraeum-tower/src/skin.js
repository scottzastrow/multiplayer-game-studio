import { drawWorldLighting } from "./lighting/world-lighting.js";
import {
  createTowerLightingSettings,
  TOWER_AMBIENT_COLOR,
  TOWER_PLAYER_LIGHT_OFFSET_Y,
  towerLightingSettings
} from "./lighting/tower-lighting.js";
import {
  DEFAULT_FLOOR_DOCUMENT,
  createFloorMap,
  floorDocumentGrid,
  objectLights,
  validateFloorDocument
} from "./project.js";
import { drawDesign, loadArtwork } from "./design-render.js";

export { loadArtwork };

const CELL = 32;
const SPRITES = Object.freeze({
  north: { id: "ariesN", frameWidth: 80, anchorX: 39, anchorY: 65 },
  south: { id: "ariesS", frameWidth: 96, anchorX: 48, anchorY: 75 },
  west: { id: "ariesW", frameWidth: 96, anchorX: 48, anchorY: 75 },
  east: { id: "ariesE", frameWidth: 96, anchorX: 45, anchorY: 75 }
});
const IDLE = { id: "ariesIdle", frameWidth: 64, anchorX: 31, anchorY: 59 };
function directionFor(keys) {
  return [...keys.values()].sort((left, right) => right.order - left.order)[0]?.direction ?? null;
}

function cameraOffset(player, width, height, map) {
  const axis = (position, viewSize, worldSize) => viewSize >= worldSize
    ? (worldSize - viewSize) / 2
    : Math.max(0, Math.min(worldSize - viewSize, position - viewSize / 2));
  return {
    x: axis(player.x, width, map.bounds.width),
    y: axis(player.y, height, map.bounds.height)
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

function flickerCandle(candle, time) {
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
}

function flickeringCandleLights(candles, time, placedLights) {
  const candlesAtTime = candles.map(candle => flickerCandle(candle, time));
  const stairs = [];
  for (const light of placedLights) {
    const { id, steady, ...base } = light;
    if (steady) {
      stairs.push({ x: base.x, y: base.y, radius: base.radius, color: base.color,
        softness: 0.55, intensity: 0.35 });
    } else {
      candlesAtTime.push(flickerCandle({ x: base.x, y: base.y, radius: base.radius,
        color: base.color, phase: base.phase }, time));
    }
  }
  return [...candlesAtTime, ...stairs];
}

export function towerSkinFactory(
  artwork,
  lightingOptions = towerLightingSettings,
  project = DEFAULT_FLOOR_DOCUMENT
) {
  const initialLightingSettings = createTowerLightingSettings(lightingOptions);
  const design = validateFloorDocument(project);
  const grid = floorDocumentGrid(design);
  const map = createFloorMap(design);
  const placedLights = objectLights(design);
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
      canvas.dataset.mapWidth = String(grid[0].length);
      canvas.dataset.mapHeight = String(grid.length);
      canvas.dataset.cellSize = String(CELL);
      canvas.dataset.worldWidth = String(map.bounds.width);
      canvas.dataset.worldHeight = String(map.bounds.height);
      canvas.dataset.collisionRectangles = String(map.collisions.length);
      canvas.setAttribute("role", "img");
      canvas.setAttribute("aria-label", "Astraeum Tower Floor 1: Damp Corridors");
      canvas.tabIndex = 0;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("Canvas 2D rendering is unavailable.");
      context.imageSmoothingEnabled = false;
      const background = document.createElement("canvas");
      background.width = map.bounds.width;
      background.height = map.bounds.height;
      const backgroundContext = background.getContext("2d", { alpha: false });
      if (!backgroundContext) throw new Error("Canvas 2D background rendering is unavailable.");
      backgroundContext.imageSmoothingEnabled = false;
      const candles = drawDesign(backgroundContext, artwork, design, { grid, map, mode: "play" });

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
          const camera = cameraOffset(player, viewportWidth, viewportHeight, map);
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
            flickeringCandleLights(candles, time, placedLights),
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
