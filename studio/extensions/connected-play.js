import {
  MAP_CELL_SIZE,
  qualifyConnectedMapReference,
  validateConnectedMapDefinition
} from "@multiplayer-game/theme-sdk";
import * as generic from "../../games/generic-grid-v1/src/project.js";
import * as tower from "../../games/astraeum-tower/src/project.js";
import { drawDesign as drawTower, fixedDecorations } from "../../games/astraeum-tower/src/design-render.js";
import { createTowerGameModule, towerSettings } from "../../games/astraeum-tower/src/game.js";
import { drawPlayer, towerSkinFactory } from "../../games/astraeum-tower/src/skin.js";
import { ASTRAEUM_MODEL } from "../project-identity.js";
import { sectionOrigin, worldToSection } from "../world-coordinates.js";
import {
  appendCollisionRectangles, blockedSectionCells, cellRectangles, defaultBoundaryCells, playableBoundaryCells
} from "../playable-boundaries.js";

const CELL = MAP_CELL_SIZE;
const metadata = Object.freeze({ id: "studio-connected-movement", version: "1.0.0", stateSchemaVersion: 1 });

export function createConnectedPreview(sourceSections, { mapId, model, assetCatalog, rootDocument,
  arrival, playerState, interactionState, requireNeutral = false }) {
  if (![generic.MODEL, ASTRAEUM_MODEL].includes(model)) throw new Error("Unsupported connected Play model.");
  const isTower = model === ASTRAEUM_MODEL;
  const project = isTower ? tower : generic;
  const sections = sourceSections.map(({ sectionId, mapId, gridX, gridY, document }) => ({
    sectionId, mapId, gridX, gridY, origin: sectionOrigin(gridX, gridY),
    document: project.validateFloorDocument(structuredClone(document), assetCatalog)
  }));
  const root = sections.find(section => section.mapId === mapId) ??
    (rootDocument?.id === mapId ? { document: project.validateFloorDocument(structuredClone(rootDocument), assetCatalog) } : null);
  if (!root) throw new Error("The selected level's root section is missing. Reopen the level before Play.");
  const requiredStarts = isTower ? ["spawn-aries"] : ["generic-player", "generic-player-2"];
  for (const assetId of requiredStarts) {
    const count = sections.reduce((sum, section) =>
      sum + section.document.objects.filter(object => object.assetId === assetId).length, 0);
    if (count !== 1) throw new Error(`Connected Play needs exactly one ${assetCatalog[assetId].label} across the selected level (found ${count}).`);
  }
  const playable = root.document.playableBoundary
    ? playableBoundaryCells(root.document.playableBoundary, sections) : defaultBoundaryCells(sections);
  const blockers = [];
  const occupancies = new Map();
  const blockedCells = new Map();
  const blockedByObject = (position, radius) => blockers.some(rect => {
    const x = Math.max(rect.x, Math.min(position.x, rect.x + rect.width));
    const y = Math.max(rect.y, Math.min(position.y, rect.y + rect.height));
    return (position.x - x) ** 2 + (position.y - y) ** 2 < radius ** 2;
  });
  const maps = sections.map(section => {
    const { document, origin } = section;
    const { bounds, cellSize, objects, collisions, spawns } = project.createFloorSection(document, assetCatalog);
    const grid = isTower ? tower.floorDocumentGrid(document, assetCatalog) : null;
    const blocked = blockedSectionCells(bounds, origin, playable, grid);
    if (isTower) {
      occupancies.set(`${section.gridX},${section.gridY}`, tower.cellOccupancy(document));
      blockers.push(...tower.collisionRects(document).map(rect => ({
        ...rect, x: rect.x + origin.x, y: rect.y + origin.y
      })));
    }
    const rectangles = cellRectangles(blocked).map(rect => ({
      x: rect.x * CELL, y: rect.y * CELL, width: rect.width * CELL, height: rect.height * CELL
    }));
    blockedCells.set(section.sectionId, blocked);
    return {
      id: section.sectionId, origin,
      map: appendCollisionRectangles({
        bounds, cellSize, objects, collisions,
        spawns: isTower ? spawns.filter(spawn => spawn.id !== "reserved-player-spawn") : spawns
      }, rectangles)
    };
  });
  if (isTower) {
    const owner = maps.find(section => section.map.spawns.length);
    const start = owner.map.spawns[0].position;
    const primaryPosition = { x: owner.origin.x + start.x, y: owner.origin.y + start.y };
    let reserved = false;
    // The public world requires two distinct walkable starts, even for one actor.
    // Keep Tower's unused compatibility slot on existing playable geometry.
    reserve: for (const section of maps) {
      for (let y = CELL / 2; y < section.map.bounds.height; y += CELL) {
        for (let x = CELL / 2; x < section.map.bounds.width; x += CELL) {
          const position = { x: section.origin.x + x, y: section.origin.y + y };
          if (blockedCells.get(section.id).has(`${(x - CELL / 2) / CELL},${(y - CELL / 2) / CELL}`) ||
              (position.x === primaryPosition.x && position.y === primaryPosition.y) ||
              blockedByObject(position, 4)) continue;
          section.map.spawns.push({ id: "reserved-player-spawn", kind: "player", position: { x, y }, radius: 4 });
          reserved = true;
          break reserve;
        }
      }
    }
    if (!reserved) throw new Error("The public connected runtime requires two distinct walkable start cells. Keep the Aries start and provide another open cell inside the playable boundary.");
  }
  const world = validateConnectedMapDefinition({
    formatVersion: 1, id: root.document.id, name: root.document.name, cellSize: CELL, sections: maps
  });
  const primarySection = sections.find(section =>
    section.document.objects.some(object => object.assetId === requiredStarts[0]));
  const primary = primarySection.document.objects.find(object => object.assetId === requiredStarts[0]);
  if (arrival && (arrival.sectionId !== primarySection.sectionId || arrival.startId !== primary.id)) {
    throw new Error("The destination player start is missing, deleted or inactive. Select an active Aries start in the exit Inspector.");
  }
  const startId = qualifyConnectedMapReference(primarySection.sectionId, isTower ? "aries-start" : primary.id);
  const bounds = {
    x: Math.min(...sections.map(section => section.origin.x)),
    y: Math.min(...sections.map(section => section.origin.y)),
    right: Math.max(...sections.map(section => section.origin.x + section.document.bounds.width)),
    bottom: Math.max(...sections.map(section => section.origin.y + section.document.bounds.height))
  };
  const options = {
    world,
    settings: isTower ? towerSettings : { moveDistance: 4 },
    seed: 1,
    roster: [isTower
      ? { accountId: "aries", username: "Aries", joinedOrder: 0 }
      : { accountId: "player", username: "Player", joinedOrder: 0 }],
    viewer: { accountId: isTower ? "aries" : "player", role: "player" },
    moduleFactory: isTower
      ? createTowerGameModule(primarySection.document, assetCatalog, {
        mapId,
        interactionState,
        primaryStartId: startId,
        playerState,
        strictArrival: Boolean(arrival),
        sections: sections.map(({ sectionId, origin, document }) => ({ sectionId, origin, document }))
      })
      : {
      metadata,
      validateSettings: settings => settings?.moveDistance === 4,
      create(context, settings) {
        let input = { x: 0, y: 0 };
        let tick = 0;
        return {
          stateSchemaVersion: 1,
          initialize() {
            if (!context.connectedMap) throw new Error("Connected Play requires the public world runtime.");
            const start = context.connectedMapSpawns.find(spawn => spawn.qualifiedId === startId);
            if (!start) throw new Error("The authored player start was not resolved by the runtime.");
            for (const spawn of context.connectedMapSpawns.filter(spawn => spawn.kind === "player")) {
              if (!context.geometry.isWalkable(spawn.position.x, spawn.position.y, spawn.radius) ||
                  blockedByObject(spawn.position, spawn.radius)) {
                throw new Error(`Player start ${spawn.sectionId}/${spawn.id} is blocked or outside the playable boundary. Move the start or edit the boundary before Play.`);
              }
            }
            context.entities.add({
              id: "player", typeId: "connected-player", position: start.position, radius: start.radius,
              state: { facing: "south", moving: false, startId }
            });
          },
          validateInput: value => value?.type === "move" &&
            [value.x, value.y].every(component => Number.isFinite(component) && Math.abs(component) <= 1),
          applyInput(_accountId, value) { input = { x: value.x, y: value.y }; },
          step(_dt, nextTick) {
            tick = nextTick;
            const player = context.entities.get("player");
            const scale = settings.moveDistance / Math.max(1, Math.hypot(input.x, input.y));
            let position = player.position;
            for (const axis of ["x", "y"]) {
              const candidate = context.geometry.moveCircle(position,
                { x: 0, y: 0, [axis]: input[axis] * scale }, player.radius);
              if (!blockedByObject(candidate, player.radius)) position = candidate;
            }
            const facing = input.x ? input.x > 0 ? "east" : "west"
              : input.y ? input.y > 0 ? "south" : "north" : player.state.facing;
            context.entities.update(player.id, current => ({
              ...current, position,
              state: { ...current.state, facing,
                moving: position.x !== player.position.x || position.y !== player.position.y }
            }));
          },
          snapshot() { return { tick, player: context.entities.get("player") }; },
          results() { return { tick }; },
          dispose() { input = { x: 0, y: 0 }; }
        };
      }
    }
  };
  const sampleCell = (section, x, y) => {
    const point = worldToSection(section.origin.x + x * CELL, section.origin.y + y * CELL);
    const occupancy = occupancies.get(`${point.gridX},${point.gridY}`);
    return { floor: occupancy?.floor[point.y / CELL]?.[point.x / CELL] ?? false,
      wall: occupancy?.wall[point.y / CELL]?.[point.x / CELL] ?? false };
  };
  const drawWorld = (context, artwork) => {
    for (const section of sections) {
      context.save();
      context.translate(section.origin.x, section.origin.y);
      context.beginPath();
      context.rect(0, 0, section.document.bounds.width, section.document.bounds.height);
      context.clip();
      if (isTower) {
        drawTower(context, artwork, section.document, {
          grid: tower.floorDocumentGrid(section.document, assetCatalog),
          mode: "play", assetCatalog,
          sampleCell: (x, y) => sampleCell(section, x, y)
        });
      } else generic.drawDesign(context, artwork, section.document, { mode: "play", assetCatalog });
      context.restore();
    }
  };
  return {
    options, sections, bounds, cameraZoom: root.document.cameraZoom ?? 1,
    isTower, primaryDocument: { ...primarySection.document, cameraZoom: root.document.cameraZoom ?? 1 },
    assetCatalog, drawWorld, requireNeutral,
    drawActor(context, artwork, player, tick) {
      if (isTower) {
        drawPlayer(context, artwork, {
          x: player.position.x, y: player.position.y + 8,
          facing: player.state.facing, moving: player.state.moving, frame: Math.floor(tick / 4)
        });
      } else {
        context.fillStyle = "#087f5b";
        context.beginPath();
        context.arc(player.position.x, player.position.y, player.radius, 0, Math.PI * 2);
        context.fill();
      }
    }
  };
}

