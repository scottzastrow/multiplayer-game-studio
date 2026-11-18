import assert from "node:assert/strict";
import { register } from "node:module";
import * as tower from "../../games/astraeum-tower/src/project.js";
import { connectedFixture } from "./connected-play-fixtures.mjs";
import { ASTRAEUM_MODEL } from "../project-identity.js";

register("./public-runtime-loader.mjs", import.meta.url);
const { createLocalGame } = await import("@multiplayer-game/local-preview");
const { createConnectedPreview } = await import("../extensions/connected-play.js");
const destination = { levelId: "connected-level", sectionId: "root", startId: "authored-primary" };
const options = { mapId: destination.levelId, model: ASTRAEUM_MODEL, assetCatalog: tower.ASSET_CATALOG };
const add = (section, id, assetId, transform) => {
  const object = tower.createDesignObject(id, assetId, transform, section.document.objects.length);
  section.document.objects.push(object);
  return object;
};
const fixture = () => {
  const sections = connectedFixture(ASTRAEUM_MODEL);
  add(sections[0], "exit", "prop-stairs-rune", { x: 1968, y: 1040 }).exit = { ...destination };
  return sections;
};
const send = (game, input) => assert.equal(game.sendInput("aries", input), true);
const step = (game, ticks = 1) => { for (let tick = 0; tick < ticks; tick++) game.step(); };
const move = (game, x, ticks) => {
  send(game, { type: "move", x, y: 0 });
  step(game, ticks);
  send(game, { type: "move", x: 0, y: 0 });
};

const locked = fixture();
add(locked[0], "near", "spawn-slime", { x: 1968, y: 1040 });
add(locked[1], "remote", "spawn-slime", { x: 1808, y: 1040 });
const before = structuredClone(locked);
const game = await createLocalGame(createConnectedPreview(locked, options).options);
try {
  assert.equal(game.snapshot.exitUnlocked, false);
  assert.equal(game.snapshot.enemies.length, 2, "all active sections contribute authored slimes");
  step(game);
  assert.equal(game.snapshot.exitRequest, null, "locked exit rejects activation");
  send(game, { type: "attack", pressed: true });
  step(game, 38);
  assert.equal(game.snapshot.enemies.length, 1);
  assert.equal(game.snapshot.exitUnlocked, false, "a remote section's live slime keeps the exit locked");
  assert.equal(game.snapshot.exitRequest, null, "remote-section slime prevents automatic activation");
} finally { game.dispose(); }
assert.deepEqual(locked, before, "combat never writes authored documents");

const final = fixture();
add(final[0], "last", "spawn-slime", { x: 1968, y: 1040 });
const finalGame = await createLocalGame(createConnectedPreview(final, options).options);
try {
  step(finalGame);
  send(finalGame, { type: "attack", pressed: true });
  step(finalGame, 38);
  assert.equal(finalGame.snapshot.enemies.length, 0);
  assert.equal(finalGame.snapshot.exitUnlocked, true, "final combat kill unlocks the exit");
  assert.ok(finalGame.snapshot.nearbyExit, "the player was already within the rune when the final slime died");
  assert.equal(finalGame.snapshot.exitRequest.sequence, 1);
  assert.deepEqual(finalGame.snapshot.exitRequest.destination, destination);
  step(finalGame, 30);
  send(finalGame, { type: "clear" });
  step(finalGame, 30);
  assert.equal(finalGame.snapshot.exitRequest.sequence, 1, "remaining inside and clearing input never repeat a request");
} finally { finalGame.dispose(); }

const empty = fixture();
add(empty[0], "overlapping-arrival", "prop-stairs-rune", { x: 1968, y: 1040 }).exit = { ...destination };
const emptyBefore = structuredClone(empty);
const preview = createConnectedPreview(empty, { ...options, arrival: destination,
  playerState: { hp: 123, stamina: 42, facing: "west" } });
