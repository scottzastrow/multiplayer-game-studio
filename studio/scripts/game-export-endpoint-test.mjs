import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { register } from "node:module";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createBlankDocument, createDesignObject } from "../../games/astraeum-tower/src/project.js";
import { ASSET_CATALOG } from "../../games/astraeum-tower/src/catalog.js";
import { ASTRAEUM_ARTWORK_PROVENANCE } from "../../games/astraeum-tower/src/package-adapter.js";
import { importedAssetDefinition } from "../project-assets.js";
import { ASTRAEUM_MODEL } from "../project-identity.js";
import { sha256 } from "../asset-import.js";

register("./public-runtime-loader.mjs", import.meta.url);
const { unzipSync } = await import("fflate");
const { validateGameCampaign } = await import("@multiplayer-game/theme-sdk");
const { GamePackageManifestSchema, calculateThemePackageDigest } =
  await import("@multiplayer-game/theme-sdk/package");

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const data = join(root, "studio", "data");
await mkdir(data, { recursive: true });
const temporary = await mkdtemp(join(data, "export-endpoint-test-"));
const database = join(temporary, "studio.sqlite");
const games = join(temporary, "games");
const projectId = "export-fixture";
const mapId = "export-fixture-level";
let service;
let output = "";

async function freePort() {
  const listener = createServer();
  await new Promise((ok, fail) => listener.once("error", fail).listen(0, "127.0.0.1", ok));
  const port = listener.address().port;
  await new Promise((ok, fail) => listener.close(error => error ? fail(error) : ok()));
  return port;
}

function records() {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    return tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()
      .map(row => JSON.stringify(row)).sort()]);
  } finally {
    db.close();
  }
}

