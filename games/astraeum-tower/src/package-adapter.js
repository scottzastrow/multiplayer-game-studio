import { ASSET_CATALOG } from "./catalog.js";
import {
  collisionRect,
  floorDocumentGrid,
  validateFloorDocument
} from "./project.js";
import { blockedSectionCells, cellRectangles, defaultBoundaryCells, playableBoundaryCells } from "../../../studio/playable-boundaries.js";
import { sectionOrigin } from "../../../studio/world-coordinates.js";
import provenance from "../assets/provenance.json" with { type: "json" };

const CELL_SIZE = 32;
const PACKAGE_MEDIA = Object.freeze({
  "aries-idle.png": "aries-idle",
  "aries-north.png": "aries-north",
  "aries-south.png": "aries-south",
  "aries-east.png": "aries-east",
  "aries-west.png": "aries-west",
  "herb.png": "item-herb",
  "amethyst.png": "item-amethyst",
  "sapphire.png": "item-sapphire"
});

export const ASTRAEUM_PACKAGE_ID = "astraeum-tower";
export const ASTRAEUM_PACKAGE_VERSION = "1.0.0";
export const ASTRAEUM_MODULE = Object.freeze({
  id: "astraeum-tower",
  version: "1.0.0",
  stateSchemaVersion: 1
});
export const ASTRAEUM_SKIN = Object.freeze({
  rendererId: "astraeum-tower-skin",
  version: "1.0.0",
  acceptedModuleId: "astraeum-tower",
  acceptedStateSchemaVersions: Object.freeze([1])
});
export const ASTRAEUM_PROJECT_CREDIT = provenance.projectCredit;
export const ASTRAEUM_ARTWORK_PROVENANCE = Object.freeze(
  Object.fromEntries(provenance.assets.map(asset => [asset.file, asset]))
);

function campaignLevelLabel(level) {
  const root = [...(level.sections ?? []), ...(level.archivedSections ?? [])]
    .find(section => section.mapId === level.mapId);
  const name = root?.document?.name?.trim();
  return name ? `${name} (${level.mapId})` : level.mapId;
}

export function orderAstraeumCampaignLevels(snapshot) {
  if (!snapshot || snapshot.model !== "astraeum-floor-v2" ||
      typeof snapshot.startingMapId !== "string" ||
      !Array.isArray(snapshot.levels) || !snapshot.levels.length) {
    fail("Astraeum export requires a nonempty saved campaign snapshot.");
  }
  const levels = new Map(snapshot.levels.map(level => [level.mapId, level]));
  if (levels.size !== snapshot.levels.length) fail("The saved campaign contains duplicate active level IDs.");
  const ordered = [];
  const visited = new Set();
  let nextId = snapshot.startingMapId;
  while (nextId) {
    const level = levels.get(nextId);
    if (!level) fail(`The active campaign exit targets missing or inactive level ${nextId}.`);
    if (visited.has(nextId)) fail(`The saved campaign exit graph loops back to level ${campaignLevelLabel(level)}.`);
    ordered.push(level);
    visited.add(nextId);
    const runes = (level.sections ?? []).flatMap(section =>
      (section.document?.objects ?? [])
        .filter(object => object.assetId === "prop-stairs-rune")
        .map(object => ({ sectionId: section.sectionId, object })));
    if (ordered.length === levels.size) {
      if (runes.length) {
        fail(`Final active level ${campaignLevelLabel(level)} contains stairs rune ${runes[0].object.id} ` +
          `in section ${runes[0].sectionId}. Remove it or connect it to the next active level in the Inspector, then save.`);
      }
      break;
    }
    if (!runes.length) {
      const remaining = [...levels.values()].filter(candidate => !visited.has(candidate.mapId));
      const remainingNames = remaining.length
        ? ` Remaining active levels: ${remaining.map(campaignLevelLabel).join("; ")}.`
        : "";
      fail(`Level ${campaignLevelLabel(level)} has no active stairs rune, but ${remaining.length} other active ` +
        `level${remaining.length === 1 ? " remains" : "s remain"} to connect. Add a stairs rune and choose its next ` +
        `active level, section, and Aries start in the Inspector, then save; delete any active level that should not ` +
        `be included. Studio will not infer or create exits.${remainingNames}`);
    }
    for (const { sectionId, object } of runes) {
      if (!object.exit?.levelId || !object.exit.sectionId || !object.exit.startId) {
        fail(`Level ${campaignLevelLabel(level)}, section ${sectionId}, stairs rune ${object.id} has no complete ` +
          `active exit destination. Choose a level and active Aries start in the Inspector, then save; Studio will ` +
          `not infer this connection.`);
      }
    }
    const destinations = new Set(runes.map(({ object }) => object.exit.levelId));
    if (destinations.size !== 1) {
      fail(`Level ${campaignLevelLabel(level)} has stairs runes targeting multiple levels; branching campaign exits ` +
        `are unsupported. Choose one next active level for every rune in the Inspector.`);
    }
    nextId = destinations.values().next().value;
    if (!levels.has(nextId)) {
      fail(`Level ${campaignLevelLabel(level)} has an exit to missing or inactive level ${nextId}. Choose an active ` +
        `level and Aries start in the Inspector, then save.`);
    }
  }
  if (ordered.length !== levels.size) {
    const unreachable = [...levels.values()].filter(level => !visited.has(level.mapId)).map(campaignLevelLabel);
    fail(`Active levels are not reachable from the saved starting level: ${unreachable.join("; ")}.`);
  }
  return ordered;
}

