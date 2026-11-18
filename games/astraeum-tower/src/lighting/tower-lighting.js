import { createWorldLightingSettings } from "./world-lighting.js";

export const TOWER_AMBIENT_COLOR = "#06040e";
export const TOWER_PLAYER_LIGHT_OFFSET_Y = -20;

export const towerLightingSettings = createWorldLightingSettings({
  ambientBrightness: 0.2,
  playerLightRadius: 200,
  playerLightIntensity: 1,
  playerLightSoftness: 0.55,
  fullyLit: false
});

export function createTowerLightingSettings(overrides = {}) {
  return createWorldLightingSettings({
    ...towerLightingSettings,
    ...overrides
  });
}
