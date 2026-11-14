import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { parseAssetUpload, sha256 } from "../asset-import.js";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const archivePath = process.env.STUDIO_GOPHER_ZIP;
if (!archivePath) throw new Error("Set STUDIO_GOPHER_ZIP to the supplied mutant-gopher ZIP.");
const archiveBytes = await readFile(archivePath);
const original = parseAssetUpload(archivePath, archiveBytes);
const testDir = await mkdtemp(resolve(root, "studio", "data", "assets-test-"));
const gamesPath = resolve(testDir, "games");
const dbPath = resolve(testDir, "assets.sqlite");
let service;
let output = "";

async function freePort() {
  const listener = createServer();
  await new Promise((ok, fail) => listener.once("error", fail).listen(0, "127.0.0.1", ok));
  const port = listener.address().port;
  await new Promise((ok, fail) => listener.close(error => error ? fail(error) : ok()));
  return port;
}

async function start() {
  const port = await freePort();
  output = "";
  service = spawn(process.execPath, ["--no-warnings", resolve(root, "studio", "server.mjs")], {
    cwd: root,
    env: { ...process.env, STUDIO_API_PORT: String(port), STUDIO_DATABASE_PATH: relative(root, dbPath),
      STUDIO_GAMES_PATH: relative(root, gamesPath) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  service.stdout.on("data", chunk => { output += chunk; });
  service.stderr.on("data", chunk => { output += chunk; });
  const origin = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (service.exitCode !== null) throw new Error(`Service exited: ${output}`);
    try {
      if ((await fetch(`${origin}/api/projects`)).ok) return origin;
    } catch {}
    await delay(100);
  }
  throw new Error(`Service did not start: ${output}`);
}

async function stop() {
  if (!service || service.exitCode !== null || service.signalCode !== null) return;
  await new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error("Service did not stop.")), 5000);
    service.once("exit", () => { clearTimeout(timer); ok(); });
    service.kill("SIGTERM");
  });
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const contents = Buffer.concat([Buffer.from(type), data]);
  const chunk = Buffer.alloc(contents.length + 8);
  chunk.writeUInt32BE(data.length, 0);
  contents.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(contents), contents.length + 4);
  return chunk;
}

function makeIndexedPng(includePalette) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 3;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    ...(includePalette ? [pngChunk("PLTE", Buffer.from([255, 0, 0]))] : []),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 0]))),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function makeZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const filename = Buffer.from(name);
    const bytes = Buffer.from(data);
    const checksum = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, bytes);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0, 8);
    record.writeUInt16LE(0, 10);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(bytes.length, 20);
    record.writeUInt32LE(bytes.length, 24);
    record.writeUInt16LE(filename.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, filename);
    offset += header.length + filename.length + bytes.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}

async function postJson(address, value) {
  const response = await fetch(address, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value)
  });
  return { status: response.status, body: await response.json() };
}