export function createAstraeumPackageTheme({ project, author, course, assets, assetProvenance }) {
  return {
    id: "astraeum",
    name: "Astraeum Tower",
    version: "1.0.0",
    engineApiMajor: 1,
    module: { ...ASTRAEUM_MODULE },
    skin: {
      ...ASTRAEUM_SKIN,
      acceptedStateSchemaVersions: [...ASTRAEUM_SKIN.acceptedStateSchemaVersions]
    },
    assetsDigest: "0".repeat(64),
    settingsSchemaVersion: 1,
    settingsSchema: {
      maxPlayers: { type: "integer", minimum: 1, maximum: 32 },
      maxSpectators: { type: "integer", minimum: 0, maximum: 64 },
      initialNpcsPerPlayer: { type: "integer", minimum: 1, maximum: 100 },
      npcPopulationGrowthPercent: { type: "number", minimum: 0, maximum: 100 },
      baseNpcHealth: { type: "integer", minimum: 1, maximum: 100000 },
      npcHealthGrowthPercent: { type: "number", minimum: 0, maximum: 100 },
      respawnDelaySeconds: { type: "number", minimum: 0, maximum: 60 },
      maxLevels: { type: "integer", minimum: 1, maximum: 100 },
      themeRevision: { type: "string", const: "astraeum@1.0.0" }
    },
    settingsDefaults: {
      maxPlayers: 4,
      maxSpectators: 8,
      initialNpcsPerPlayer: 10,
      npcPopulationGrowthPercent: 20,
      baseNpcHealth: 100,
      npcHealthGrowthPercent: 10,
      respawnDelaySeconds: 5,
      maxLevels: 5,
      themeRevision: "astraeum@1.0.0"
    },
    project,
    author,
    ...(course ? { course } : {}),
    assets,
    assetProvenance
  };
}

function fail(message) {
  throw new TypeError(message);
}

function mediaIdForFile(filename) {
  return PACKAGE_MEDIA[filename] ??
    `studio-${filename.replace(/\.png$/i, "").toLowerCase().replace(/[^a-z0-9._-]/g, "-")}`;
}

