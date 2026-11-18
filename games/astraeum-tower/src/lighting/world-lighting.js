export const DEFAULT_WORLD_LIGHTING_SETTINGS = Object.freeze({
  ambientBrightness: 1,
  playerLightRadius: 100,
  playerLightIntensity: 1,
  playerLightSoftness: 0.5,
  fullyLit: true
});

const lightingLayers = new WeakMap();
const RGB_HEX = /^#[\da-f]{6}$/i;

export function validateWorldLightingSettings(settings) {
  if (!settings || typeof settings !== "object" ||
      !Number.isFinite(settings.ambientBrightness) ||
      settings.ambientBrightness < 0 || settings.ambientBrightness > 1 ||
      !Number.isFinite(settings.playerLightRadius) ||
      settings.playerLightRadius < 1 || settings.playerLightRadius > 1000 ||
      !Number.isFinite(settings.playerLightIntensity) ||
      settings.playerLightIntensity < 0 || settings.playerLightIntensity > 1 ||
      !Number.isFinite(settings.playerLightSoftness) ||
      settings.playerLightSoftness <= 0 || settings.playerLightSoftness >= 1 ||
      typeof settings.fullyLit !== "boolean") {
    throw new TypeError("World lighting settings are outside their supported ranges.");
  }
  return Object.freeze({
    ambientBrightness: settings.ambientBrightness,
    playerLightRadius: settings.playerLightRadius,
    playerLightIntensity: settings.playerLightIntensity,
    playerLightSoftness: settings.playerLightSoftness,
    fullyLit: settings.fullyLit
  });
}

export function createWorldLightingSettings(overrides = {}) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new TypeError("World lighting overrides must be an object.");
  }
  return validateWorldLightingSettings({
    ...DEFAULT_WORLD_LIGHTING_SETTINGS,
    ...overrides
  });
}

function viewPoint(point, view) {
  return {
    x: (point.x - view.cameraX) * view.scaleX,
    y: (point.y - view.cameraY) * view.scaleY
  };
}

function getLightingLayer(context) {
  let layer = lightingLayers.get(context);
  if (!layer) {
    const canvas = document.createElement("canvas");
    const mask = canvas.getContext("2d");
    if (!mask) throw new Error("Canvas 2D lighting is unavailable.");
    layer = { canvas, mask };
    lightingLayers.set(context, layer);
  }
  if (layer.canvas.width !== context.canvas.width || layer.canvas.height !== context.canvas.height) {
    layer.canvas.width = context.canvas.width;
    layer.canvas.height = context.canvas.height;
  }
  return layer;
}

function colorWithAlpha(color, alpha) {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(color);
  if (!match) throw new TypeError("Environmental light colors must use #RRGGBB.");
  const [, red, green, blue] = match;
  return `rgba(${Number.parseInt(red, 16)},${Number.parseInt(green, 16)},` +
    `${Number.parseInt(blue, 16)},${alpha})`;
}