try {
  let origin = await start();
  const create = async name => {
    const response = await postJson(`${origin}/api/projects`, {
      name, author: "Test", width: 2048, height: 2048, model: "generic-grid-v1"
    });
    assert.equal(response.status, 201);
    return response.body;
  };
  const first = await create("Asset Test One");
  const second = await create("Asset Test Two");
  const third = await create("Individual PNG Test");
  const base = `${origin}/api/projects/${first.projectId}/assets`;
  const data = archiveBytes.toString("base64");
  const preview = await postJson(`${base}/preview`, {
    filename: "mutant-gopher.zip", data
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.images.length, 8);
  assert.equal(preview.body.animations, 0);
  assert.deepEqual(preview.body.states, [{
    name: "Idle", width: 48, height: 48,
    directions: ["south", "south-east", "east", "north-east", "north", "north-west", "west", "south-west"],
    animations: []
  }]);

  const fields = { filename: "mutant-gopher.zip", data, name: "Mutant Gopher",
    category: "character", author: "Test artist", source: "PixelLab export" };
  const imported = await postJson(base, fields);
  assert.equal(imported.status, 201);
  assert.equal(imported.body.assets.length, 8);
  assert.deepEqual(imported.body.assets.map(asset => asset.direction).sort(),
    ["east", "north", "north-east", "north-west", "south", "south-east", "south-west", "west"]);
  const db = new DatabaseSync(dbPath);
  const storedMetadata = db.prepare("SELECT source_metadata, metadata_sha256, archive_sha256 FROM project_asset_imports WHERE project_id = ?")
    .get(first.projectId);
  const sourceMetadata = original.metadataBytes;
  assert.deepEqual(Buffer.from(storedMetadata.source_metadata), sourceMetadata, "metadata bytes are preserved exactly");
  assert.equal(storedMetadata.metadata_sha256, sha256(sourceMetadata));
  assert.equal(storedMetadata.archive_sha256, original.archiveHash);
  const projectAssets = db.prepare("SELECT asset_id, import_id, source_path, sha256 FROM project_assets WHERE project_id = ?")
    .all(first.projectId);
  assert.equal(projectAssets.length, 8);
  for (const row of projectAssets) {
    const source = original.images.find(image => image.path === row.source_path);
    const imagePath = resolve(gamesPath, first.projectId, "assets", row.import_id, `${row.asset_id}.png`);
    assert.deepEqual(await readFile(imagePath), source.bytes, "original PNG bytes are preserved exactly");
    const served = await fetch(`${base}/${row.asset_id}`);
    assert.equal(served.status, 200);
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), source.bytes);
  }
  db.close();

  const otherCatalog = await (await fetch(`${origin}/api/projects/${second.projectId}/assets`)).json();
  assert.deepEqual(otherCatalog.assets, [], "another project's asset catalog remains isolated");
  const duplicate = await postJson(base, fields);
  assert.equal(duplicate.status, 409);
  assert.match(duplicate.body.error, /identical images/);
  assert.equal((await (await fetch(base)).json()).assets.length, 8, "duplicate import has no partial records");
  assert.equal((await readdir(resolve(gamesPath, first.projectId, "assets"))).length, 1, "duplicate import does not create another directory");

  const individual = original.images[0];
  const singleBase = `${origin}/api/projects/${third.projectId}/assets`;
  const single = await postJson(singleBase, {
    filename: "south.png", data: individual.bytes.toString("base64"),
    name: "Single Sprite", category: "item", author: "Test artist", source: "Local PNG"
  });
  assert.equal(single.status, 201);
  assert.equal(single.body.assets.length, 1);
  assert.equal(single.body.assets[0].direction, null);
  assert.deepEqual([single.body.assets[0].width, single.body.assets[0].height], [48, 48]);
  assert.deepEqual((await (await fetch(`${origin}/api/projects/${third.projectId}/assets`)).json()).assets
    .map(asset => asset.projectId), [third.projectId]);

  const image = original.images[0].bytes;
  for (const [filename, zipped] of [
    ["path-traversal.zip", makeZip([["../escape.png", image]])],
    ["unsupported-file.zip", makeZip([["readme.txt", Buffer.from("no")]])]
  ]) {
    const rejected = await postJson(`${base}/preview`, { filename, data: zipped.toString("base64") });
    assert.equal(rejected.status, 400, `${filename} is rejected`);
  }
  const malformedPng = await postJson(`${base}/preview`, {
    filename: "invalid.png", data: Buffer.from("not a PNG").toString("base64")
  });
  assert.equal(malformedPng.status, 400);
  const indexedWithoutPalette = await postJson(`${base}/preview`, {
    filename: "indexed-without-palette.png", data: makeIndexedPng(false).toString("base64")
  });
  assert.equal(indexedWithoutPalette.status, 400, "indexed PNGs without PLTE are rejected");
  assert.match(indexedWithoutPalette.body.error, /palette/i);
  const indexedWithPalette = await postJson(`${base}/preview`, {
    filename: "indexed-with-palette.png", data: makeIndexedPng(true).toString("base64")
  });
  assert.equal(indexedWithPalette.status, 200, "valid indexed PNGs remain supported");
  const mismatchedMetadata = structuredClone(original.metadata);
  mismatchedMetadata.states[0].character.size.width = 47;
  const mismatchEntries = [
    ["metadata.json", Buffer.from(JSON.stringify(mismatchedMetadata))],
    ...original.images.map(imageEntry => [imageEntry.path, imageEntry.bytes])
  ];
  const mismatch = await postJson(`${base}/preview`, {
    filename: "wrong-dimensions.zip", data: makeZip(mismatchEntries).toString("base64")
  });
  assert.equal(mismatch.status, 400);
  assert.match(mismatch.body.error, /metadata declares/);
  assert.equal((await (await fetch(base)).json()).assets.length, 8, "rejected uploads do not change the catalog");
  await stop();
  console.log("Asset import checks passed: PixelLab directions/metadata, PNG bytes and hashes, project isolation, duplicate handling, path/type/dimension and malformed-PNG rejection.");
} finally {
  await stop();
  await rm(testDir, { recursive: true, force: true });
}
