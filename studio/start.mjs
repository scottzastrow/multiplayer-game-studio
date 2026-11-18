import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const node = process.execPath;
const vite = resolve(root, "games", "sample", "node_modules", "vite", "bin", "vite.js");
const api = spawn(node, [resolve(root, "studio", "server.mjs")], {
  cwd: root,
  env: process.env,
  stdio: "inherit"
});
const web = spawn(node, [vite, "--config", "studio/vite.config.js"], {
  cwd: root,
  env: process.env,
  stdio: "inherit"
});
let stopping = false;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of [api, web]) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  process.exitCode = code;
}

for (const child of [api, web]) {
  child.on("error", error => {
    console.error("Studio process failed:", error);
    stop(1);
  });
  child.on("exit", (code, signal) => {
    if (!stopping) {
      console.error(`Studio process exited unexpectedly (code=${code}, signal=${signal}).`);
      stop(code ?? 1);
    }
  });
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
