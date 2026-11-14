import { createLocalGame, mountLocalPreview } from "@multiplayer-game/local-preview";
import { loadArtwork, towerSkinFactory } from "./skin.js";
import { astraeumGameModule, towerSettings } from "./game.js";
import { DEFAULT_FLOOR_DOCUMENT, createFloorMap } from "./project.js";

const root = document.querySelector("#preview");
const status = document.querySelector("#preview-status");
if (!root || !status) throw new Error("The Astraeum Tower page is missing its preview elements.");

const artwork = await loadArtwork();
const accountId = "aries";
const game = await createLocalGame({
  moduleFactory: astraeumGameModule,
  settings: towerSettings,
  map: createFloorMap(DEFAULT_FLOOR_DOCUMENT),
  seed: 1,
  roster: [{ accountId, username: "Aries", joinedOrder: 0 }],
  viewer: { accountId, role: "player" }
});
const mounted = mountLocalPreview(root, game, towerSkinFactory(artwork), {
  onInputRejected: () => { status.textContent = "The game module rejected movement input."; }
});

const timer = window.setInterval(() => {
  try {
    game.step();
  } catch (error) {
    window.clearInterval(timer);
    status.textContent = `Local simulation failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}, 1000 / 30);
status.textContent = "Aries is ready. Focus the map and move with the arrow keys or WASD.";

window.addEventListener("pagehide", () => {
  window.clearInterval(timer);
  mounted.dispose();
  game.dispose();
}, { once: true });
