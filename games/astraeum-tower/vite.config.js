import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const kit = new URL("../../engine/kits/dependencies-0.2.0-2717a9bc86c2/node_modules/", import.meta.url);

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