export function connectedCamera(bounds, position, width, height, zoom) {
  const axis = (value, min, max, size) => max - min <= size
    ? (min + max - size) / 2 : Math.max(min, Math.min(max - size, value - size / 2));
  return { x: axis(position.x, bounds.x, bounds.right, width / zoom),
    y: axis(position.y, bounds.y, bounds.bottom, height / zoom) };
}

export function connectedSkin(preview, artwork, preferredControlMode) {
  if (preview.isTower) {
    const candles = [];
    const placedLights = [];
    for (const section of preview.sections) {
      const start = section.document.objects.find(object => object.assetId === "spawn-aries")?.transform;
      const decor = fixedDecorations(artwork,
        tower.floorDocumentGrid(section.document, preview.assetCatalog), start);
      candles.push(...decor.candles.map(candle => ({
        ...candle.light,
        x: candle.light.x + section.origin.x,
        y: candle.light.y + section.origin.y
      })));
      placedLights.push(...tower.objectLights(section.document, preview.assetCatalog).map(light => ({
        ...light, x: light.x + section.origin.x, y: light.y + section.origin.y
      })));
    }
    const collisionCount = preview.options.world.sections.reduce(
      (count, section) => count + section.map.collisions.length, 0
    );
    return towerSkinFactory(artwork, undefined, preview.primaryDocument, preview.assetCatalog,
      preferredControlMode, {
        bounds: preview.bounds, candles, placedLights, collisionCount, requireNeutral: preview.requireNeutral,
        draw: context => preview.drawWorld(context, artwork)
      });
  }
  return {
    metadata: { id: "studio-connected-movement-skin", version: "1.0.0",
      acceptedModuleId: metadata.id, acceptedStateSchemaVersions: [1] },
    mount(host) {
      const slot = host.slots.get("world");
      if (!slot) throw new Error("Connected Play requires a world slot.");
      const canvas = document.createElement("canvas");
      canvas.tabIndex = 0;
      canvas.dataset.testid = "connected-preview";
      canvas.setAttribute("aria-label", "Connected level movement preview");
      Object.assign(canvas.style, { width: "100%", height: "100%", display: "block", outline: "none" });
      slot.append(canvas);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas 2D rendering is unavailable.");
      const help = document.createElement("p");
      help.textContent = "Connected movement preview: Arrows/WASD move. Combat, dodge and lighting are not simulated.";
      host.slots.get("controls")?.append(help);
      const keys = new Set();
      const listeners = new AbortController();
      const codes = { ArrowLeft: [-1, 0], KeyA: [-1, 0], ArrowRight: [1, 0], KeyD: [1, 0],
        ArrowUp: [0, -1], KeyW: [0, -1], ArrowDown: [0, 1], KeyS: [0, 1] };
      const neutral = () => { keys.clear(); host.dispatchInput({ type: "move", x: 0, y: 0 }); };
      for (const name of ["keydown", "keyup"]) canvas.addEventListener(name, event => {
        if (!codes[event.code]) return;
        event.preventDefault();
        if (name === "keydown") keys.add(event.code); else keys.delete(event.code);
      }, { signal: listeners.signal });
      for (const target of [canvas, window]) target.addEventListener("blur", neutral, { signal: listeners.signal });
      canvas.addEventListener("pointerdown", () => canvas.focus(), { signal: listeners.signal });
      document.addEventListener("visibilitychange", () => { if (document.hidden) neutral(); }, { signal: listeners.signal });
      let snapshot;
      return {
        handleSnapshot(value) { snapshot = value; },
        handleEvents() {},
        handleViewport() {},
        render() {
          if (!snapshot) return;
          const movement = [...keys].reduce((sum, code) => ({
            x: sum.x + codes[code][0], y: sum.y + codes[code][1]
          }), { x: 0, y: 0 });
          host.dispatchInput({ type: "move", x: Math.sign(movement.x), y: Math.sign(movement.y) });
          const width = Math.max(1, canvas.clientWidth), height = Math.max(1, canvas.clientHeight);
          const ratio = window.devicePixelRatio || 1, zoom = preview.cameraZoom;
          canvas.width = Math.round(width * ratio);
          canvas.height = Math.round(height * ratio);
          const camera = connectedCamera(preview.bounds, snapshot.player.position, width, height, zoom);
          context.setTransform(ratio, 0, 0, ratio, 0, 0);
          context.fillStyle = "#22252b";
          context.fillRect(0, 0, width, height);
          context.imageSmoothingEnabled = false;
          context.setTransform(ratio * zoom, 0, 0, ratio * zoom, -camera.x * ratio * zoom, -camera.y * ratio * zoom);
          preview.drawWorld(context, artwork);
          preview.drawActor(context, artwork, snapshot.player, snapshot.tick);
          Object.assign(canvas.dataset, { position: JSON.stringify(snapshot.player.position),
            tick: String(snapshot.tick), cameraX: String(camera.x), cameraY: String(camera.y),
            cameraZoom: String(zoom), sectionCount: String(preview.sections.length) });
        },
        dispose() { neutral(); listeners.abort(); canvas.remove(); help.remove(); }
      };
    }
  };
}
