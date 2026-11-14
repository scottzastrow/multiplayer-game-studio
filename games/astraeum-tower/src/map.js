import floor1 from "./floor1.json";
import { createTilemapDefinition } from "./tilemap-adapter.js";

export const floor1Grid = Object.freeze(floor1.f1);
export const floor1Map = createTilemapDefinition(floor1Grid, {
  id: "astraeum-tower-floor-1",
  name: "Damp Corridors"
});

export const floor1Counts = Object.freeze({
  width: floor1Grid[0].length,
  height: floor1Grid.length,
  walls: floor1Grid.reduce((sum, row) => sum + [...row].filter(cell => cell === "#").length, 0)
});
