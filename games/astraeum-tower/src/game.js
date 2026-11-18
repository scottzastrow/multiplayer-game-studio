import { moveActor, isActorBlocked } from "./tilemap-adapter.js";
import {
  DEFAULT_FLOOR_DOCUMENT,
  collisionRects,
  createFloorMap,
  floorDocumentGrid
} from "./project.js";
import { ASSET_CATALOG } from "./catalog.js";

const ORIGINAL_PLAYER_SPEED = 2;
const PLAYER_WALL_FACE_PX = 12;
const PLAYER_GEOMETRY_RADIUS = 4;
const PLAYER_HALF_WIDTH = 9;
const PLAYER_HALF_HEIGHT = 8;
const PLAYER_HP = 500;
const PLAYER_INVULNERABILITY_FRAMES = 50;
const PLAYER_STAMINA = 100;
const DODGE = Object.freeze({
  durationFrames: 14,
  initialSpeed: 6.2,
  staminaCost: 34,
  cooldownFrames: 6,
  staminaRegenPerFrame: 0.9,
  staminaRegenDelayFrames: 30
});
const HALBERD = Object.freeze({
  damage: 20,
  range: 50,
  arc: 2.3,
  cooldownFrames: 34,
  knockback: 4
});
const SLIME = Object.freeze({
  hp: 36,
  speed: 1,
  damage: 12,
  radius: 12,
  aggro: 230,
  hopPeriod: 64,
  hopFrames: 26,
  hopMultiplier: 2.3
});
const DIRECTIONS = Object.freeze({
  north: Object.freeze({ x: 0, y: -1 }),
  south: Object.freeze({ x: 0, y: 1 }),
  west: Object.freeze({ x: -1, y: 0 }),
  east: Object.freeze({ x: 1, y: 0 })
});
const SLIME_COLORS = Object.freeze(["#a6ee82", "#5fc85a", "#3a9440"]);
const ITEM_LABELS = Object.freeze({
  herb: "Healing Herb",
  mushroom: "Glowcap",
  amethyst: "Amethyst",
  sapphire: "Sapphire",
  ruby: "Ruby",
  emerald: "Emerald",
  mana: "Mana Crystal",
  gold: "gold"
});
const ITEM_COLORS = Object.freeze({
  herb: "#7fe06a",
  mushroom: "#5fe0d8",
  amethyst: "#b98af0",
  sapphire: "#5f9ff5",
  ruby: "#ff5a6a",
  emerald: "#4fe08a",
  mana: "#6ff0ff",
  gold: "#ffd84a"
});
const GEM_ITEMS = new Set(["amethyst", "sapphire", "ruby", "emerald", "mana"]);
const NORMAL_CHEST_ITEMS = Object.freeze([
  "herb", "herb", "mushroom", "amethyst", "amethyst", "sapphire", "ruby", "emerald"
]);
const TREASURE_CHEST_ITEMS = Object.freeze([
  "herb", "sapphire", "ruby", "emerald", "mana", "mana", "amethyst"
]);

export const towerSettings = Object.freeze({ playerSpeed: ORIGINAL_PLAYER_SPEED });
export function createTowerInteractionState() {
  return {
    collected: new Set(),
    openedChests: new Set(),
    inventory: { herb: 0, mushroom: 0, amethyst: 0, sapphire: 0, ruby: 0, emerald: 0, mana: 0, gold: 0 },
    items: [],
    drops: []
  };
}

export const towerEncounterTuning = Object.freeze({
  playerHp: PLAYER_HP,
  invulnerabilityFrames: PLAYER_INVULNERABILITY_FRAMES,
  dodge: DODGE,
  stamina: PLAYER_STAMINA,
  halberd: HALBERD,
  slime: SLIME
});

function distance(leftX, leftY, rightX, rightY) {
  return Math.hypot(rightX - leftX, rightY - leftY);
}

function angleDifference(left, right) {
  let difference = left - right;
  while (difference > Math.PI) difference -= Math.PI * 2;
  while (difference < -Math.PI) difference += Math.PI * 2;
  return Math.abs(difference);
}

function normalizedVector(x, y) {
  const magnitude = Math.hypot(x, y);
  return magnitude ? { x: x / magnitude, y: y / magnitude } : null;
}

function facingForVector(x, y) {
  if (Math.abs(x) > Math.abs(y)) return x < 0 ? "west" : "east";
  return y < 0 ? "north" : "south";
}

function publicPlayer(player) {
  return {
    accountId: player.accountId,
    username: player.username,
    x: player.x,
    y: player.y,
    hp: player.hp,
    maxHp: player.maxHp,
    invulnerabilityFrames: player.invulnerabilityFrames,
    stamina: player.stamina,
    dodgeFrames: player.dodgeFrames,
    dodgeCooldownFrames: player.dodgeCooldownFrames,
    dodgeX: player.dodgeX,
    dodgeY: player.dodgeY,
    staminaRegenDelayFrames: player.staminaRegenDelayFrames,
    facing: player.facing,
    moving: player.moving,
    frame: player.frame,
    attack: player.attack ? { angle: player.attack.angle, frame: player.attack.frame } : null,
    attackCooldownFrames: player.attackCooldownFrames,
    aimX: player.aimX,
    aimY: player.aimY
  };
}

function publicSlime(slime) {
  return {
    id: slime.id,
    x: slime.x,
    y: slime.y,
    hp: slime.hp,
    maxHp: slime.maxHp,
    radius: slime.radius,
    state: slime.state,
    hopFrames: slime.hopFrames,
    flashFrames: slime.flashFrames,
    facing: slime.facing
  };
}

