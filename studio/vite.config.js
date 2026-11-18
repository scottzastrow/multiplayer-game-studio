import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

const studioRoot = fileURLToPath(new URL(".", import.meta.url));
const repositoryRoot = resolve(studioRoot, "..");
const receipt = JSON.parse(readFileSync(resolve(repositoryRoot, "engine", "developer-kit.lock.json"), "utf8"));
const kitDependencies = resolve(process.env.STUDIO_KIT_DEPENDENCIES ??
  resolve(repositoryRoot, receipt.dependencyDirectory, "node_modules"));
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
        replacement: resolve(kitDependencies, "@multiplayer-game", "local-preview", "dist", "index.js")
      },
      {
        find: "@multiplayer-game/theme-sdk",
        replacement: resolve(kitDependencies, "@multiplayer-game", "theme-sdk", "dist", "index.js")
      }
    ]
  }
};