try {
  const port = await freePort();
  service = spawn(process.execPath, ["--no-warnings", join(root, "studio", "server.mjs")], {
    cwd: root,
    env: { ...process.env, STUDIO_API_PORT: String(port), STUDIO_DATABASE_PATH: relative(root, database),
      STUDIO_GAMES_PATH: relative(root, games) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  service.stdout.on("data", chunk => { output += chunk; });
  service.stderr.on("data", chunk => { output += chunk; });
  service.on("error", error => { output += `\n${error.stack}`; });
  const origin = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (service.exitCode !== null || service.signalCode !== null) throw new Error(`Service exited:\n${output}`);
    try {
      if ((await fetch(`${origin}/api/projects`)).ok) { ready = true; break; }
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
    await delay(100);
  }
  assert.ok(ready, `Service did not start:\n${output}`);

  const artwork = await readFile(join(root, "games", "astraeum-tower", "assets", "herb.png"));
  const hash = sha256(artwork);
  const assetId = `asset-${hash}`;
  const importId = "fixture-import";
  const mediaId = `imported-${hash.slice(0, 24)}`;
  const record = { name: "Fixture artwork", category: "prop", width: artwork.readUInt32BE(16),
    height: artwork.readUInt32BE(20), author: "Fixture artist", source: "Fixture source",
    sourceFilename: "fixture.png", sha256: hash, importId };
  const catalog = { ...ASSET_CATALOG, [assetId]: importedAssetDefinition(record) };
  const document = createBlankDocument(mapId, "Export fixture");
  document.objects.push(createDesignObject("fixture-art", assetId, { x: 320, y: 320 }, 2000, {}, catalog));
  const mediaDirectory = join(games, projectId, "assets", importId);
  await mkdir(mediaDirectory, { recursive: true });
  const mediaFile = join(mediaDirectory, `${assetId}.png`);
  await writeFile(mediaFile, artwork);
  await writeFile(join(mediaDirectory, "not-exported.txt"), "not package media");

  const db = new DatabaseSync(database);
  try {
    db.exec("BEGIN");
    db.prepare("INSERT INTO maps (project_id, map_id, document_json, updated_at, model) VALUES (?, ?, ?, ?, ?)")
      .run(projectId, mapId, JSON.stringify(document), "2026-01-01", ASTRAEUM_MODEL);
    db.prepare("INSERT INTO project_levels (project_id, starting_map_id) VALUES (?, ?)").run(projectId, mapId);
    db.prepare(`INSERT INTO project_asset_imports
      (project_id, import_id, name, category, author, source, source_filename, source_metadata,
       metadata_sha256, archive_sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(projectId, importId, record.name, record.category, record.author, record.source,
        record.sourceFilename, Buffer.from("{}"), sha256(Buffer.from("{}")), hash, "2026-01-01");
    db.prepare(`INSERT INTO project_assets (project_id, asset_id, import_id, source_path, direction, width, height, sha256)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(projectId, assetId, importId, "fixture.png", null, record.width, record.height, hash);
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  const before = records();
  const exportGame = () => fetch(`${origin}/api/projects/${projectId}/export-game`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ project: "Fixture project", author: "Fixture author", course: "Fixture course" })
  });
  const response = await exportGame();
  assert.equal(response.status, 200, await response.clone().text());
  assert.match(response.headers.get("content-type"), /^application\/zip/);
  assert.match(response.headers.get("content-disposition"), /astraeum-game\.zip/);
  const zipBytes = new Uint8Array(await response.arrayBuffer());
  const entries = unzipSync(zipBytes);
  const manifest = GamePackageManifestSchema.parse(JSON.parse(Buffer.from(entries["theme.json"]).toString("utf8")));
  const campaign = validateGameCampaign(JSON.parse(Buffer.from(entries["campaign.json"]).toString("utf8")));
  assert.equal(manifest.project, "Fixture project");
  assert.equal(manifest.author, "Fixture author");
  assert.equal(manifest.course, "Fixture course");
  assert.equal(manifest.gamePackage.adapter.id, "astraeum-tower");
  assert.equal(manifest.gamePackage.campaign.sha256, sha256(entries["campaign.json"]));
  const { assetsDigest, ...unsigned } = manifest;
  assert.equal(assetsDigest, calculateThemePackageDigest(unsigned));
  assert.equal(campaign.startingLevelId, mapId);
  assert.ok(campaign.levels[0].map.sections[0].map.objects.some(object => object.id === "fixture-art"));
  assert.deepEqual(manifest.assetProvenance[mediaId], {
    author: record.author, source: record.source, sourceFilename: record.sourceFilename
  });
  assert.deepEqual(Buffer.from(entries[manifest.assets.required[mediaId].path]), artwork);
  const expectedPaths = ["theme.json", "campaign.json"];
  for (const [id, declaration] of Object.entries(manifest.assets.required)) {
    expectedPaths.push(declaration.path);
    assert.ok(entries[declaration.path], `Missing ZIP artwork ${id}`);
    assert.equal(sha256(entries[declaration.path]), declaration.sha256);
    if (id !== mediaId) {
      const source = ASTRAEUM_ARTWORK_PROVENANCE[manifest.assetProvenance[id].sourceFilename];
      assert.ok(source, `Missing built-in artwork provenance for ${id}`);
      assert.equal(declaration.sha256, source.sha256);
      assert.deepEqual(Buffer.from(entries[declaration.path]),
        await readFile(join(root, "games", "astraeum-tower", "assets", source.file)));
    }
  }
  assert.deepEqual(Object.keys(entries).sort(), expectedPaths.sort(), "ZIP contains only declared media");
  assert.equal(manifest.assets.required[mediaId].sha256, hash);
  assert.equal(manifest.assets.required["aries-idle"].sha256, ASTRAEUM_ARTWORK_PROVENANCE["aries-idle.png"].sha256);
  assert.deepEqual(records(), before, "successful export must not change database records");

  await rm(mediaFile);
  const missing = await exportGame();
  assert.equal(missing.status, 400);
  assert.match(missing.headers.get("content-type"), /^application\/json/);
  assert.match((await missing.json()).error, new RegExp(`Required package artwork ${mediaId} is missing`));
  assert.deepEqual(records(), before, "missing media must not change database records");

  await writeFile(mediaFile, Buffer.concat([artwork, Buffer.from("changed")]));
  const mismatch = await exportGame();
  assert.equal(mismatch.status, 400);
  assert.match(mismatch.headers.get("content-type"), /^application\/json/);
  assert.match((await mismatch.json()).error, new RegExp(`Required package artwork ${mediaId}.*SHA-256`));
  assert.deepEqual(records(), before, "hash mismatch must not change database records");
  await writeFile(mediaFile, artwork);
  const recovered = await exportGame();
  assert.equal(recovered.status, 200, await recovered.clone().text());
  assert.deepEqual(new Uint8Array(await recovered.arrayBuffer()), zipBytes,
    "restoring artwork produces the identical package after failed requests");
  assert.deepEqual(records(), before, "recovery export must not change database records");
  console.log("Export endpoint: ZIP manifest, artwork, database preservation, missing media and hash mismatch passed.");
} finally {
  if (service && service.exitCode === null && service.signalCode === null) {
    const exited = once(service, "exit");
    service.kill("SIGTERM");
    await exited;
  }
  await rm(temporary, { recursive: true, force: true });
}