function validActorPosition(grid, blockers, position) {
  if (isActorBlocked(grid, position, {
    halfWidth: PLAYER_HALF_WIDTH,
    halfHeight: PLAYER_HALF_HEIGHT,
    wallFacePx: PLAYER_WALL_FACE_PX
  })) return false;
  return !blockers.some(rect =>
    position.x + PLAYER_HALF_WIDTH > rect.x &&
    position.x - PLAYER_HALF_WIDTH < rect.x + rect.width &&
    position.y > rect.y &&
    position.y - PLAYER_HALF_HEIGHT < rect.y + rect.height);
}

function moveConnectedActor(geometry, feet, delta, {
  radius = PLAYER_GEOMETRY_RADIUS,
  halfWidth = 0,
  halfHeight = 0,
  blockers = []
} = {}) {
  let position = { ...feet };
  for (const axis of ["x", "y"]) {
    const change = delta[axis];
    if (!change) continue;
    const candidate = { ...position, [axis]: position[axis] + change };
    const overlapsBlocker = blockers.some(rect =>
      candidate.x + halfWidth > rect.x && candidate.x - halfWidth < rect.x + rect.width &&
      candidate.y > rect.y && candidate.y - halfHeight < rect.y + rect.height);
    if (overlapsBlocker) continue;
    const center = { x: position.x, y: position.y - 4 };
    const movement = axis === "x" ? { x: change, y: 0 } : { x: 0, y: change };
    const moved = geometry.moveCircle(center, movement, radius);
    position = { x: moved.x, y: moved.y + 4 };
  }
  return position;
}