function addMedia(media, descriptor) {
  const previous = media.get(descriptor.mediaId);
  if (previous && (previous.kind !== descriptor.kind || previous.file !== descriptor.file ||
      previous.assetId !== descriptor.assetId ||
      JSON.stringify(previous.provenance) !== JSON.stringify(descriptor.provenance))) {
    fail(`Artwork ${descriptor.mediaId} has conflicting attribution or source identity.`);
  }
  media.set(descriptor.mediaId, descriptor);
}

function addBuiltinMedia(media, assetId, asset) {
  const artwork = asset.artwork;
  if (!artwork) return undefined;
  const source = ASTRAEUM_ARTWORK_PROVENANCE[artwork.file];
  if (!source) fail(`Built-in asset ${assetId} has no provenance record for ${artwork.file}.`);
  const mediaId = mediaIdForFile(artwork.file);
  addMedia(media, {
    mediaId,
    file: artwork.file,
    kind: "builtin",
    provenance: {
      author: source.credit,
      source: source.sourceLocation,
      sourceFilename: source.file
    }
  });
  return { mediaId, mediaRegion: { ...artwork.region } };
}

function collisionObject(rect, index) {
  const id = `collision-${index}`;
  return {
    object: {
      id,
      typeId: "collision",
      position: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
      properties: { assetId: "collision" }
    },
    collision: {
      id: `collision-shape-${index}`,
      objectId: id,
      shape: { type: "rect", width: rect.width, height: rect.height }
    }
  };
}

function sectionMap(level, section, assetCatalog, importedAssets, media) {
  const document = validateFloorDocument(section.document, assetCatalog);
  const objects = [];
  const collisions = [];
  const spawns = [];
  let collisionIndex = 0;
  const usedIds = new Set(document.objects.map(object => object.id));
  const addCollision = rect => {
    const generated = collisionObject(rect, collisionIndex++);
    while (usedIds.has(generated.object.id)) {
      generated.object.id = `collision-${collisionIndex++}`;
      generated.collision.id = `collision-shape-${collisionIndex - 1}`;
      generated.collision.objectId = generated.object.id;
    }
    usedIds.add(generated.object.id);
    objects.push(generated.object);
    collisions.push(generated.collision);
  };

  for (const [objectIndex, object] of document.objects.entries()) {
    if (object.assetId === "spawn-aries") {
      spawns.push({
        id: object.id,
        kind: "player",
        position: { ...object.transform },
        radius: 4
      });
      continue;
    }

    const asset = assetCatalog[object.assetId];
    if (!asset) {
      fail(`Level ${level.mapId}, section ${section.sectionId}, object ${object.id} uses unsupported asset ${object.assetId}.`);
    }
    if (object.assetId === "collision-box") {
      const rect = collisionRect(object);
      if (!rect) fail(`Level ${level.mapId}, section ${section.sectionId}, collision ${object.id} has no collision shape.`);
      addCollision(rect);
      continue;
    }

    const imported = asset.imported ? importedAssets.get(object.assetId) : undefined;
    if (asset.imported && !imported) {
      fail(`Level ${level.mapId}, section ${section.sectionId}, object ${object.id} references missing imported asset ${object.assetId}.`);
    }
    let mediaReference;
    let campaignAssetId = object.assetId;
    let sourceAssetId;
    if (imported) {
      const mediaId = `imported-${imported.sha256.slice(0, 24)}`;
      addMedia(media, {
        mediaId,
        file: `${mediaId}.png`,
        kind: "imported",
        assetId: imported.asset_id,
        provenance: {
          author: imported.author,
          source: imported.source,
          sourceFilename: imported.source_filename
        }
      });
      campaignAssetId = "custom-art";
      sourceAssetId = imported.asset_id;
      mediaReference = { mediaId };
    } else {
      mediaReference = addBuiltinMedia(media, object.assetId, asset);
    }

    const typeId = object.type === "terrain-tile" ? "terrain-tile" : object.type;
    if (!["terrain-tile", "wall", "prop", "item", "spawn"].includes(typeId)) {
      fail(`Level ${level.mapId}, section ${section.sectionId}, object ${object.id} has unsupported type ${object.type}.`);
    }
    const properties = {
      assetId: campaignAssetId,
      ...(sourceAssetId ? { sourceAssetId } : {}),
      ...(mediaReference ? { ...mediaReference } : {}),
      ...(mediaReference?.mediaRegion ? { mediaRegion: mediaReference.mediaRegion } : {}),
      ...(asset.size ? { displaySize: { ...asset.size } } : {}),
      ...(asset.pivot && asset.size ? {
        displayOffset: {
          x: asset.size.width / 2 - asset.pivot.x,
          y: asset.size.height / 2 - asset.pivot.y
        }
      } : {}),
      order: Number.isSafeInteger(object.order) ? object.order : objectIndex,
      alpha: asset.alpha ?? 1,
      rotation: 0,
      ...(object.assetId === "item-chest" ? {
        interaction: { tier: object.interaction?.tier === "treasure" ? "treasure" : "normal" }
      } : {})
    };
    objects.push({
      id: object.id,
      typeId,
      position: { ...object.transform },
      properties
    });

    if (object.collision) {
      const rect = collisionRect(object);
      if (!rect) fail(`Level ${level.mapId}, section ${section.sectionId}, object ${object.id} has invalid collision geometry.`);
      addCollision(rect);
    }
  }

  return {
    definition: {
      id: section.sectionId,
      origin: sectionOrigin(section.gridX, section.gridY),
      map: {
        bounds: { ...document.bounds },
        cellSize: CELL_SIZE,
        objects,
        collisions,
        spawns
      }
    },
    document
  };
}

