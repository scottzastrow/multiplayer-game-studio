import assert from "node:assert/strict";
import { register } from "node:module";
import { DEFAULT_FLOOR_DOCUMENT } from "../src/project.js";

register("./combat-test-loader.mjs", import.meta.url);
const { createTowerGameModule, towerEncounterTuning, towerSettings } =
  await import("../src/game.js");

function createHarness(document, roster = [{ accountId: "aries", username: "Aries" }]) {
  const entities = new Map();
  const context = {
    geometry: {
      moveCircle(center, movement) {
        return { x: center.x + movement.x, y: center.y + movement.y };
      }
    },
    entities: {
      add(entity) {
        entities.set(entity.id, entity);
      },
      update(id, update) {
        entities.set(id, update(entities.get(id)));
      }
    }
  };
  const module = createTowerGameModule(document);
  const game = module.create(context, towerSettings, roster);
  game.initialize();
  let tick = 0;
  return {
    game,
    module,
    entities,
    step(frames) {
      for (let frame = 0; frame < frames; frame += 1) {
        tick += 1;
        game.step(1 / 60, tick);
      }
    }
  };
}

function documentWithNearbySlime(x = 176, y = 144) {
  const document = structuredClone(DEFAULT_FLOOR_DOCUMENT);
  const slime = document.objects.find(object => object.assetId === "spawn-slime");
  assert.ok(slime, "the Floor 1 template has a slime spawn.");
  slime.transform = { x, y };
  return document;
}

assert.deepEqual(towerEncounterTuning, {
  playerHp: 500,
  invulnerabilityFrames: 50,
  stamina: 100,
  dodge: {
    durationFrames: 14, initialSpeed: 6.2, staminaCost: 34, cooldownFrames: 6,
    staminaRegenPerFrame: 0.9, staminaRegenDelayFrames: 30
  },
  halberd: { damage: 20, range: 50, arc: 2.3, cooldownFrames: 34, knockback: 4 },
  slime: {
    hp: 36, speed: 1, damage: 12, radius: 12, aggro: 230,
    hopPeriod: 64, hopFrames: 26, hopMultiplier: 2.3
  }
});

const dodge = createHarness(documentWithNearbySlime(400, 400));
const dodgeStartX = dodge.game.state.players[0].x;
assert.equal(dodge.game.validateInput({ type: "dodge", pressed: true, x: 1, y: 0 }), true);
assert.equal(dodge.game.validateInput({ type: "dodge", pressed: true, x: 2, y: 0 }), false);
assert.equal(dodge.game.validateInput({ type: "clear" }), true);
dodge.game.applyInput("aries", { type: "dodge", pressed: true, x: 1, y: 0 });
dodge.game.applyInput("aries", { type: "dodge", pressed: false, x: 0, y: 0 });
dodge.step(14);
const expectedDodgeDistance = Array.from({ length: 14 }, (_, frame) =>
  6.2 * (0.45 + 0.55 * ((14 - frame) / 14))).reduce((sum, speed) => sum + speed, 0);
assert.ok(Math.abs(dodge.game.state.players[0].x - dodgeStartX - expectedDodgeDistance) < 0.001,
  "dodge preserves Anh's 14-frame speed curve and distance.");
assert.equal(dodge.game.state.players[0].stamina, 66);
assert.equal(dodge.game.state.players[0].dodgeFrames, 0);
assert.equal(dodge.game.state.players[0].dodgeCooldownFrames, 6);
assert.equal(dodge.game.state.players[0].facing, "east",
  "directional dodge turns Aries as in the original.");
assert.equal(dodge.game.state.dodgesStarted, 1);
dodge.game.applyInput("aries", { type: "dodge", pressed: true, x: 0, y: 1 });
dodge.game.applyInput("aries", { type: "dodge", pressed: false, x: 0, y: 0 });
dodge.step(1);
assert.equal(dodge.game.state.dodgesStarted, 1, "dodge cooldown rejects an immediate re-press.");
dodge.step(5);
assert.equal(dodge.game.state.players[0].dodgeCooldownFrames, 0);
assert.equal(dodge.game.state.players[0].staminaRegenDelayFrames, 10);
dodge.step(10);
assert.equal(dodge.game.state.players[0].stamina, 66, "stamina does not regenerate during the remaining delay.");
dodge.step(1);
assert.ok(Math.abs(dodge.game.state.players[0].stamina - 66.9) < 1e-9,
  "stamina regenerates at the original 0.9 per frame.");

const heldDodge = createHarness(documentWithNearbySlime(400, 400));
heldDodge.game.applyInput("aries", { type: "dodge", pressed: true, x: 0, y: -1 });
heldDodge.step(100);
assert.equal(heldDodge.game.state.dodgesStarted, 1,
  "holding dodge does not repeat without a release/re-arm.");
heldDodge.game.applyInput("aries", { type: "dodge", pressed: false, x: 0, y: 0 });
heldDodge.step(1);
heldDodge.game.applyInput("aries", { type: "dodge", pressed: true, x: 1, y: 0 });
heldDodge.game.applyInput("aries", { type: "dodge", pressed: false, x: 0, y: 0 });
heldDodge.step(1);
assert.equal(heldDodge.game.state.dodgesStarted, 2, "releasing and pressing again rearms dodge.");