export function createTowerGameModule(project = DEFAULT_FLOOR_DOCUMENT, assetCatalog = ASSET_CATALOG,
  connectedWorld = null) {
  const grid = floorDocumentGrid(project, assetCatalog);
  const sections = connectedWorld?.sections ?? null;
  const map = sections ? (() => {
    const bounds = sections.reduce((result, section) => ({
      x: Math.min(result.x, section.origin.x),
      y: Math.min(result.y, section.origin.y),
      right: Math.max(result.right, section.origin.x + section.document.bounds.width),
      bottom: Math.max(result.bottom, section.origin.y + section.document.bounds.height)
    }), {
      x: sections[0].origin.x,
      y: sections[0].origin.y,
      right: sections[0].origin.x + sections[0].document.bounds.width,
      bottom: sections[0].origin.y + sections[0].document.bounds.height
    });
    return { bounds: { width: bounds.right - bounds.x, height: bounds.bottom - bounds.y }, spawns: [] };
  })() : createFloorMap(project, assetCatalog);
  const blockers = sections
    ? sections.flatMap(section => collisionRects(section.document).map(rect => ({
      ...rect, x: rect.x + section.origin.x, y: rect.y + section.origin.y
    })))
    : collisionRects(project);
  const slimeSpawns = (sections
    ? sections.flatMap(section => section.document.objects
      .filter(object => object.assetId === "spawn-slime")
      .map(object => ({
        ...object,
        id: `${section.sectionId}:${object.id}`,
        transform: { x: object.transform.x + section.origin.x, y: object.transform.y + section.origin.y }
      })))
    : project.objects.filter(object => object.assetId === "spawn-slime"))
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  const exits = (sections ?? [{ sectionId: project.id, origin: { x: 0, y: 0 }, document: project }])
    .flatMap(section => section.document.objects.filter(object => object.assetId === "prop-stairs-rune")
      .map(object => ({
        id: `${section.sectionId}:${object.id}`,
        x: section.origin.x + object.transform.x,
        y: section.origin.y + object.transform.y + 8,
        destination: object.exit ? { ...object.exit } : null
      })));
  const levelMapId = connectedWorld?.mapId ?? project.id;
  const interactiveObjects = (sections ?? [
    { sectionId: project.id, origin: { x: 0, y: 0 }, document: project }
  ]).flatMap(section => section.document.objects.flatMap(object => {
    const capability = assetCatalog[object.assetId]?.interaction;
    if (!capability) return [];
    return [{
      id: JSON.stringify([levelMapId, section.sectionId, object.id]),
      sectionId: section.sectionId,
      assetId: object.assetId,
      kind: capability.kind,
      item: capability.item ?? null,
      planted: Boolean(capability.planted),
      tier: object.interaction?.tier ?? capability.defaultTier ?? "normal",
      transform: {
        x: object.transform.x + section.origin.x,
        y: object.transform.y + section.origin.y
      }
    }];
  }));
  const nearbyExit = player => player ? exits
    .filter(exit => distance(player.x, player.y, exit.x, exit.y) < 40)
    .sort((a, b) => distance(player.x, player.y, a.x, a.y) -
      distance(player.x, player.y, b.x, b.y) || a.id.localeCompare(b.id))[0] ?? null : null;

  return Object.freeze({
    metadata: Object.freeze({
      id: "astraeum-tower-floor-one",
      version: "1.3.0",
      stateSchemaVersion: 3
    }),

    validateSettings(settings) {
      return typeof settings === "object" && settings !== null &&
        settings.playerSpeed === ORIGINAL_PLAYER_SPEED;
    },

    create(context, settings, roster) {
      const interactionState = connectedWorld?.interactionState ?? createTowerInteractionState();
      const inventoryKinds = Object.keys(ITEM_LABELS);
      if (!(interactionState.collected instanceof Set) ||
          !(interactionState.openedChests instanceof Set) ||
          !Array.isArray(interactionState.items) || !Array.isArray(interactionState.drops) ||
          !interactionState.inventory ||
          inventoryKinds.some(kind => !Object.hasOwn(interactionState.inventory, kind) ||
            !Number.isInteger(interactionState.inventory[kind]) || interactionState.inventory[kind] < 0) ||
          Object.keys(interactionState.inventory).some(kind => !inventoryKinds.includes(kind))) {
        throw new Error("Invalid Tower Play interaction state.");
      }
      for (const object of interactiveObjects) {
        if (object.kind !== "pickup" || interactionState.collected.has(object.id) ||
            interactionState.items.some(item => item.id === object.id)) continue;
        interactionState.items.push({
          id: object.id,
          mapId: levelMapId,
          sectionId: object.sectionId,
          assetId: object.assetId,
          kind: object.item,
          x: object.transform.x,
          y: object.transform.y,
          planted: object.planted,
          delay: 0,
          height: 0,
          verticalVelocity: 0,
          vx: 0,
          vy: 0
        });
      }
      const inputs = new Map(roster.map(player => [
        player.accountId,
        {
          movement: { x: 0, y: 0 },
          aim: null,
          attackHeld: false,
          attackPressed: false,
          dodgeHeld: false,
          dodgePressed: false,
          dodgeDirection: null,
          useHerbPressed: false
        }
      ]));
      const players = new Map();
      const occupiedExits = new Map();
      const slimes = slimeSpawns.map(spawn => ({
        id: spawn.id,
        x: spawn.transform.x,
        y: spawn.transform.y + 8,
        hp: SLIME.hp,
        maxHp: SLIME.hp,
        radius: SLIME.radius,
        t: 0,
        state: "idle",
        hopFrames: 0,
        hopX: 0,
        hopY: 0,
        flashFrames: 0,
        vx: 0,
        vy: 0,
        facing: "west"
      }));
      const effects = [];
      let tick = 0;
      let damageDealt = 0;
      let damageTaken = 0;
      let slimesDefeated = 0;
      let dodgesStarted = 0;
      let eventSequence = 0;
      let lastEvent = { sequence: 0, type: "ready" };
      let exitRequest = null;
      let exitSequence = 0;

      function recordEvent(type, player, slime, amount) {
        lastEvent = {
          sequence: ++eventSequence,
          type,
          accountId: player?.accountId ?? null,
          targetId: slime?.id ?? null,
          amount
        };
      }

      function addDamageText(x, y, value, color) {
        effects.push({ kind: "text", x, y, value: String(value), color, life: 45, maxLife: 45 });
      }

      function addParticles(x, y, count, colors, speed) {
        for (let index = 0; index < count; index += 1) {
          const angle = index * Math.PI * 2 / count;
          const velocity = speed * (0.65 + (index % 3) * 0.2);
          effects.push({
            kind: "particle",
            x,
            y,
            vx: Math.cos(angle) * velocity,
            vy: Math.sin(angle) * velocity - 0.5,
            color: colors[index % colors.length],
            size: index % 3 === 0 ? 3 : 2,
            life: 24 + index % 5,
            maxLife: 24 + index % 5
          });
        }
        if (effects.length > 100) effects.splice(0, effects.length - 100);
      }

      const random = () => context.random?.next?.() ?? 0.5;
      const chestObjects = interactiveObjects.filter(object => object.kind === "chest");
      const unopenedChests = new Map(chestObjects
        .filter(chest => !interactionState.openedChests.has(chest.id))
        .map(chest => [chest.id, chest]));

      function giveItem(player, kind, amount, itemId) {
        interactionState.inventory[kind] += amount;
        const label = kind === "gold" ? `${amount} gold` :
          `+${amount} ${ITEM_LABELS[kind] ?? kind}`;
        addDamageText(player.x, player.y - 62, label, ITEM_COLORS[kind] ?? "#ffffff");
        recordEvent(kind === "gold" ? "gold-collected" : "item-collected", player, null, amount);
        if (itemId) interactionState.collected.add(itemId);
      }

      function openChest(player) {
        let chest = null;
        let nearestDistance = 46;
        for (const candidate of unopenedChests.values()) {
          const candidateDistance = distance(
            player.x, player.y, candidate.transform.x, candidate.transform.y
          );
          if (candidateDistance < nearestDistance ||
              (chest && candidateDistance === nearestDistance &&
                candidate.id.localeCompare(chest.id) < 0)) {
            chest = candidate;
            nearestDistance = candidateDistance;
          }
        }
        if (!chest) return false;
        unopenedChests.delete(chest.id);
        interactionState.openedChests.add(chest.id);
        const treasure = chest.tier === "treasure";
        const count = (treasure ? 4 : 2) + Math.floor(random() * 3);
        const pool = treasure ? TREASURE_CHEST_ITEMS : NORMAL_CHEST_ITEMS;
        for (let index = 0; index < count; index += 1) {
          const angle = -Math.PI / 2 + (index - (count - 1) / 2) * 0.6;
          interactionState.drops.push({
            id: JSON.stringify([chest.id, "item", index]),
            mapId: levelMapId,
            sectionId: chest.sectionId,
            kind: pool[Math.floor(random() * pool.length)],
            value: 1,
            x: chest.transform.x,
            y: chest.transform.y - 14,
            vx: Math.cos(angle) * 1.4,
            vy: Math.sin(angle) * 0.6 + 0.9,
            height: 0.01,
            verticalVelocity: -3.2,
            delay: 30
          });
        }
        const gold = Math.max(1, Math.round(12 * (0.8 + random() * 0.5) *
          (treasure ? 2.5 : 1)));
        const goldCount = Math.min(10, Math.max(1, Math.ceil(gold / 6)));
        for (let index = 0; index < goldCount; index += 1) {
          const angle = random() * Math.PI * 2;
          interactionState.drops.push({
            id: JSON.stringify([chest.id, "gold", index]),
            mapId: levelMapId,
            sectionId: chest.sectionId,
            kind: "gold",
            value: Math.floor(gold / goldCount) + Number(index < gold % goldCount),
            x: chest.transform.x,
            y: chest.transform.y - 14,
            vx: Math.cos(angle) * (0.6 + random()),
            vy: Math.sin(angle) * 0.8 + 0.5,
            height: 0.01,
            verticalVelocity: -3.2,
            delay: 30
          });
        }
        addParticles(chest.transform.x, chest.transform.y - 18, 20,
          ["#ffe39a", "#ffffff", "#f3c45a"], 1.8);
        addDamageText(chest.transform.x, chest.transform.y - 40, "Chest opened!", "#f3c45a");
        recordEvent("chest-opened", player, null, gold);
        return true;
      }

      function useHerb(player) {
        if (interactionState.inventory.herb <= 0) {
          addDamageText(player.x, player.y - 64, "No healing herbs", "#a79cbf");
          recordEvent("herb-unavailable", player, null, 0);
          return;
        }
        if (player.hp >= player.maxHp) {
          addDamageText(player.x, player.y - 64, "HP is full", "#a79cbf");
          recordEvent("herb-full-health", player, null, 0);
          return;
        }
        interactionState.inventory.herb -= 1;
        const before = player.hp;
        player.hp = Math.min(player.maxHp, player.hp + 30);
        addDamageText(player.x, player.y - 64, `+${player.hp - before} HP`, ITEM_COLORS.herb);
        addParticles(player.x, player.y - 24, 12, [ITEM_COLORS.herb, "#ffffff"], 1.6);
        recordEvent("herb-used", player, null, player.hp - before);
      }

      function closestPlayer(item, alivePlayers) {
        return alivePlayers
          .map(player => ({ player, distance: distance(item.x, item.y, player.x, player.y - 10) }))
          .sort((left, right) => left.distance - right.distance ||
            left.player.accountId.localeCompare(right.player.accountId))[0] ?? null;
      }

      function updateItem(item, alivePlayers) {
        if (item.delay > 0) {
          item.delay -= 1;
          if (item.height > 0) {
            item.x += item.vx;
            item.y += item.vy;
            item.height -= item.verticalVelocity;
            item.verticalVelocity += 0.22;
            if (item.height <= 0) {
              item.height = 0;
              item.verticalVelocity = 0;
              item.vx = 0;
              item.vy = 0;
            }
          }
          return false;
        }
        const nearest = closestPlayer(item, alivePlayers);
        if (!nearest) return false;
        const { player } = nearest;
        const pickupDistance = item.planted ? 26 : item.kind === "gold" ? 16 : 16;
        const magnetDistance = item.planted ? 0 : item.kind === "gold" ? 90 : 64;
        if (magnetDistance && nearest.distance < magnetDistance && nearest.distance > 1) {
          const speed = item.kind === "gold" ? 3.4 : 2.6;
          item.x += (player.x - item.x) / nearest.distance * speed;
          item.y += (player.y - 10 - item.y) / nearest.distance * speed;
        }
        const finalDistance = distance(item.x, item.y, player.x, player.y - 10);
        if (finalDistance >= pickupDistance) return false;
        giveItem(player, item.kind, item.value ?? 1, item.id);
        return true;
      }

      function updateInteractions(alivePlayers) {
        for (const player of alivePlayers) {
          if (unopenedChests.size) openChest(player);
          if (player.inputs.useHerbPressed) useHerb(player);
          player.inputs.useHerbPressed = false;
        }
        for (let index = interactionState.items.length - 1; index >= 0; index -= 1) {
          const item = interactionState.items[index];
          if (item.mapId !== levelMapId) continue;
          if (updateItem(item, alivePlayers)) interactionState.items.splice(index, 1);
        }
        for (let index = interactionState.drops.length - 1; index >= 0; index -= 1) {
          const item = interactionState.drops[index];
          if (item.mapId !== levelMapId) continue;
          if (updateItem(item, alivePlayers)) interactionState.drops.splice(index, 1);
        }
      }

      function interactionSnapshot() {
        const chests = chestObjects.map(chest => ({
          id: chest.id,
          assetId: chest.assetId,
          tier: chest.tier,
          transform: { ...chest.transform },
          opened: interactionState.openedChests.has(chest.id)
        }));
        const items = [...interactionState.items, ...interactionState.drops]
          .filter(item => item.mapId === levelMapId)
          .map(item => ({ id: item.id, assetId: item.assetId ?? null, kind: item.kind,
            value: item.value ?? 1, x: item.x, y: item.y, height: item.height ?? 0 }));
        return { chests, items };
      }

      function getSpawnPosition(index, occupied) {
        if (sections) {
          const resolved = context.connectedMapSpawns ?? [];
          const primary = resolved.find(spawn => spawn.qualifiedId === connectedWorld.primaryStartId);
          if (!primary) throw new Error("The authored Aries start was not resolved. Select an active player start before Play.");
          const candidates = [
            ...(primary ? [primary] : []),
            ...resolved.filter(spawn => spawn !== primary && spawn.kind === "player")
          ];
          for (const spawn of candidates) {
            const candidate = { x: spawn.position.x, y: spawn.position.y + 8 };
            const blocked = [-5, 0, 5].some(offset =>
              !context.geometry.isWalkable(candidate.x + offset, candidate.y - 4, PLAYER_GEOMETRY_RADIUS)) ||
              blockers.some(rect => candidate.x + PLAYER_HALF_WIDTH > rect.x &&
                candidate.x - PLAYER_HALF_WIDTH < rect.x + rect.width &&
                candidate.y > rect.y && candidate.y - PLAYER_HALF_HEIGHT < rect.y + rect.height);
            if (spawn === primary && blocked) {
              throw new Error("The authored Aries arrival is blocked or outside the playable boundary. Move that start or remove its blocker; no replacement start was used.");
            }
            if (spawn === primary && connectedWorld.strictArrival && slimes.some(slime =>
              distance(candidate.x, candidate.y - 20, slime.x, slime.y - 11) < slime.radius + 14)) {
              throw new Error("The destination Aries start overlaps an authored slime's contact range. Move the start or slime before using this exit.");
            }
            if (!blocked && !occupied.some(position =>
              distance(candidate.x, candidate.y, position.x, position.y) < 32)) return candidate;
          }
          throw new Error("The connected Tower world has no safe resolved player start for this roster.");
        }
        const candidates = [
          ...map.spawns.map(spawn => ({ x: spawn.position.x, y: spawn.position.y + 8 })),
          ...grid.flatMap((row, y) => [...row].flatMap((cell, x) =>
            cell === "#" ? [] : [{ x: x * 32 + 16, y: y * 32 + 24 }]))
        ];
        for (const candidate of candidates) {
          if (!validActorPosition(grid, blockers, candidate) ||
              occupied.some(position => distance(candidate.x, candidate.y, position.x, position.y) < 32)) continue;
          return candidate;
        }
        throw new Error("The Tower map has no safe player start for this roster.");
      }

      const moveActorForGame = (feet, delta, options) => sections
        ? moveConnectedActor(context.geometry, feet, delta, { ...options, blockers })
        : moveActor(context.geometry, grid, feet, delta, { ...options, blockers });

      function entityId(player) {
        return `player:${player.accountId}`;
      }

      function updatePlayerEntity(player) {
        context.entities.update(entityId(player), entity => ({
          ...entity,
          position: { x: player.x, y: player.y - 4 },
          state: { kind: "player", accountId: player.accountId, hp: player.hp }
        }));
      }

      function startAttack(player, aliveSlimes) {
        let angle = Math.atan2(player.aimY, player.aimX);
        let nearestAngle = null;
        let nearestDistance = Infinity;
        for (const slime of aliveSlimes) {
          const centerY = slime.y - 11;
          const range = HALBERD.range + 24 + slime.radius;
          const targetDistance = distance(player.x, player.y - 20, slime.x, centerY);
          const targetAngle = Math.atan2(centerY - (player.y - 20), slime.x - player.x);
          if (targetDistance > range ||
              (targetDistance > 20 + slime.radius && angleDifference(targetAngle, angle) > 1.4)) continue;
          if (targetDistance < nearestDistance) {
            nearestAngle = targetAngle;
            nearestDistance = targetDistance;
          }
        }
        if (nearestAngle !== null) angle = nearestAngle;
        player.attackCooldownFrames = HALBERD.cooldownFrames;
        player.attack = {
          angle,
          frame: 0,
          thrustHits: new Set(),
          sweepHits: new Set()
        };
      }

      function damageSlime(player, slime, damage, directionX, directionY) {
        if (slime.hp <= 0) return;
        const applied = Math.min(slime.hp, damage);
        slime.hp -= applied;
        slime.flashFrames = 6;
        slime.state = "chase";
        slime.vx += directionX * HALBERD.knockback;
        slime.vy += directionY * HALBERD.knockback;
        damageDealt += applied;
        addDamageText(slime.x, slime.y - 34, applied, "#ffffff");
        addParticles(slime.x, slime.y - 14, 7, ["#ffffff", "#ffe39a"], 2.3);
        recordEvent(slime.hp === 0 ? "slime-defeated" : "slime-hit", player, slime, applied);
        if (slime.hp === 0) {
          slimesDefeated += 1;
          addParticles(slime.x, slime.y - 14, 16, SLIME_COLORS, 3);
        }
      }

      function strike(player, slime, angle, range, mode, hitSet, damage) {
        if (slime.hp <= 0 || hitSet.has(slime.id)) return;
        const originX = player.x;
        const originY = player.y - 20;
        const centerX = slime.x;
        const centerY = slime.y - 11;
        const dx = centerX - originX;
        const dy = centerY - originY;
        const targetDistance = Math.hypot(dx, dy);
        const feetDistance = distance(player.x, player.y, slime.x, slime.y);
        if (targetDistance > range + slime.radius + 6 &&
            feetDistance > range + slime.radius) return;
        if (targetDistance > 20 + slime.radius) {
          if (mode === "arc") {
            const slack = Math.atan2(slime.radius + 8, Math.max(targetDistance, 1));
            if (angleDifference(Math.atan2(dy, dx), angle) > HALBERD.arc / 2 + slack) return;
          } else {
            const ux = Math.cos(angle);
            const uy = Math.sin(angle);
            const along = dx * ux + dy * uy;
            const perpendicular = Math.abs(dx * uy - dy * ux);
            if (along < -slime.radius || perpendicular > slime.radius + 10) return;
          }
        }
        hitSet.add(slime.id);
        damageSlime(player, slime, damage,
          targetDistance ? dx / targetDistance : Math.cos(angle),
          targetDistance ? dy / targetDistance : Math.sin(angle));
      }

      function updateAttack(player, aliveSlimes) {
        if (player.attackCooldownFrames > 0) player.attackCooldownFrames -= 1;
        if ((player.inputs.attackPressed || player.inputs.attackHeld) &&
            player.attackCooldownFrames === 0 && !player.attack) {
          startAttack(player, aliveSlimes);
        }
        player.inputs.attackPressed = false;
        const attack = player.attack;
        if (!attack) return;
        attack.frame += 1;
        if (attack.frame <= 6) {
          for (const slime of aliveSlimes) {
            strike(player, slime, attack.angle, HALBERD.range + 6, "thrust",
              attack.thrustHits, HALBERD.damage / 2);
          }
        }
        if (attack.frame >= 9 && attack.frame <= 14) {
          for (const slime of aliveSlimes) {
            strike(player, slime, attack.angle, HALBERD.range, "arc",
              attack.sweepHits, HALBERD.damage);
          }
        }
        if (attack.frame >= 21) player.attack = null;
      }

      function damagePlayer(player, slime) {
        if (player.invulnerabilityFrames > 0 || player.dodgeFrames > 0) return;
        player.hp = Math.max(0, player.hp - SLIME.damage);
        player.invulnerabilityFrames = PLAYER_INVULNERABILITY_FRAMES;
        const dx = player.x - slime.x;
        const dy = player.y - slime.y;
        const magnitude = Math.hypot(dx, dy) || 1;
        player.knockbackX += dx / magnitude * 5;
        player.knockbackY += dy / magnitude * 5;
        damageTaken += SLIME.damage;
        addDamageText(player.x, player.y - 60, `-${SLIME.damage}`, "#ff6a7a");
        addParticles(player.x, player.y - 24, 8, ["#ff5a6a", "#ffffff"], 2.1);
        recordEvent("player-damaged", player, slime, SLIME.damage);
      }

      function updateSlimes(alivePlayers) {
        for (const slime of slimes) {
          if (slime.hp <= 0) continue;
          slime.t += 1;
          if (slime.flashFrames > 0) slime.flashFrames -= 1;
          let target = null;
          let targetDistance = Infinity;
          for (const player of alivePlayers) {
            const candidateDistance = distance(slime.x, slime.y, player.x, player.y);
            if (candidateDistance < targetDistance) {
              target = player;
              targetDistance = candidateDistance;
            }
          }
          if (target && targetDistance < SLIME.aggro) slime.state = "chase";
          if (target && Math.abs(target.x - slime.x) > 0.2) {
            slime.facing = target.x < slime.x ? "west" : "east";
          }

          if (target && slime.state === "chase") {
            if (slime.hopFrames <= 0 && slime.t % SLIME.hopPeriod === 0) {
              const magnitude = targetDistance || 1;
              slime.hopFrames = SLIME.hopFrames;
              slime.hopX = (target.x - slime.x) / magnitude;
              slime.hopY = (target.y - slime.y) / magnitude;
            }
            if (slime.hopFrames > 0) {
              slime.hopFrames -= 1;
              const next = moveActorForGame({ x: slime.x, y: slime.y }, {
                x: slime.hopX * SLIME.speed * SLIME.hopMultiplier,
                y: slime.hopY * SLIME.speed * SLIME.hopMultiplier
              }, {
                radius: PLAYER_GEOMETRY_RADIUS,
                halfWidth: 11,
                halfHeight: 8,
                wallFacePx: PLAYER_WALL_FACE_PX
              });
              slime.x = next.x;
              slime.y = next.y;
            }
          }

          if (slime.vx || slime.vy) {
            const next = moveActorForGame({ x: slime.x, y: slime.y }, {
              x: slime.vx,
              y: slime.vy
            }, {
              radius: PLAYER_GEOMETRY_RADIUS,
              halfWidth: 11,
              halfHeight: 8,
              wallFacePx: PLAYER_WALL_FACE_PX
            });
            slime.x = next.x;
            slime.y = next.y;
            slime.vx *= 0.75;
            slime.vy *= 0.75;
            if (Math.abs(slime.vx) < 0.05) slime.vx = 0;
            if (Math.abs(slime.vy) < 0.05) slime.vy = 0;
          }

          const centerY = slime.y - 11;
          for (const player of alivePlayers) {
            if (distance(slime.x, centerY, player.x, player.y - 20) < slime.radius + 14) {
              damagePlayer(player, slime);
            }
          }
        }
      }

      function updateEffects() {
        for (const effect of effects) {
          effect.life -= 1;
          if (effect.kind === "particle") {
            effect.x += effect.vx;
            effect.y += effect.vy;
            effect.vy += 0.12;
          } else {
            effect.y -= 0.35;
          }
        }
        for (let index = effects.length - 1; index >= 0; index -= 1) {
          if (effects[index].life <= 0) effects.splice(index, 1);
        }
      }

      function startDodge(player, direction) {
        if (!direction || player.dodgeFrames > 0 || player.dodgeCooldownFrames > 0 ||
            player.stamina < DODGE.staminaCost) return;
        const vector = normalizedVector(direction.x, direction.y);
        if (!vector) return;
        player.dodgeX = vector.x;
        player.dodgeY = vector.y;
        player.dodgeFrames = DODGE.durationFrames;
        player.stamina -= DODGE.staminaCost;
        player.staminaRegenDelayFrames = DODGE.staminaRegenDelayFrames;
        player.knockbackX = 0;
        player.knockbackY = 0;
        player.facing = facingForVector(vector.x, vector.y);
        player.aimX = vector.x;
        player.aimY = vector.y;
        dodgesStarted += 1;
        addParticles(player.x, player.y - 2, 8, ["#beb4d2", "#e2d9ec"], 1.8);
      }

      function updatePlayer(player) {
        const input = player.inputs;
        let moved = false;
        let strideAdvance = 0;
        player.moving = false;

        if (input.aim) {
          player.aimX = input.aim.x;
          player.aimY = input.aim.y;
          player.facing = facingForVector(input.aim.x, input.aim.y);
        }
        if (input.dodgePressed) startDodge(player, input.dodgeDirection);
        input.dodgePressed = false;
        input.dodgeDirection = null;

        const dodgeActive = player.dodgeFrames > 0;
        if (dodgeActive) {
          const progress = player.dodgeFrames / DODGE.durationFrames;
          const speed = DODGE.initialSpeed * (0.45 + 0.55 * progress);
          strideAdvance = ORIGINAL_PLAYER_SPEED * 2;
          const next = moveActorForGame({ x: player.x, y: player.y }, {
            x: player.dodgeX * speed,
            y: player.dodgeY * speed
          }, {
            radius: PLAYER_GEOMETRY_RADIUS,
            halfWidth: PLAYER_HALF_WIDTH,
            halfHeight: PLAYER_HALF_HEIGHT,
            wallFacePx: PLAYER_WALL_FACE_PX
          });
          moved = player.x !== next.x || player.y !== next.y;
          player.x = next.x;
          player.y = next.y;
          if (player.dodgeFrames % 3 === 0) {
            addParticles(player.x, player.y - 1, 4, ["#aaa0bd", "#d0c8dc"], 1.2);
          }
          player.dodgeFrames -= 1;
          if (player.dodgeFrames === 0) player.dodgeCooldownFrames = DODGE.cooldownFrames;
        } else {
          const vector = input.movement;
          strideAdvance = ORIGINAL_PLAYER_SPEED * Math.hypot(vector.x, vector.y);
          if (vector.x || vector.y) {
            const next = moveActorForGame({ x: player.x, y: player.y }, {
              x: vector.x * ORIGINAL_PLAYER_SPEED + player.knockbackX,
              y: vector.y * ORIGINAL_PLAYER_SPEED + player.knockbackY
            }, {
              radius: PLAYER_GEOMETRY_RADIUS,
              halfWidth: PLAYER_HALF_WIDTH,
              halfHeight: PLAYER_HALF_HEIGHT,
              wallFacePx: PLAYER_WALL_FACE_PX
            });
            moved = player.x !== next.x || player.y !== next.y;
            player.x = next.x;
            player.y = next.y;
          } else if (player.knockbackX || player.knockbackY) {
            const next = moveActorForGame({ x: player.x, y: player.y }, {
              x: player.knockbackX,
              y: player.knockbackY
            }, {
              radius: PLAYER_GEOMETRY_RADIUS,
              halfWidth: PLAYER_HALF_WIDTH,
              halfHeight: PLAYER_HALF_HEIGHT,
              wallFacePx: PLAYER_WALL_FACE_PX
            });
            moved = player.x !== next.x || player.y !== next.y;
            player.x = next.x;
            player.y = next.y;
          }
        }
        player.knockbackX *= 0.7;
        player.knockbackY *= 0.7;
        player.moving = moved;
        if (player.moving) {
          player.stride += strideAdvance;
          while (player.stride >= 12) {
            player.stride -= 12;
            player.frame = (player.frame + 1) % 8;
          }
        } else {
          player.stride = 0;
          player.frame = 0;
        }

        if (player.dodgeCooldownFrames > 0 && !dodgeActive) player.dodgeCooldownFrames -= 1;
        if (player.staminaRegenDelayFrames > 0) player.staminaRegenDelayFrames -= 1;
        else if (player.dodgeFrames <= 0) {
          player.stamina = Math.min(PLAYER_STAMINA,
            player.stamina + DODGE.staminaRegenPerFrame);
        }
        if (player.invulnerabilityFrames > 0) player.invulnerabilityFrames -= 1;
      }

      return {
        stateSchemaVersion: 3,

        get state() {
          return {
            tick,
            players: [...players.values()].map(publicPlayer),
            enemies: slimes.filter(slime => slime.hp > 0).map(publicSlime),
            damageDealt,
            damageTaken,
            slimesDefeated,
            dodgesStarted
          };
        },

        initialize() {
          if (!roster.length) throw new Error("The Tower encounter requires at least one player.");
          const occupied = [];
          for (let index = 0; index < roster.length; index += 1) {
            const member = roster[index];
            const position = getSpawnPosition(index, occupied);
            const player = {
              accountId: member.accountId,
              username: member.username,
              x: position.x,
              y: position.y,
              hp: PLAYER_HP,
              maxHp: PLAYER_HP,
              invulnerabilityFrames: 0,
              stamina: PLAYER_STAMINA,
              staminaRegenDelayFrames: 0,
              dodgeFrames: 0,
              dodgeCooldownFrames: 0,
              dodgeX: 0,
              dodgeY: 0,
              facing: "south",
              aimX: 0,
              aimY: 1,
              moving: false,
              frame: 0,
              stride: 0,
              attack: null,
              attackCooldownFrames: 0,
              knockbackX: 0,
              knockbackY: 0,
              inputs: inputs.get(member.accountId)
            };
            const carried = connectedWorld?.playerState;
            if (carried && index === 0) {
              if (!Number.isFinite(carried.hp) || carried.hp <= 0 || carried.hp > PLAYER_HP ||
                  !Number.isFinite(carried.stamina) || carried.stamina < 0 || carried.stamina > PLAYER_STAMINA ||
                  !Object.hasOwn(DIRECTIONS, carried.facing)) {
                throw new Error("Invalid Tower transition player state.");
              }
              player.hp = carried.hp;
              player.stamina = carried.stamina;
              player.facing = carried.facing;
              player.aimX = DIRECTIONS[carried.facing].x;
              player.aimY = DIRECTIONS[carried.facing].y;
            }
            players.set(member.accountId, player);
            // Arriving inside any rune must not chain into another level.
            occupiedExits.set(member.accountId, new Set(connectedWorld?.strictArrival
              ? exits.filter(exit => distance(player.x, player.y, exit.x, exit.y) < 40).map(exit => exit.id)
              : []));
            occupied.push(position);
            context.entities.add({
              id: entityId(player),
              typeId: "tower-player",
              position: { x: player.x, y: player.y - 4 },
              radius: PLAYER_GEOMETRY_RADIUS,
              state: { kind: "player", accountId: player.accountId, hp: player.hp }
            });
          }
        },

        validateInput(input) {
          if (!input || typeof input !== "object") return false;
          if (input.type === "clear") return true;
          if (input.type === "move") {
            return (input.direction === null || Object.hasOwn(DIRECTIONS, input.direction)) ||
              [input.x, input.y].every(value => Number.isFinite(value) && Math.abs(value) <= 1);
          }
          if (input.type === "aim") {
            return [input.x, input.y].every(value => Number.isFinite(value) && Math.abs(value) <= 1) &&
              Math.hypot(input.x, input.y) > 0;
          }
          if (input.type === "attack") return typeof input.pressed === "boolean";
          if (input.type === "use-herb") return typeof input.pressed === "boolean";
          return input.type === "dodge" && typeof input.pressed === "boolean" &&
            [input.x, input.y].every(value => Number.isFinite(value) && Math.abs(value) <= 1);
        },

        applyInput(accountId, input) {
          const playerInput = inputs.get(accountId);
          if (!playerInput) return;
          if (input.type === "clear") {
            playerInput.movement = { x: 0, y: 0 };
            playerInput.attackHeld = false;
            playerInput.attackPressed = false;
            playerInput.dodgeHeld = false;
            playerInput.dodgePressed = false;
            playerInput.dodgeDirection = null;
            playerInput.useHerbPressed = false;
            playerInput.aim = null;
          } else if (input.type === "move") {
            if (input.direction !== undefined) {
              const direction = input.direction ? DIRECTIONS[input.direction] : { x: 0, y: 0 };
              playerInput.movement = direction;
            } else {
              playerInput.movement = { x: input.x, y: input.y };
            }
          } else if (input.type === "aim") {
            playerInput.aim = normalizedVector(input.x, input.y);
          } else if (input.type === "attack") {
            if (input.pressed && !playerInput.attackHeld) playerInput.attackPressed = true;
            playerInput.attackHeld = input.pressed;
          } else if (input.type === "use-herb" && input.pressed) {
            playerInput.useHerbPressed = true;
          } else if (input.type === "dodge") {
            if (input.pressed && !playerInput.dodgeHeld) {
              playerInput.dodgePressed = true;
              playerInput.dodgeDirection = { x: input.x, y: input.y };
            }
            playerInput.dodgeHeld = input.pressed;
          }
        },

        step(dtSeconds, nextTick) {
          tick = nextTick;
          const frameCount = Math.max(1, Math.round(60 * dtSeconds));
          for (let frame = 0; frame < frameCount; frame += 1) {
            const alivePlayers = [...players.values()].filter(player => player.hp > 0);
            for (const player of alivePlayers) {
              updatePlayer(player);
            }
            updateInteractions(alivePlayers);
            updateSlimes(alivePlayers);
            const aliveSlimes = slimes.filter(slime => slime.hp > 0);
            for (const player of alivePlayers) updateAttack(player, aliveSlimes);
            for (const player of players.values()) updatePlayerEntity(player);
            updateEffects();
          }
          for (const player of players.values()) {
            const latched = occupiedExits.get(player.accountId);
            const inside = exits.filter(exit => distance(player.x, player.y, exit.x, exit.y) < 40);
            for (const id of latched) {
              if (!inside.some(exit => exit.id === id)) latched.delete(id);
            }
            if (player.hp <= 0) continue;
            const nearby = nearbyExit(player);
            if (nearby && !latched.has(nearby.id) && !slimes.some(slime => slime.hp > 0)) {
              // Latch every overlapping rune until departure, including after a failed load.
              for (const exit of inside) latched.add(exit.id);
              exitRequest = { sequence: ++exitSequence, exitId: nearby.id, destination: nearby.destination };
            }
          }
        },

        snapshot(viewer) {
          const player = players.get(viewer.accountId) ?? players.values().next().value ?? null;
          const nearby = nearbyExit(player);
          return {
            tick,
            viewerAccountId: viewer.accountId,
            map: { width: map.bounds.width, height: map.bounds.height },
            player: player ? publicPlayer(player) : null,
            players: [...players.values()].map(publicPlayer),
            enemies: slimes.filter(slime => slime.hp > 0).map(publicSlime),
            effects: effects.map(effect => ({ ...effect })),
            damageDealt,
            damageTaken,
            slimesDefeated,
            dodgesStarted,
            exitUnlocked: !slimes.some(slime => slime.hp > 0),
            exitCount: exits.length,
            nearbyExit: nearby ? { id: nearby.id,
              destination: nearby.destination ? { ...nearby.destination } : null } : null,
            exitRequest: exitRequest ? { ...exitRequest,
              destination: exitRequest.destination ? { ...exitRequest.destination } : null } : null,
            interactions: interactionSnapshot(),
            inventory: { ...interactionState.inventory },
            lastEvent: { ...lastEvent }
          };
        },

        results() {
          return { tick, damageDealt, damageTaken, slimesDefeated };
        },

        dispose() {
          inputs.clear();
          players.clear();
          occupiedExits.clear();
          slimes.length = 0;
          effects.length = 0;
        }
      };
    }
  });
}

export const astraeumGameModule = createTowerGameModule();