const arrivalGame = await createLocalGame(preview.options);
try {
  const initial = arrivalGame.snapshot.player;
  assert.equal(arrivalGame.snapshot.exitUnlocked, true, "zero-enemy levels start unlocked");
  assert.equal(initial.x, -48);
  assert.equal(initial.y, 1048, "arrival uses the authored start, signed origin and existing feet offset");
  assert.equal(initial.hp, 123);
  assert.equal(initial.stamina, 42);
  assert.equal(initial.facing, "west");
  for (const key of ["dodgeFrames", "attackCooldownFrames", "invulnerabilityFrames", "dodgeCooldownFrames"]) {
    assert.equal(initial[key], 0, `${key} resets at the level boundary`);
  }
  assert.equal(initial.attack, null);
  step(arrivalGame, 10);
  assert.equal(arrivalGame.snapshot.player.x, initial.x, "no held movement carries across");
  assert.equal(arrivalGame.snapshot.player.y, initial.y);
  assert.equal(arrivalGame.snapshot.exitRequest, null, "arrival near an exit cannot auto-chain");
  move(arrivalGame, 1, 12);
  assert.equal(arrivalGame.snapshot.nearbyExit, null);
  assert.equal(arrivalGame.snapshot.exitRequest, null, "leaving arrival does not request an exit");
  move(arrivalGame, -1, 12);
  assert.equal(arrivalGame.snapshot.exitRequest.sequence, 1, "arrival suppression re-arms only after leaving and re-entering");
} finally { arrivalGame.dispose(); }
assert.deepEqual(empty, emptyBefore);

const entrySections = fixture();
entrySections[0].document.objects.find(object => object.assetId === "prop-stairs-rune").transform.x = 1936;
add(entrySections[0], "overlapping-exit", "prop-stairs-rune", { x: 1936, y: 1040 }).exit = { ...destination };
const entryGame = await createLocalGame(createConnectedPreview(entrySections, options).options);
try {
  step(entryGame, 10);
  assert.equal(entryGame.snapshot.exitRequest, null, "an unlocked rune does not activate outside its area");
  move(entryGame, -1, 6);
  assert.equal(entryGame.snapshot.exitRequest, null, "exactly 40px is still outside the activation area");
  move(entryGame, -1, 1);
  assert.equal(entryGame.snapshot.exitRequest.sequence, 1, "entering the unlocked rune activates without Interact");
  step(entryGame, 60);
  assert.equal(entryGame.snapshot.exitRequest.sequence, 1,
    "a failed or unhandled request cannot retry every tick or switch to an overlapping rune");
  move(entryGame, 1, 7);
  move(entryGame, -1, 7);
  assert.equal(entryGame.snapshot.exitRequest.sequence, 2, "leaving and re-entering allows a deliberate retry");
} finally { entryGame.dispose(); }

assert.throws(() => createConnectedPreview(empty, { ...options,
  arrival: { ...destination, startId: "deleted" } }), /player start is missing/);
assert.throws(() => createConnectedPreview(empty, { ...options,
  arrival: { ...destination, sectionId: "archived" } }), /player start is missing/);
const blocked = fixture();
add(blocked[0], "arrival-blocker", "prop-barrel", { x: 2000, y: 1048 }).collision =
  { ...tower.ASSET_CATALOG["prop-barrel"].collisionBox };
await assert.rejects(() => createLocalGame(createConnectedPreview(blocked,
  { ...options, arrival: destination }).options), /arrival is blocked/);
const contact = fixture();
add(contact[0], "unsafe-slime", "spawn-slime", { x: 2000, y: 1040 });
await assert.rejects(() => createLocalGame(createConnectedPreview(contact,
  { ...options, arrival: destination }).options), /overlaps an authored slime/);
const noFloor = fixture();
noFloor[0].document.objects = noFloor[0].document.objects.filter(object =>
  object.assetId !== "floor-cobblestone");
// Place the arrival inside the original footprint, where missing floor is blocked.
noFloor[0].document.objects.find(object => object.assetId === "spawn-aries").transform = { x: 80, y: 80 };
await assert.rejects(() => createLocalGame(createConnectedPreview(noFloor,
  { ...options, arrival: destination }).options), /walkable|blocked/);

const legacy = structuredClone(tower.DEFAULT_FLOOR_DOCUMENT);
const original = JSON.stringify(legacy);
const validated = tower.validateFloorDocument(legacy);
assert.equal(JSON.stringify(validated), original, "validation does not assign destinations to old runes");
assert.ok(validated.objects.filter(object => object.assetId === "prop-stairs-rune").every(object => !Object.hasOwn(object, "exit")));
const authored = empty[0].document;
assert.deepEqual(tower.validateFloorDocument(JSON.parse(JSON.stringify(authored))), authored,
  "explicit exit references survive the saved document format");
assert.throws(() => tower.validateFloorDocument({ ...authored, objects: authored.objects.map(object =>
  object.assetId === "spawn-aries" ? { ...object, exit: destination } : object) }), /only a stairs portal/);
console.log("Astraeum progression: remote-section lock, already-standing final kill, automatic entry, one request per entry, arrival suppression/re-arm, exact safe arrival, carry/reset policy, invalid starts and non-mutating document round-trip passed.");