const staminaDodge = createHarness(documentWithNearbySlime(400, 400));
for (let index = 0; index < 2; index += 1) {
  staminaDodge.game.applyInput("aries", { type: "dodge", pressed: true, x: 0, y: 1 });
  staminaDodge.game.applyInput("aries", { type: "dodge", pressed: false, x: 0, y: 0 });
  staminaDodge.step(20);
}
assert.equal(staminaDodge.game.state.players[0].stamina, 32);
staminaDodge.game.applyInput("aries", { type: "dodge", pressed: true, x: -1, y: 0 });
staminaDodge.game.applyInput("aries", { type: "dodge", pressed: false, x: 0, y: 0 });
staminaDodge.step(1);
assert.equal(staminaDodge.game.state.dodgesStarted, 2, "insufficient stamina rejects a dodge.");

const invulnerableDodge = createHarness(documentWithNearbySlime(144, 144));
invulnerableDodge.game.applyInput("aries", { type: "dodge", pressed: true, x: 1, y: 0 });
invulnerableDodge.game.applyInput("aries", { type: "dodge", pressed: false, x: 0, y: 0 });
invulnerableDodge.step(1);
assert.equal(invulnerableDodge.game.state.damageTaken, 0,
  "active dodge frames retain the original damage-invulnerability rule.");

const clearedAction = createHarness(documentWithNearbySlime(400, 400));
clearedAction.game.applyInput("aries", { type: "dodge", pressed: true, x: 1, y: 0 });
clearedAction.game.applyInput("aries", { type: "clear" });
clearedAction.step(1);
assert.equal(clearedAction.game.state.dodgesStarted, 0, "clear cancels a queued dodge.");

const nearby = createHarness(documentWithNearbySlime());
assert.equal(nearby.game.state.enemies.length, DEFAULT_FLOOR_DOCUMENT.objects
  .filter(object => object.assetId === "spawn-slime").length);
const originalPlayerX = nearby.game.state.players[0].x;
const originalSlimeX = nearby.game.state.enemies[0].x;
nearby.game.applyInput("aries", { type: "move", direction: "east" });
nearby.step(1);
nearby.game.applyInput("aries", { type: "move", direction: null });
assert.equal(nearby.game.state.players[0].x, originalPlayerX + 2,
  "account-scoped movement retains the original two-pixel 60 Hz speed.");
assert.equal(nearby.game.state.enemies[0].x, originalSlimeX,
  "idle slimes do not move before they aggro.");

const contact = createHarness(documentWithNearbySlime());
const initialSlimeX = contact.game.state.enemies[0].x;
contact.game.applyInput("aries", { type: "move", direction: "east" });
contact.step(4);
contact.game.applyInput("aries", { type: "move", direction: null });
contact.step(20);
assert.equal(contact.game.state.damageTaken, 12, "the first slime contact deals 12 damage.");
assert.equal(contact.game.state.players[0].hp, 488);
contact.step(50);
assert.equal(contact.game.state.damageTaken, 24,
  "contact damage becomes available again after the original 50-frame invulnerability.");
assert.ok(contact.game.state.enemies[0].x < initialSlimeX,
  "the aggroed slime begins its hop toward the player.");
assert.ok(contact.game.state.enemies[0].hopFrames > 0);

const quickTap = createHarness(documentWithNearbySlime());
quickTap.game.applyInput("aries", { type: "attack", pressed: true });
quickTap.game.applyInput("aries", { type: "attack", pressed: false });
quickTap.step(6);
assert.equal(quickTap.game.state.damageDealt, 10,
  "a short attack press still reaches the next simulation tick and deals thrust damage.");
assert.equal(quickTap.game.state.players[0].attack.frame, 6);

const combat = createHarness(documentWithNearbySlime());
combat.game.applyInput("aries", { type: "attack", pressed: true });
combat.step(6);
assert.equal(combat.game.state.enemies[0].hp, 26, "the Halberd's first thrust deals 10 damage.");
assert.equal(combat.game.state.players[0].attack.frame, 6, "thrust damage keeps the original early hit window.");
combat.step(8);
assert.equal(combat.game.state.enemies[0].hp, 6, "the Halberd's follow-up sweep deals 20 damage.");
assert.equal(combat.game.state.players[0].attack.frame, 14, "sweep damage keeps the original delayed hit window.");
combat.step(24);
assert.equal(combat.game.state.slimesDefeated, 1, "the next held Halberd strike can kill the slime.");
assert.equal(combat.game.state.damageDealt, 36, "damage is capped at the slime's remaining health.");
assert.ok(!combat.game.state.enemies.some(enemy => enemy.id === DEFAULT_FLOOR_DOCUMENT.objects
  .find(object => object.assetId === "spawn-slime").id));
assert.equal(combat.game.snapshot({ accountId: "aries" }).lastEvent.type, "slime-defeated");

const multiplayerReady = createHarness(DEFAULT_FLOOR_DOCUMENT, [
  { accountId: "aries", username: "Aries" },
  { accountId: "taurus", username: "Taurus" }
]);
const playerStarts = multiplayerReady.game.state.players;
assert.equal(playerStarts.length, 2);
assert.notDeepEqual(
  [playerStarts[0].x, playerStarts[0].y],
  [playerStarts[1].x, playerStarts[1].y],
  "player state and input are isolated by account ID."
);
multiplayerReady.game.applyInput("taurus", { type: "move", direction: "east" });
multiplayerReady.step(1);
assert.equal(multiplayerReady.game.state.players[0].x, playerStarts[0].x);
assert.equal(multiplayerReady.game.state.players[1].x, playerStarts[1].x + 2);

console.log("Astraeum combat test passed: original dodge tuning/invulnerability/stamina/cooldown, slime contact, Halberd attacks, and account-scoped state.");
