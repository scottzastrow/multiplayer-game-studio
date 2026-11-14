import { drawWorldLighting } from "./lighting/world-lighting.js";
import {
  createTowerLightingSettings,
  TOWER_AMBIENT_COLOR,
  TOWER_PLAYER_LIGHT_OFFSET_Y,
  towerLightingSettings
} from "./lighting/tower-lighting.js";
import {
  ASSET_CATALOG,
  DEFAULT_FLOOR_DOCUMENT,
  createFloorMap,
  floorDocumentGrid,
  objectLights,
  validateFloorDocument
} from "./project.js";
import { readStandardGamepad } from "@multiplayer-game/theme-sdk";
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
const CONTROL_MODES = Object.freeze({
  keyboardOnly: "keyboard-only",
  keyboardMouse: "keyboard-mouse",
  gameController: "game-controller"
});

function keyboardDirection(code) {
  switch (code) {
    case "ArrowUp":
    case "KeyW": return { x: 0, y: -1 };
    case "ArrowDown":
    case "KeyS": return { x: 0, y: 1 };
    case "ArrowLeft":
    case "KeyA": return { x: -1, y: 0 };
    case "ArrowRight":
    case "KeyD": return { x: 1, y: 0 };
    default: return null;
  }
}

function normalizedVector(x, y) {
  const magnitude = Math.hypot(x, y);
  return magnitude ? { x: x / magnitude, y: y / magnitude } : null;
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

function drawSlime(context, slime) {
  const feetY = Math.round(slime.y);
  const x = Math.round(slime.x);
  const centerY = feetY - 13;
  context.save();
  context.fillStyle = "rgba(0,0,0,0.38)";
  context.beginPath();
  context.ellipse(x, feetY, 12, 4, 0, 0, Math.PI * 2);
  context.fill();

  context.beginPath();
  context.moveTo(x - 15, feetY - 1);
  context.quadraticCurveTo(x - 17, feetY - 6, x - 12, feetY - 17);
  context.quadraticCurveTo(x - 8, feetY - 27, x, feetY - 27);
  context.quadraticCurveTo(x + 10, feetY - 27, x + 14, feetY - 16);
  context.quadraticCurveTo(x + 18, feetY - 5, x + 15, feetY - 1);
  context.closePath();
  context.fillStyle = slime.flashFrames > 0 ? "#ffffff" : "#5fc85a";
  context.fill();
  context.strokeStyle = "#3a9440";
  context.lineWidth = 2;
  context.stroke();

  context.fillStyle = "#a6ee82";
  context.beginPath();
  context.ellipse(x - 5, centerY - 7, 3, 1.8, -0.3, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#1a1022";
  context.beginPath();
  context.ellipse(x - 5, centerY + 1, 1.4, 2.2, 0, 0, Math.PI * 2);
  context.ellipse(x + 5, centerY + 1, 1.4, 2.2, 0, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#ffffff";
  context.fillRect(x - 6, centerY, 1, 1);
  context.fillRect(x + 4, centerY, 1, 1);

  if (slime.hp < slime.maxHp) {
    const width = 26;
    const top = feetY - 34;
    context.fillStyle = "rgba(0,0,0,0.72)";
    context.fillRect(x - width / 2 - 1, top - 1, width + 2, 5);
    context.fillStyle = "#e2445c";
    context.fillRect(x - width / 2, top, Math.round(width * slime.hp / slime.maxHp), 3);
  }
  context.restore();
}

function drawWeaponAttack(context, player) {
  if (!player.attack) return;
  const { angle, frame } = player.attack;
  const originX = player.x;
  const originY = player.y - 20;
  context.save();
  context.globalCompositeOperation = "lighter";
  context.lineCap = "round";
  if (frame <= 9) {
    const progress = frame / 9;
    const extension = (progress < 0.4
      ? progress / 0.4
      : 1 - (progress - 0.4) / 0.6 * 0.5) * 56;
    const tipX = originX + Math.cos(angle) * extension;
    const tipY = originY + Math.sin(angle) * extension;
    context.strokeStyle = `rgba(255,170,110,${(1 - progress) * 0.45})`;
    context.lineWidth = 6;
    context.beginPath();
    context.moveTo(originX + Math.cos(angle) * 10, originY + Math.sin(angle) * 10);
    context.lineTo(tipX, tipY);
    context.stroke();
    context.strokeStyle = `rgba(255,255,255,${(1 - progress) * 0.95})`;
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(originX + Math.cos(angle) * 10, originY + Math.sin(angle) * 10);
    context.lineTo(tipX, tipY);
    context.stroke();
    context.fillStyle = `rgba(255,255,255,${1 - progress})`;
    context.beginPath();
    context.moveTo(tipX + Math.cos(angle) * 3, tipY + Math.sin(angle) * 3);
    context.lineTo(tipX - Math.cos(angle) * 3 + Math.cos(angle + Math.PI / 2) * 2.5,
      tipY - Math.sin(angle) * 3 + Math.sin(angle + Math.PI / 2) * 2.5);
    context.lineTo(tipX - Math.cos(angle) * 3 - Math.cos(angle + Math.PI / 2) * 2.5,
      tipY - Math.sin(angle) * 3 - Math.sin(angle + Math.PI / 2) * 2.5);
    context.closePath();
    context.fill();
  }
  if (frame >= 9 && frame <= 21) {
    const sweepFrame = frame - 8;
    const fade = 1 - sweepFrame / 13;
    const sweep = Math.min(1, sweepFrame / 4);
    const startAngle = angle - 2.3 / 2;
    const endAngle = startAngle + 2.3 * sweep;
    const lowAngle = Math.min(startAngle, endAngle);
    const highAngle = Math.max(startAngle, endAngle);
    context.strokeStyle = `rgba(255,255,255,${fade * 0.9})`;
    context.lineWidth = 7;
    context.beginPath();
    context.arc(originX, originY, 50, lowAngle, highAngle);
    context.stroke();
    context.strokeStyle = `rgba(255,170,110,${fade * 0.58})`;
    context.lineWidth = 5.4;
    context.beginPath();
    context.arc(originX, originY, 43.7, lowAngle, highAngle);
    context.stroke();
    context.strokeStyle = `rgba(255,170,110,${fade * 0.36})`;
    context.lineWidth = 3.8;
    context.beginPath();
    context.arc(originX, originY, 37.4, lowAngle, highAngle);
    context.stroke();
    context.fillStyle = `rgba(255,170,110,${fade * 0.18})`;
    context.beginPath();
    context.moveTo(originX, originY);
    context.arc(originX, originY, 50, lowAngle, highAngle);
    context.closePath();
    context.fill();

    if (sweep < 1) {
      const tipX = originX + Math.cos(endAngle) * 50;
      const tipY = originY + Math.sin(endAngle) * 50;
      context.save();
      context.translate(tipX, tipY);
      context.rotate(endAngle + Math.PI / 2);
      context.fillStyle = `rgba(255,240,220,${fade})`;
      context.beginPath();
      context.moveTo(-8, -2);
      context.quadraticCurveTo(0, -11, 8, -2);
      context.lineTo(0, 2);
      context.closePath();
      context.fill();
      context.restore();
    }
  }
  context.restore();
}

function drawEffects(context, effects = []) {
  for (const effect of effects) {
    const opacity = Math.max(0, effect.life / effect.maxLife);
    context.save();
    context.globalAlpha = opacity;
    if (effect.kind === "text") {
      context.font = "bold 12px monospace";
      context.textAlign = "center";
      context.fillStyle = effect.color;
      context.fillText(effect.value, Math.round(effect.x), Math.round(effect.y));
    } else {
      context.fillStyle = effect.color;
      context.fillRect(Math.round(effect.x), Math.round(effect.y),
        effect.size, effect.size);
    }
    context.restore();
  }
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
  project = DEFAULT_FLOOR_DOCUMENT,
  assetCatalog = ASSET_CATALOG,
  preferredControlMode = CONTROL_MODES.keyboardMouse
) {
  const initialLightingSettings = createTowerLightingSettings(lightingOptions);
  const design = validateFloorDocument(project, assetCatalog);
  const grid = floorDocumentGrid(design, assetCatalog);
  const map = createFloorMap(design, assetCatalog);
  const placedLights = objectLights(design, assetCatalog);
  return Object.freeze({
    metadata: Object.freeze({
      id: "astraeum-tower-floor-one-skin",
      version: "1.1.0",
      acceptedModuleId: "astraeum-tower-floor-one",
      acceptedStateSchemaVersions: Object.freeze([1, 2, 3])
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
      canvas.dataset.importedAssetIds = JSON.stringify(design.objects
        .filter(object => assetCatalog[object.assetId].imported).map(object => object.assetId));
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
      const candles = drawDesign(backgroundContext, artwork, design, { grid, map, mode: "play", assetCatalog });

      const position = document.createElement("output");
      position.dataset.testid = "astraeum-position";
      const hud = document.createElement("output");
      hud.dataset.testid = "astraeum-hud";
      hud.textContent = "Aries · 2 px/frame at 60 fps · Wall collision enabled";
      let controlMode = Object.values(CONTROL_MODES).includes(preferredControlMode)
        ? preferredControlMode : CONTROL_MODES.keyboardMouse;
      const help = document.createElement("p");
      help.dataset.testid = "astraeum-controls";
      const controllerStatus = document.createElement("output");
      controllerStatus.dataset.testid = "astraeum-controller-status";
      controllerStatus.setAttribute("role", "status");
      controlsSlot.append(help, controllerStatus);
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
      const keys = new Set();
      const suppressedKeys = new Set();
      let current;
      let disposed = false;
      let attackHeld = false;
      let rightMouseHeld = false;
      let rightMouseNeedsRelease = false;
      let controllerDodgeArmed = false;
      let controllerConnected = false;
      let playerSettingsOpen = false;
      let windowFocused = true;
      let viewportWidth = 1;
      let viewportHeight = 1;
      let pixelRatio = 1;
      let lastControllerStatus = "";
      const sendMovement = (x, y) => host.dispatchInput({ type: "move", x, y });
      const sendAim = vector => {
        if (vector) host.dispatchInput({ type: "aim", x: vector.x, y: vector.y });
      };
      const sendAttack = pressed => {
        attackHeld = pressed;
        host.dispatchInput({ type: "attack", pressed });
      };
      const pulseDodge = vector => {
        host.dispatchInput({ type: "dodge", pressed: true, x: vector.x, y: vector.y });
        host.dispatchInput({ type: "dodge", pressed: false, x: 0, y: 0 });
      };
      const activeKeys = () => [...keys].map(code => keyboardDirection(code)).filter(Boolean);
      const keyboardMovement = () => {
        const movement = activeKeys().reduce((sum, vector) => ({
          x: sum.x + vector.x,
          y: sum.y + vector.y
        }), { x: 0, y: 0 });
        const magnitude = Math.hypot(movement.x, movement.y);
        if (magnitude > 1) return { x: movement.x / magnitude, y: movement.y / magnitude };
        return movement;
      };
      const neutral = () => {
        for (const code of keys) suppressedKeys.add(code);
        keys.clear();
        attackHeld = false;
        rightMouseNeedsRelease ||= rightMouseHeld;
        rightMouseHeld = false;
        controllerDodgeArmed = false;
        controllerConnected = false;
        sendMovement(0, 0);
        host.dispatchInput({ type: "clear" });
      };
      window.addEventListener("studio:player-settings-open", () => {
        playerSettingsOpen = true;
        neutral();
      }, { signal: listener.signal });
      window.addEventListener("studio:player-settings-close", () => {
        playerSettingsOpen = false;
      }, { signal: listener.signal });
      window.addEventListener("studio:player-settings-mode-change", event => {
        if (!Object.values(CONTROL_MODES).includes(event.detail?.mode)) return;
        neutral();
        controlMode = event.detail.mode;
        updateHelp();
      }, { signal: listener.signal });
      canvas.addEventListener("keydown", event => {
        if (event.target !== canvas || disposed || !windowFocused || playerSettingsOpen) return;
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (suppressedKeys.has(event.code)) {
          event.preventDefault();
          return;
        }
        const mode = controlMode;
        const isMoveKey = mode === CONTROL_MODES.keyboardOnly
          ? ["KeyW", "KeyA", "KeyS", "KeyD"].includes(event.code)
          : mode === CONTROL_MODES.keyboardMouse
            ? ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.code)
            : false;
        const isDodgeKey = mode === CONTROL_MODES.keyboardOnly
          ? ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.code)
          : false;
        const isAttackKey = mode === CONTROL_MODES.keyboardOnly
          ? event.code === "Space"
          : false;
        if (!isMoveKey && !isDodgeKey && !isAttackKey) return;
        event.preventDefault();
        if (isMoveKey && !keys.has(event.code)) {
          keys.add(event.code);
          const movement = keyboardMovement();
          sendMovement(movement.x, movement.y);
          if (mode === CONTROL_MODES.keyboardOnly && (movement.x || movement.y)) {
            sendAim(normalizedVector(movement.x, movement.y));
          }
          if (mode === CONTROL_MODES.keyboardMouse) tryKeyboardMouseDodge();
        }
        if (isDodgeKey && !keys.has(event.code)) {
          keys.add(event.code);
          const direction = keyboardDirection(event.code);
          pulseDodge(direction);
        }
        if (isAttackKey && !keys.has(event.code)) {
          keys.add(event.code);
          sendAttack(true);
        }
      }, { signal: listener.signal });
      window.addEventListener("keyup", event => {
        if (suppressedKeys.delete(event.code)) return;
        if (!keys.delete(event.code)) return;
        if (event.code === "Space") sendAttack(false);
        else {
          const movement = keyboardMovement();
          sendMovement(movement.x, movement.y);
          if (controlMode === CONTROL_MODES.keyboardOnly && (movement.x || movement.y)) {
            sendAim(normalizedVector(movement.x, movement.y));
          }
        }
      }, { signal: listener.signal });
      canvas.addEventListener("blur", neutral, { signal: listener.signal });
      window.addEventListener("blur", () => {
        windowFocused = false;
        neutral();
      }, { signal: listener.signal });
      window.addEventListener("focus", () => {
        windowFocused = true;
      }, { signal: listener.signal });
      document.addEventListener("visibilitychange", () => {
        if (document.hidden) neutral();
      }, { signal: listener.signal });
      canvas.addEventListener("pointermove", event => {
        if (playerSettingsOpen || controlMode !== CONTROL_MODES.keyboardMouse || !current ||
            document.activeElement !== canvas) return;
        const player = current.player;
        const rect = canvas.getBoundingClientRect();
        const worldX = event.clientX - rect.left + Number(canvas.dataset.cameraX ?? 0);
        const worldY = event.clientY - rect.top + Number(canvas.dataset.cameraY ?? 0);
        sendAim(normalizedVector(worldX - player.x, worldY - (player.y - 20)));
      }, { signal: listener.signal });
      canvas.addEventListener("pointerdown", event => {
        if (playerSettingsOpen) return;
        canvas.focus({ preventScroll: true });
        if (controlMode !== CONTROL_MODES.keyboardMouse) return;
        if (event.button === 0) sendAttack(true);
        if (event.button === 2) {
          rightMouseHeld = true;
          rightMouseNeedsRelease = false;
          tryKeyboardMouseDodge();
        }
      }, { signal: listener.signal });
      window.addEventListener("pointerup", event => {
        if (event.button === 0 && attackHeld &&
            controlMode === CONTROL_MODES.keyboardMouse) sendAttack(false);
        if (event.button === 2) {
          rightMouseHeld = false;
          rightMouseNeedsRelease = false;
        }
      }, { signal: listener.signal });
      canvas.addEventListener("pointercancel", () => {
        rightMouseHeld = false;
        rightMouseNeedsRelease = true;
        sendAttack(false);
      }, { signal: listener.signal });
      canvas.addEventListener("contextmenu", event => {
        event.preventDefault();
      }, { signal: listener.signal });
      canvas.style.imageRendering = "pixelated";
      canvas.focus();

      function updateHelp() {
        if (controlMode === CONTROL_MODES.keyboardOnly) {
          help.textContent = "Keyboard Only — WASD: Move · Arrow keys: Dodge · Space: Attack.";
        } else if (controlMode === CONTROL_MODES.keyboardMouse) {
          help.textContent = "Keyboard + Mouse — arrows move · pointer aims · left click attacks · hold right mouse + arrow to dodge.";
        } else {
          help.textContent = "Game Controller — left stick moves · right stick aims · RT attacks · hold B/Circle + left-stick direction to dodge.";
        }
      }

      function tryKeyboardMouseDodge() {
        if (!rightMouseHeld || rightMouseNeedsRelease) return;
        const vector = activeKeys().reduce((sum, direction) => ({
          x: sum.x + direction.x,
          y: sum.y + direction.y
        }), { x: 0, y: 0 });
        const direction = normalizedVector(vector.x, vector.y);
        if (!direction) return;
        rightMouseNeedsRelease = true;
        pulseDodge(direction);
      }

      updateHelp();

      return {
        handleSnapshot(snapshot) {
          if (!disposed) current = snapshot;
        },
        handleEvents() {},
        render() {
          if (disposed || !current?.player) return;
          const gamepads = navigator.getGamepads?.() ?? null;
          const input = readStandardGamepad(gamepads);
          const statusKey = `${input.status}:${input.id ?? ""}`;
          if (statusKey !== lastControllerStatus) {
            lastControllerStatus = statusKey;
            window.dispatchEvent(new CustomEvent("studio:player-controller-status", {
              detail: { status: input.status, id: input.id ?? "" }
            }));
          }
          const pad = Array.from(gamepads ?? []).find(candidate =>
            candidate?.connected && candidate.mapping === "standard");
          if (controlMode === CONTROL_MODES.gameController && !playerSettingsOpen &&
              document.activeElement === canvas && windowFocused && !document.hidden) {
            canvas.dataset.controllerMoveX = String(input.status === "connected" ? input.movement.x : 0);
            canvas.dataset.controllerMoveY = String(input.status === "connected" ? input.movement.y : 0);
            controllerStatus.textContent = `Controller ${input.status}${input.id ? `: ${input.id}` : ""}`;
            if (input.status === "connected" && pad) {
              controllerConnected = true;
              sendMovement(input.movement.x, input.movement.y);
              sendAim(input.aim);
              sendAttack(input.fire);
              const dodgeButton = Boolean(pad.buttons[1]?.pressed || (pad.buttons[1]?.value ?? 0) >= 0.5);
              if (!dodgeButton) controllerDodgeArmed = true;
              else if (controllerDodgeArmed &&
                  Math.hypot(input.movement.x, input.movement.y) > 0) {
                controllerDodgeArmed = false;
                pulseDodge(input.movement);
              }
            } else if (controllerConnected) {
              controllerConnected = false;
              neutral();
              controllerStatus.textContent = `Controller ${input.status}`;
            }
          } else {
            canvas.dataset.controllerMoveX = "0";
            canvas.dataset.controllerMoveY = "0";
            controllerStatus.textContent = `Controller ${input.status}${input.id ? `: ${input.id}` : ""}`;
          }
          const player = current.player;
          const players = current.players ?? [player];
          const enemies = current.enemies ?? [];
          canvas.dataset.simulationTick = String(current.tick);
          const camera = cameraOffset(player, viewportWidth, viewportHeight, map);
          context.clearRect(0, 0, canvas.width, canvas.height);
          context.imageSmoothingEnabled = false;
          context.save();
          context.translate(-camera.x, -camera.y);
          context.drawImage(background, 0, 0);
          for (const slime of enemies) drawSlime(context, slime);
          for (const activePlayer of players) drawPlayer(context, artwork, activePlayer);
          for (const activePlayer of players) drawWeaponAttack(context, activePlayer);
          drawEffects(context, current.effects);
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
          canvas.dataset.playerHp = String(player.hp);
          canvas.dataset.playerMaxHp = String(player.maxHp);
          canvas.dataset.playerInvulnerabilityFrames = String(player.invulnerabilityFrames);
          canvas.dataset.stamina = String(player.stamina);
          canvas.dataset.dodgeFrames = String(player.dodgeFrames);
          canvas.dataset.dodgeCooldownFrames = String(player.dodgeCooldownFrames);
          canvas.dataset.dodgeDirectionX = String(player.dodgeX);
          canvas.dataset.dodgeDirectionY = String(player.dodgeY);
          canvas.dataset.staminaRegenDelayFrames = String(player.staminaRegenDelayFrames);
          canvas.dataset.dodgesStarted = String(current.dodgesStarted ?? 0);
          canvas.dataset.slimeCount = String(enemies.length);
          canvas.dataset.slimeHp = String(enemies[0]?.hp ?? 0);
          canvas.dataset.slimes = JSON.stringify(enemies);
          canvas.dataset.damageDealt = String(current.damageDealt ?? 0);
          canvas.dataset.damageTaken = String(current.damageTaken ?? 0);
          canvas.dataset.slimesDefeated = String(current.slimesDefeated ?? 0);
          canvas.dataset.lastEvent = current.lastEvent?.type ?? "ready";
          canvas.dataset.lastEventSequence = String(current.lastEvent?.sequence ?? 0);
          canvas.dataset.attackFrame = String(player.attack?.frame ?? 0);
          canvas.dataset.attackCooldownFrames = String(player.attackCooldownFrames ?? 0);
          canvas.dataset.smoothing = String(context.imageSmoothingEnabled);
          canvas.dataset.ambientBrightness = String(lightingSettings.ambientBrightness);
          canvas.dataset.playerLightRadius = String(lightingSettings.playerLightRadius);
          canvas.dataset.playerLightIntensity = String(lightingSettings.playerLightIntensity);
          canvas.dataset.playerLightSoftness = String(lightingSettings.playerLightSoftness);
          canvas.dataset.fullyLit = String(lightingSettings.fullyLit);
          position.textContent = `Aries position: ${player.x.toFixed(1)}, ${player.y.toFixed(1)} · HP ${player.hp}/${player.maxHp} · Stamina ${player.stamina.toFixed(1)}`;
          hud.textContent = `Aries · HP ${player.hp}/${player.maxHp} · Stamina ${Math.floor(player.stamina)} · Slimes ${enemies.length}`;
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
          controllerStatus.remove();
          lightingControls.remove();
          hud.remove();
          current = undefined;
        }
      };
    }
  });
}