export function createAstraeumCampaign(snapshot, assetCatalog, importedAssetRows = []) {
  if (!snapshot || snapshot.model !== "astraeum-floor-v2" ||
      !Array.isArray(snapshot.levels) || !snapshot.levels.length) {
    fail("Astraeum export requires a nonempty saved campaign snapshot.");
  }
  if (snapshot.levels[0].mapId !== snapshot.startingMapId) {
    fail(`The saved starting level ${snapshot.startingMapId} must be first in the exported campaign.`);
  }

  const importedAssets = new Map(importedAssetRows.map(row => [row.asset_id, row]));
  const media = new Map();
  for (const [assetId, filename] of [
    ["spawn-aries", "aries-idle.png"],
    ["spawn-aries", "aries-north.png"],
    ["spawn-aries", "aries-south.png"],
    ["spawn-aries", "aries-east.png"],
    ["spawn-aries", "aries-west.png"],
    ["item-herb", "herb.png"],
    ["item-amethyst", "amethyst.png"],
    ["item-sapphire", "sapphire.png"]
  ]) {
    const asset = assetCatalog[assetId];
    const source = ASTRAEUM_ARTWORK_PROVENANCE[filename];
    if (!asset || !source) fail(`Required Astraeum media ${filename} has no asset catalog or provenance entry.`);
    const mediaId = mediaIdForFile(filename);
    addMedia(media, {
      mediaId,
      file: filename,
      kind: "builtin",
      provenance: {
        author: source.credit,
        source: source.sourceLocation,
        sourceFilename: source.file
      }
    });
  }

  const levelIds = new Map(snapshot.levels.map((level, index) => [level.mapId, index]));
  let startingSectionId;
  const campaignLevels = snapshot.levels.map((level, levelIndex) => {
    if (level.model !== "astraeum-floor-v2" || !Array.isArray(level.sections) || !level.sections.length) {
      fail(`Level ${campaignLevelLabel(level)} is not a supported Astraeum level with active sections.`);
    }
    const root = [...level.sections, ...(level.archivedSections ?? [])]
      .find(section => section.mapId === level.mapId);
    if (!root || root.document?.id !== level.mapId) {
      fail(`Level ${campaignLevelLabel(level)} is missing its active or archived root boundary/camera metadata.`);
    }
    const positions = level.sections.map(section => ({
      gridX: section.gridX,
      gridY: section.gridY,
      document: section.document
    }));
    const playable = root.document.playableBoundary
      ? playableBoundaryCells(root.document.playableBoundary, positions)
      : defaultBoundaryCells(positions);
    const converted = level.sections.map(section => {
      const converted = sectionMap(level, section, assetCatalog, importedAssets, media);
      const origin = sectionOrigin(section.gridX, section.gridY);
      const grid = floorDocumentGrid(converted.document, assetCatalog);
      const blocked = blockedSectionCells(converted.document.bounds, origin, playable, grid);
      for (const rectangle of cellRectangles(blocked)) {
        const rect = {
          x: rectangle.x * CELL_SIZE,
          y: rectangle.y * CELL_SIZE,
          width: rectangle.width * CELL_SIZE,
          height: rectangle.height * CELL_SIZE
        };
        const nextCollisionIndex = converted.definition.map.collisions.length + 1;
        const generated = collisionObject(rect, nextCollisionIndex);
        let objectId = generated.object.id;
        let collisionId = generated.collision.id;
        while (converted.definition.map.objects.some(object => object.id === objectId)) {
          objectId = `${objectId}-x`;
        }
        while (converted.definition.map.collisions.some(collision => collision.id === collisionId)) {
          collisionId = `${collisionId}-x`;
        }
        generated.object.id = objectId;
        generated.collision.objectId = objectId;
        generated.collision.id = collisionId;
        converted.definition.map.objects.push(generated.object);
        converted.definition.map.collisions.push(generated.collision);
      }
      if (section.document.objects.some(object => object.assetId === "spawn-aries")) {
        if (levelIndex === 0 && !startingSectionId) startingSectionId = section.sectionId;
      }
      return { ...converted, blocked };
    });
    const starts = converted.flatMap(({ definition }) => definition.map.spawns.map(spawn => ({
      x: definition.origin.x + spawn.position.x, y: definition.origin.y + spawn.position.y
    })));
    if (starts.length !== 1) fail(`Level ${campaignLevelLabel(level)} requires exactly one active Aries start.`);
    const blockers = converted.flatMap(({ document, definition }) =>
      document.objects.map(collisionRect).filter(Boolean).map(rect => ({
        ...rect, x: rect.x + definition.origin.x, y: rect.y + definition.origin.y
      })));
    const slimes = converted.flatMap(({ document, definition }) =>
      document.objects.filter(object => object.assetId === "spawn-slime").map(object => ({
        x: object.transform.x + definition.origin.x, y: object.transform.y + 8 + definition.origin.y
      })));
    let reserved = false;
    const candidates = [...converted].sort((a, b) =>
      Number(b.definition.map.spawns.length > 0) - Number(a.definition.map.spawns.length > 0));
    reserve: for (const { definition, blocked } of candidates) {
      for (let y = 0; y < definition.map.bounds.height / CELL_SIZE; y++) {
        for (let x = 0; x < definition.map.bounds.width / CELL_SIZE; x++) {
          if (blocked.has(`${x},${y}`)) continue;
          const local = { x: x * CELL_SIZE + CELL_SIZE / 2, y: y * CELL_SIZE + CELL_SIZE / 2 };
          const point = { x: definition.origin.x + local.x, y: definition.origin.y + local.y };
          if (starts.some(start => Math.hypot(start.x - point.x, start.y - point.y) < 32)) continue;
          if (blockers.some(rect => {
            const nearestX = Math.max(rect.x, Math.min(point.x, rect.x + rect.width));
            const nearestY = Math.max(rect.y, Math.min(point.y, rect.y + rect.height));
            return (point.x - nearestX) ** 2 + (point.y - nearestY) ** 2 < 14 ** 2;
          })) continue;
          if (slimes.some(slime => Math.hypot(slime.x - point.x, slime.y - point.y) < 26)) continue;
          if (level.mapId === snapshot.startingMapId && definition.map.spawns.length === 0) {
            fail(`Starting level ${campaignLevelLabel(level)} has a safe reserved start in another section, but Engine kit 0.5.0 requires two player starts in the starting section. Add a safe cell there before exporting.`);
          }
          definition.map.spawns.push({ id: "reserved-player-spawn", kind: "player", position: local, radius: 4 });
          reserved = true;
          break reserve;
        }
      }
    }
    if (!reserved) fail(`Level ${campaignLevelLabel(level)} has no safe cell for the reserved multiplayer start.`);
    const convertedSections = converted.map(section => section.definition);
    const origin = sectionOrigin(root.gridX, root.gridY);
    const allOrigins = [
      ...level.sections,
      ...(!level.sections.some(section => section.mapId === level.mapId) ? [root] : [])
    ].map(section => ({
      origin: sectionOrigin(section.gridX, section.gridY),
      bounds: section.document.bounds
    }));
    const left = Math.min(...allOrigins.map(section => section.origin.x));
    const top = Math.min(...allOrigins.map(section => section.origin.y));
    const right = Math.max(...allOrigins.map(section => section.origin.x + section.bounds.width));
    const bottom = Math.max(...allOrigins.map(section => section.origin.y + section.bounds.height));
    const exits = [];
    for (const section of level.sections) {
      for (const object of section.document.objects.filter(item => item.assetId === "prop-stairs-rune")) {
        const path = `Level ${campaignLevelLabel(level)}, section ${section.sectionId}, stairs rune ${object.id}`;
        const destination = object.exit;
        if (!destination?.levelId || !destination.sectionId || !destination.startId) {
          fail(`${path} has no complete active exit destination. Choose a next level and Aries start in the Inspector, then save; Studio will not infer this connection.`);
        }
        const destinationIndex = levelIds.get(destination.levelId);
        if (destinationIndex !== levelIndex + 1) {
          fail(`${path} must lead to the next active campaign level in the authored route; branching, backward, missing and cross-project exits are unsupported.`);
        }
        const target = snapshot.levels[destinationIndex];
        const targetSection = target?.sections.find(candidate => candidate.sectionId === destination.sectionId);
        if (!targetSection || !targetSection.document.objects.some(start =>
          start.id === destination.startId && start.assetId === "spawn-aries")) {
          fail(`${path} targets missing, archived, deleted, or non-Aries start ${destination.levelId}/${destination.sectionId}/${destination.startId}.`);
        }
        exits.push({
          id: `exit-${section.sectionId}-${object.id}`,
          sectionId: section.sectionId,
          objectId: object.id,
          destination: {
            levelId: destination.levelId,
            sectionId: destination.sectionId,
            startId: destination.startId
          }
        });
      }
    }
    if (levelIndex < snapshot.levels.length - 1 && exits.length === 0) {
      fail(`Level ${campaignLevelLabel(level)} has no active stairs rune for the next campaign level. Add a rune and ` +
        `choose the next active level, section, and Aries start in the Inspector, then save; Studio will not infer or ` +
        `create exits.`);
    }
    return {
      id: level.mapId,
      name: root.document.name,
      map: {
        formatVersion: 1,
        id: `${level.mapId}-world`,
        name: root.document.name,
        cellSize: CELL_SIZE,
        sections: convertedSections
      },
      boundary: { x: left, y: top, width: right - left, height: bottom - top },
      camera: {
        x: origin.x + root.document.bounds.width / 2,
        y: origin.y + root.document.bounds.height / 2,
        zoom: root.document.cameraZoom ?? 1
      },
      exits
    };
  });

  if (!startingSectionId) {
    fail(`Starting level ${campaignLevelLabel(snapshot.levels[0])} has no active authored Aries start.`);
  }
  return {
    campaign: {
      schemaVersion: 1,
      startingLevelId: snapshot.startingMapId,
      startingSectionId,
      settings: { playerSpeed: 2 },
      levels: campaignLevels
    },
    media
  };
}
