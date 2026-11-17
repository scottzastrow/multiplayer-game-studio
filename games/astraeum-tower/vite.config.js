import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const root = fileURLToPath(new URL(".", import.meta.url));
const receipt = JSON.parse(readFileSync(new URL("../../engine/developer-kit.lock.json", import.meta.url), "utf8"));
const kit = new URL(`../../${receipt.dependencyDirectory}/node_modules/`, import.meta.url);

export default {
  root,
  server: { host: "127.0.0.1" },
  resolve: {
    alias: [
      {
        find: "@multiplayer-game/local-preview",
        replacement: fileURLToPath(new URL("@multiplayer-game/local-preview/dist/index.js", kit))
      },
      {
        find: "@multiplayer-game/theme-sdk",
        replacement: fileURLToPath(new URL("@multiplayer-game/theme-sdk/dist/index.js", kit))
      }
    ]
  }
};
