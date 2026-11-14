import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const studioRoot = fileURLToPath(new URL(".", import.meta.url));
const repositoryRoot = resolve(studioRoot, "..");
const kit = new URL("../engine/kits/dependencies-0.2.0-2717a9bc86c2/node_modules/", import.meta.url);
const apiPort = Number(process.env.STUDIO_API_PORT ?? 4179);

export default {
  root: studioRoot,
  server: {
    host: "127.0.0.1",
    port: Number(process.env.STUDIO_WEB_PORT ?? 4173),
    strictPort: true,
    fs: { allow: [repositoryRoot] },
    proxy: {
      "/api": `http://127.0.0.1:${apiPort}`
    }
  },
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