export function drawWorldLighting(context, playerLight, environmentalLights, settings, {
  cameraX = 0,
  cameraY = 0,
  scaleX = 1,
  scaleY = 1,
  pixelRatio = 1,
  ambientColor = "#06040e"
} = {}) {
  const lighting = validateWorldLightingSettings(settings);
  if (!context?.canvas || !playerLight ||
      !Number.isFinite(playerLight.x) || !Number.isFinite(playerLight.y) ||
      !Number.isFinite(cameraX) || !Number.isFinite(cameraY) ||
      !Number.isFinite(scaleX) || scaleX <= 0 ||
      !Number.isFinite(scaleY) || scaleY <= 0 ||
      !Number.isFinite(pixelRatio) || pixelRatio <= 0 ||
      !Array.isArray(environmentalLights) ||
      typeof ambientColor !== "string" || !RGB_HEX.test(ambientColor)) {
    throw new TypeError("World lighting requires a canvas context, view, player and light list.");
  }
  for (const light of environmentalLights) {
    if (!Number.isFinite(light.x) || !Number.isFinite(light.y) ||
        !Number.isFinite(light.radius) || light.radius <= 0 ||
        !Number.isFinite(light.intensity) || light.intensity < 0 || light.intensity > 1 ||
        !Number.isFinite(light.softness) || light.softness <= 0 || light.softness >= 1 ||
        (light.color !== undefined &&
          (typeof light.color !== "string" || !RGB_HEX.test(light.color))) ||
        (light.glowRadius !== undefined &&
          (!Number.isFinite(light.glowRadius) || light.glowRadius < 0)) ||
        (light.glowRadius > 0 &&
          (typeof light.glowColor !== "string" || !RGB_HEX.test(light.glowColor) ||
            typeof light.glowEndColor !== "string" || !RGB_HEX.test(light.glowEndColor) ||
            !Number.isFinite(light.glowIntensity) ||
            light.glowIntensity < 0 || light.glowIntensity > 1))) {
      throw new TypeError("Environmental light values are invalid.");
    }
  }
  if (lighting.fullyLit) return;

  const width = context.canvas.width / pixelRatio;
  const height = context.canvas.height / pixelRatio;
  const { canvas: layer, mask } = getLightingLayer(context);
  mask.setTransform(1, 0, 0, 1, 0, 0);
  mask.clearRect(0, 0, layer.width, layer.height);
  mask.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  mask.globalCompositeOperation = "source-over";
  mask.fillStyle = ambientColor;
  mask.globalAlpha = 1 - lighting.ambientBrightness;
  mask.fillRect(0, 0, width, height);
  mask.globalAlpha = 1;
  mask.globalCompositeOperation = "destination-out";

  const view = { cameraX, cameraY, scaleX, scaleY };
  const lights = [
    ...environmentalLights,
    {
      x: playerLight.x,
      y: playerLight.y,
      radius: lighting.playerLightRadius,
      intensity: lighting.playerLightIntensity,
      softness: lighting.playerLightSoftness
    }
  ];
  for (const light of lights) {
    const point = viewPoint(light, view);
    const radius = light.radius * Math.min(scaleX, scaleY);
    if (point.x < -radius || point.y < -radius ||
        point.x > width + radius || point.y > height + radius) continue;

    const gradient = mask.createRadialGradient(point.x, point.y, 0, point.x, point.y, radius);
    gradient.addColorStop(0, `rgba(0,0,0,${light.intensity})`);
    gradient.addColorStop(light.softness, `rgba(0,0,0,${light.intensity * light.softness})`);
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    mask.fillStyle = gradient;
    mask.beginPath();
    mask.arc(point.x, point.y, radius, 0, Math.PI * 2);
    mask.fill();
  }
  context.drawImage(layer, 0, 0, width, height);

  context.save();
  context.globalCompositeOperation = "lighter";
  for (const light of environmentalLights) {
    if (typeof light.color !== "string") continue;
    const point = viewPoint(light, view);
    const radius = light.radius * 0.6 * Math.min(scaleX, scaleY);
    const gradient = context.createRadialGradient(point.x, point.y, 0, point.x, point.y, radius);
    gradient.addColorStop(0, colorWithAlpha(light.color, 0.16 * light.intensity));
    gradient.addColorStop(1, colorWithAlpha(light.color, 0));
    context.fillStyle = gradient;
    context.beginPath();
    context.arc(point.x, point.y, radius, 0, Math.PI * 2);
    context.fill();
    if (light.glowRadius > 0) {
      const glowRadius = light.glowRadius * Math.min(scaleX, scaleY);
      const glow = context.createRadialGradient(point.x, point.y, 0, point.x, point.y, glowRadius);
      glow.addColorStop(0, colorWithAlpha(light.glowColor, light.glowIntensity));
      glow.addColorStop(1, colorWithAlpha(light.glowEndColor, 0));
      context.fillStyle = glow;
      context.beginPath();
      context.arc(point.x, point.y, glowRadius, 0, Math.PI * 2);
      context.fill();
    }
  }
  context.restore();
}
