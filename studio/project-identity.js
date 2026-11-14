export const ASTRAEUM_PROJECT_ID = "astraeum-tower";
export const ASTRAEUM_FLOOR_1_MAP_ID = "astraeum-tower-floor-1";
export const ASTRAEUM_MODEL = "astraeum-floor-v2";

const ID = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;

export function isProjectMapId(value) {
  return typeof value === "string" && ID.test(value);
}
