import * as generic from "../../games/generic-grid-v1/src/project.js";
import * as tower from "../../games/astraeum-tower/src/project.js";
import { ASTRAEUM_MODEL } from "../project-identity.js";

export function connectedFixture(model, axis = "x") {
  const project = model === generic.MODEL ? generic : tower;
  const isTower = model === ASTRAEUM_MODEL;
  const root = isTower ? tower.createBlankDocument("connected-level", "Connected fixture")
    : generic.createDocument("connected-level", "Connected fixture");
  const next = structuredClone(root);
  next.id = "connected-neighbor";
  next.objects = [];
  root.objects = [];
  const point = (along, across) => axis === "x" ? { x: along, y: across } : { x: across, y: along };
  const add = (design, id, assetId, transform) =>
    design.objects.push(project.createDesignObject(id, assetId, transform, design.objects.length));
  for (const design of [root, next]) {
    for (let along = 0; along < 2048; along += 32) {
      for (let across = 992; across <= 1056; across += 32) {
        const transform = point(along, across);
        if (design.objects.some(object => object.type === "terrain-tile" &&
            object.transform.x === transform.x && object.transform.y === transform.y)) continue;
        add(design, `floor-${along}-${across}`, isTower ? "floor-cobblestone" : "generic-tile", transform);
      }
    }
  }
  add(root, "authored-primary", isTower ? "spawn-aries" : "generic-player",
    point(isTower ? 2000 : 1984, isTower ? 1040 : 1024));
  if (!isTower) add(next, "authored-secondary", "generic-player-2", point(32, 1024));
  add(root, "west-block", isTower ? "wall-damp-stone" : "generic-block", point(1888, 1024));
  add(next, "east-block", isTower ? "wall-damp-stone" : "generic-block", point(128, 1024));
  return [
    { sectionId: "root", mapId: root.id, gridX: axis === "x" ? -1 : 0,
      gridY: axis === "y" ? -1 : 0, document: project.validateFloorDocument(root) },
    { sectionId: "neighbor", mapId: next.id, gridX: 0, gridY: 0,
      document: project.validateFloorDocument(next) }
  ];
}
