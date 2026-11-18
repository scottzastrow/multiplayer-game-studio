import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run bootstrap through npm: npm run bootstrap -- --archive <kit.zip>.");

let archive;
let replaceExisting = false;
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === "--archive" && args[index + 1]) archive = resolve(root, args[++index]);
  else if (arg === "--replace-existing") replaceExisting = true;
  else throw new Error("Usage: npm run bootstrap -- --archive <kit.zip> [--replace-existing]");
}
if (!archive) throw new Error("Usage: npm run bootstrap -- --archive <kit.zip> [--replace-existing]");
const archiveRelative = relative(root, archive);
if (isAbsolute(archiveRelative) || archiveRelative === ".." || archiveRelative.startsWith(`..${sep}`)) {
  throw new Error("Pinned Engine kit archive must be inside this checkout.");
}

const setup = spawnSync(process.execPath, [npmCli, "run", "setup", "--", "--archive", archive], {
  cwd: root, stdio: "inherit", env: process.env
});
if (setup.error) throw setup.error;
if (setup.status !== 0) process.exitCode = setup.status ?? 1;
else {
  const restoreArgs = replaceExisting ? ["--replace-existing"] : [];
  const restore = spawnSync(process.execPath, [resolve(root, "tools", "restore-astraeum-starter.mjs"), ...restoreArgs], {
    cwd: root, stdio: "inherit", env: process.env
  });
  if (restore.error) throw restore.error;
  process.exitCode = restore.status ?? 1;
}
