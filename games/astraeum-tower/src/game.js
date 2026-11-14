import { moveActor } from "./tilemap-adapter.js";
import { floor1Grid, floor1Map } from "./map.js";

const ORIGINAL_PLAYER_SPEED = 2;
const PLAYER_WALL_FACE_PX = 12;
const PLAYER_GEOMETRY_RADIUS = 4;
const DIRECTIONS = Object.freeze({
  north: Object.freeze({ x: 0, y: -1 }),
  south: Object.freeze({ x: 0, y: 1 }),
  west: Object.freeze({ x: -1, y: 0 }),
  east: Object.freeze({ x: 1, y: 0 })
});

export const towerSettings = Object.freeze({ playerSpeed: ORIGINAL_PLAYER_SPEED });

export const astraeumGameModule = Object.freeze({
  metadata: Object.freeze({
    id: "astraeum-tower-floor-one",
    version: "1.0.0",
    stateSchemaVersion: 1
  }),

  validateSettings(settings) {
    return typeof settings === "object" && settings !== null &&
      settings.playerSpeed === ORIGINAL_PLAYER_SPEED;
  },

  create(context, settings, roster) {
    const inputs = new Map(roster.map(player => [player.accountId, null]));
    let tick = 0;
    let player;

    return {
      stateSchemaVersion: 1,

      get state() {
        return { tick, player: player ? { ...player } : null };
      },

      initialize() {
        const spawn = floor1Map.spawns.find(item => item.id === "aries-start");
        if (!spawn) throw new Error("Floor 1 has no player spawn.");
        const member = roster[0];
        player = {
          accountId: member.accountId,
          username: member.username,
          x: spawn.position.x,
          y: spawn.position.y + 8,
          facing: "south",
          moving: false,
          frame: 0,
          stride: 0
        };
        context.entities.add({
          id: `player:${member.accountId}`,
          typeId: "tower-player",
          position: { x: spawn.position.x, y: spawn.position.y + 4 },
          radius: spawn.radius,
          state: { kind: "player", accountId: member.accountId }
        });
      },

      validateInput(input) {
        return typeof input === "object" && input !== null &&
          input.type === "move" &&
          (input.direction === null || Object.hasOwn(DIRECTIONS, input.direction));
      },

      applyInput(accountId, input) {
        if (inputs.has(accountId)) inputs.set(accountId, input.direction);
      },

      step(dtSeconds, nextTick) {
        tick = nextTick;
        const direction = inputs.get(player.accountId);
        const vector = direction ? DIRECTIONS[direction] : null;
        player.moving = false;
        if (!vector) {
          player.stride = 0;
          player.frame = 0;
          return;
        }

        player.facing = direction;
        const previous = { x: player.x, y: player.y };
        const frameCount = Math.max(1, Math.round(60 * dtSeconds));
        for (let frame = 0; frame < frameCount; frame += 1) {
          const next = moveActor(context.geometry, floor1Grid, { x: player.x, y: player.y }, {
            x: vector.x * settings.playerSpeed,
            y: vector.y * settings.playerSpeed
          }, {
            radius: PLAYER_GEOMETRY_RADIUS,
            halfWidth: 9,
            halfHeight: 8,
            wallFacePx: PLAYER_WALL_FACE_PX
          });
          player.moving = player.x !== next.x || player.y !== next.y;
          player.x = next.x;
          player.y = next.y;
          if (!player.moving) {
            player.stride = 0;
            player.frame = 0;
            break;
          }
          player.stride += settings.playerSpeed;
          while (player.stride >= 12) {
            player.stride -= 12;
            player.frame = (player.frame + 1) % 8;
          }
        }
        context.entities.update(`player:${player.accountId}`, entity => ({
          ...entity,
          position: { x: player.x, y: player.y - 4 }
        }));
      },

      snapshot(viewer) {
        return {
          tick,
          viewerAccountId: viewer.accountId,
          map: { width: floor1Map.bounds.width, height: floor1Map.bounds.height },
          player: player ? { ...player } : null
        };
      },

      results() {
        return { tick };
      },

      dispose() {
        inputs.clear();
      }
    };
  }
});
