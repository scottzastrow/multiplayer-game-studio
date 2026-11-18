import { createLocalGame } from "@multiplayer-game/local-preview";
import { readStandardGamepad } from "@multiplayer-game/theme-sdk";
import { sampleGameModule } from "../src/game.js";
import { sampleMap } from "../src/map.js";
import { sampleSettings } from "../src/settings.js";

export async function runControllerSmoke(requestedStep) {
  const game = await createLocalGame({
    moduleFactory: sampleGameModule,
    settings: sampleSettings,
    map: sampleMap,
    seed: 42,
    roster: [{ accountId: "controller", username: "Controller", joinedOrder: 0 }],
    viewer: { accountId: "controller", role: "player" }
  });
  try {
    const input = readStandardGamepad([{
      connected: true,
      mapping: "standard",
      id: "Simulated",
      axes: [0.575, 0, 0, -1],
      buttons: Array.from({ length: 8 }, (_, index) => ({
        pressed: false,
        value: index === 7 ? 0.5 : 0
      }))
    }]);
    const before = game.snapshot.players[0].position;
    game.sendInput("controller", {
      type: "move",
      ...input.movement,
      aim: input.aim,
      fire: input.fire
    });
    game.step();
    const after = game.snapshot.players[0].position;
    const dx = after.x - before.x;
    const dy = after.y - before.y;
    game.sendInput("controller", {
      type: "move",
      x: 0,
      y: 0,
      aim: input.aim,
      fire: true
    });
    for (let tick = 0; tick < 9; tick++) game.step();
    return {
      angle: Math.atan2(dy, dx) * 180 / Math.PI,
      distance: Math.hypot(dx, dy),
      expectedDistance: (requestedStep ?? sampleSettings.moveDistance) * 0.5,
      blend: sampleSettings.facingMovementBlend,
      stationary: game.snapshot.players[0].position.x === after.x &&
        game.snapshot.players[0].position.y === after.y,
      shots: game.snapshot.players[0].shots
    };
  } finally {
    game.dispose();
  }
}
