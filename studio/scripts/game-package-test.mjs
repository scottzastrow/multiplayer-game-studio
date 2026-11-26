import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";

register("./public-runtime-loader.mjs", import.meta.url);
const { unzipSync } = await import("fflate");
const { validateGameCampaign, campaignStartingMap } = await import("@multiplayer-game/theme-sdk");
const {
  GAME_PACKAGE_SDK_VERSION,
  GamePackageManifestSchema,
  calculateThemeAssetHash,
  calculateThemePackageDigest
} =
  await import("@multiplayer-game/theme-sdk/package");
const { buildGamePackage, packageAssetProvenance } = await import("../extensions/game-package.mjs");
const tower = await import("../../games/astraeum-tower/src/project.js");
const { createGridRectangleBoundary } = await import("../playable-boundaries.js");
const { createConnectedPreview } = await import("../extensions/connected-play.js");
const { importedAssetDefinition } = await import("../project-assets.js");
const { ASTRAEUM_MODEL } = await import("../project-identity.js");
const { ASSET_CATALOG } = await import("../../games/astraeum-tower/src/catalog.js");
const {
  ASTRAEUM_ARTWORK_PROVENANCE,
  createAstraeumCampaign,
  createAstraeumPackageTheme,
  orderAstraeumCampaignLevels
} = await import("../../games/astraeum-tower/src/package-adapter.js");
const { sha256 } = await import("../asset-import.js");

const readJson = bytes => JSON.parse(Buffer.from(bytes).toString("utf8"));
const root = new URL("../../", import.meta.url);
const receipt = readJson(readFileSync(new URL("engine/developer-kit.lock.json", root)));
const files = unzipSync(readFileSync(new URL(
  `${receipt.localDirectory}/fixtures/dots-and-squares-v1/dots-and-squares-campaign-v1.zip`, root)));
const theme = readJson(files["theme.json"]);
const campaign = readJson(files["campaign.json"]);
const media = new Map([["art/logo.png", files["art/logo.png"]]]);
const input = { model: "dots-and-squares", theme, campaign, media };
const { bytes, manifest } = buildGamePackage(input);
const entries = unzipSync(bytes);
assert.deepEqual(Object.keys(entries).sort(), ["art/logo.png", "campaign.json", "theme.json"]);
assert.deepEqual(entries["art/logo.png"], files["art/logo.png"]);
assert.deepEqual(GamePackageManifestSchema.parse(readJson(entries["theme.json"])), manifest);
const { assetsDigest, ...unsigned } = manifest;
assert.equal(calculateThemePackageDigest(unsigned), assetsDigest);
assert.equal(calculateThemeAssetHash(entries["campaign.json"]), manifest.gamePackage.campaign.sha256);
assert.equal(calculateThemeAssetHash(entries["art/logo.png"]), manifest.assets.required.logo.sha256);
assert.equal(manifest.project, theme.project);
assert.equal(manifest.author, theme.author);
const exportedCampaign = validateGameCampaign(readJson(entries["campaign.json"]));
assert.deepEqual(exportedCampaign, validateGameCampaign(campaign));
assert.deepEqual(campaignStartingMap(exportedCampaign), campaignStartingMap(campaign));
assert.deepEqual(buildGamePackage(input).bytes, bytes);
assert.deepEqual(theme, readJson(files["theme.json"]));

for (const model of ["generic-grid-v1", "sample-grid-runner"]) {
  assert.throws(() => buildGamePackage({ ...input, model }), /No Engine campaign adapter/);
}
assert.throws(() => buildGamePackage({ ...input, theme: {
  ...theme, module: { ...theme.module, id: "astraeum" }, skin: { ...theme.skin, acceptedModuleId: "astraeum" }
} }),
  /requires the Engine's registered default module/);
assert.throws(() => buildGamePackage({ ...input, media: new Map() }), /logo/i);
assert.throws(() => buildGamePackage({ ...input, media: new Map([["art/logo.png", Uint8Array.of(0)]]) }), /logo/i);
assert.throws(() => buildGamePackage({ ...input, media: new Map([...media, ["extra.png", Uint8Array.of(0)]]) }), /extra\.png/i);
assert.throws(() => buildGamePackage({ ...input, media: new Map([...media, ["game.js", Uint8Array.of(0)]]) }), /media path/);
const invalid = structuredClone(campaign);
invalid.levels.find(level => level.exits.length).exits[0].destination.levelId = "nonexistent";
assert.throws(() => buildGamePackage({ ...input, campaign: invalid }), /nonexistent|destination/i);

const makeSection = (sectionId, mapId, gridX, gridY, document) => ({
  sectionId, mapId, gridX, gridY, document
});
const firstId = "astraeum-export-first";
const secondId = "astraeum-export-second";
const thirdId = "astraeum-export-third";
const firstRoot = tower.createBlankDocument(firstId, "First Level");
firstRoot.objects.push(tower.createDesignObject("stairs-next", "prop-stairs-rune", { x: 176, y: 80 }, 1000));
const secondRoot = tower.createEmptyLevelDocument(secondId, "Second Level");
const thirdRoot = tower.createBlankDocument(thirdId, "Third Level");
thirdRoot.objects.find(object => object.assetId === "spawn-aries").transform = { x: 144, y: 144 };
const firstEast = tower.createEmptyLevelDocument("first-east-map", "First East");
const secondEast = tower.createBlankDocument("second-east-map", "Second East");
const secondNorth = tower.createEmptyLevelDocument("second-north-map", "Second North");
const snapshot = {
  model: ASTRAEUM_MODEL,
  startingMapId: firstId,
  levels: [
    {
      mapId: thirdId,
      model: ASTRAEUM_MODEL,
      sections: [makeSection("third-root", thirdId, 0, 0, tower.validateFloorDocument(thirdRoot))],
      archivedSections: []
    },
    {
      mapId: firstId,
      model: ASTRAEUM_MODEL,
      sections: [
        makeSection("first-root", firstId, 0, 0, tower.validateFloorDocument(firstRoot)),
        makeSection("first-east", "first-east-map", 1, 0, firstEast)
      ],
      archivedSections: []
    },
    {
      mapId: secondId,
      model: ASTRAEUM_MODEL,
      sections: [
        makeSection("second-east", "second-east-map", 1, 0, secondEast),
        makeSection("second-north", "second-north-map", 1, 1, secondNorth)
      ],
      archivedSections: [makeSection("second-root-archived", secondId, 0, 0, secondRoot)]
    }
  ]
};
snapshot.levels.find(level => level.mapId === firstId).sections[0].document.objects
  .find(object => object.id === "stairs-next").exit = {
  levelId: secondId, sectionId: "second-east", startId: "aries-start"
};
assert.throws(() => orderAstraeumCampaignLevels(snapshot), error => {
  assert.match(error.message, new RegExp(`Level Second Level \\(${secondId}\\) has no active stairs rune`));
  assert.match(error.message, new RegExp(`Third Level \\(${thirdId}\\)`));
  assert.match(error.message, /Studio will not infer or create exits/);
  return true;
}, "an unordered level list still follows authored exits and identifies the missing connection");
const secondRune = tower.createDesignObject("stairs-next", "prop-stairs-rune", { x: 176, y: 80 }, 1000);
secondRune.exit = { levelId: thirdId, sectionId: "third-root", startId: "aries-start" };
secondEast.objects.push(secondRune);
const orderedLevels = orderAstraeumCampaignLevels(snapshot);
assert.deepEqual(orderedLevels.map(level => level.mapId), [firstId, secondId, thirdId]);
assert.deepEqual(
  orderAstraeumCampaignLevels({ ...snapshot, levels: [...snapshot.levels].reverse() })
    .map(level => level.mapId),
  [firstId, secondId, thirdId],
  "campaign order is derived from explicit exits, not level-list ordering"
);
const incompleteExit = structuredClone(snapshot);
const incompleteRune = incompleteExit.levels.find(level => level.mapId === secondId)
  .sections.find(section => section.sectionId === "second-east").document.objects
  .find(object => object.assetId === "prop-stairs-rune");
delete incompleteRune.exit;
assert.throws(() => orderAstraeumCampaignLevels(incompleteExit),
  /Second Level .*stairs rune stairs-next has no complete active exit destination.*Inspector.*will not infer/i);
const unconnectedId = "astraeum-export-unconnected";
const unconnectedRoot = tower.createEmptyLevelDocument(unconnectedId, "Unconnected Level");
const unconnected = {
  mapId: unconnectedId,
  model: ASTRAEUM_MODEL,
  sections: [makeSection("unconnected-east", "unconnected-east-map", 1, 0,
    tower.createEmptyLevelDocument("unconnected-east-map", "Unconnected East"))],
  archivedSections: [makeSection("unconnected-root", unconnectedId, 0, 0, unconnectedRoot)]
};
assert.throws(() => orderAstraeumCampaignLevels({
  ...snapshot, levels: [...snapshot.levels, unconnected]
}), error => {
  assert.match(error.message, /Third Level/);
  assert.match(error.message, new RegExp(`Unconnected Level \\(${unconnectedId}\\)`));
  assert.match(error.message, /delete any active level that should not be included/i);
  return true;
}, "an active archived-root level cannot be silently omitted from the authored campaign");
const orderedSnapshot = { ...snapshot, levels: orderedLevels };
for (const kind of ["aries", "prop"]) {
  const withReservedId = structuredClone(orderedSnapshot);
  const document = withReservedId.levels[0].sections[0].document;
  if (kind === "aries") {
    document.objects.find(object => object.assetId === "spawn-aries").id = "reserved-player-spawn";
  } else {
    document.objects.push(tower.createDesignObject("reserved-player-spawn", "prop-barrel",
      { x: 320, y: 320 }, 2000));
    document.objects.push(tower.createDesignObject("reserved-player-spawn-1", "prop-barrel",
      { x: 360, y: 320 }, 2001));
  }
  const map = validateGameCampaign(createAstraeumCampaign(withReservedId, ASSET_CATALOG).campaign)
    .levels[0].map.sections[0].map;
  const compatibility = map.spawns.find(spawn => spawn.id !==
    (kind === "aries" ? "reserved-player-spawn" : "aries-start"));
  assert.ok(compatibility);
  assert.notEqual(compatibility.id, "reserved-player-spawn");
  assert.ok(!document.objects.some(object => object.id === compatibility.id));
}
for (const assetId of ["prop-barrel", "prop-crate", "prop-pots", "item-chest"]) {
  const withPropCollision = structuredClone(orderedSnapshot);
  const objects = withPropCollision.levels[0].sections[0].document.objects;
  objects.push(tower.createDesignObject("colliding-prop", assetId, { x: 320, y: 320 }, 2000, { collision: true }));
  assert.throws(() => createAstraeumCampaign(withPropCollision, ASSET_CATALOG),
    error => {
      assert.match(error.message, new RegExp(firstId));
      assert.match(error.message, /first-root/);
      assert.match(error.message, /colliding-prop/);
      assert.match(error.message, /0\.5\.0.*32|32.*0\.5\.0/i);
      return true;
    }, `${assetId} must report unsupported exact collision geometry`);
  objects.at(-1).collision = null;
  const withoutCollision = validateGameCampaign(createAstraeumCampaign(withPropCollision, ASSET_CATALOG).campaign);
  assert.ok(withoutCollision.levels[0].map.sections[0].map.objects.some(object => object.id === "colliding-prop"));
}
for (const wallFirst of [true, false]) {
  const collisionSnapshot = structuredClone(orderedSnapshot);
  const document = collisionSnapshot.levels[0].sections[0].document;
  const wall = tower.createDesignObject("review-wall", "wall-damp-stone", { x: 321, y: 321 }, 2000);
  const prop = tower.createDesignObject("collision-0", "prop-stairs-rune", { x: 368, y: 336 }, 2001);
  prop.exit = { levelId: secondId, sectionId: "second-east", startId: "aries-start" };
  document.objects.push(...(wallFirst ? [wall, prop] : [prop, wall]));
  const converted = validateGameCampaign(createAstraeumCampaign(collisionSnapshot, ASSET_CATALOG).campaign);
  const map = converted.levels[0].map.sections[0].map;
  assert.ok(map.objects.some(object => object.id === "collision-0" && object.typeId === "prop"));
  const wallRect = tower.collisionRect(wall);
  assert.ok(map.collisions.some(collision => {
    const generated = map.objects.find(object => object.id === collision.objectId);
    return generated?.typeId === "collision" && generated.id !== "collision-0" &&
      generated.position.x === wallRect.x + wallRect.width / 2 &&
      generated.position.y === wallRect.y + wallRect.height / 2 &&
      collision.shape.width === wallRect.width && collision.shape.height === wallRect.height;
  }), "the wall collider is retained without stealing the later authored ID");
  assert.equal(new Set(map.objects.map(object => object.id)).size, map.objects.length);
}
const { campaign: astraeumCampaign, media: mediaSources } =
  createAstraeumCampaign(orderedSnapshot, ASSET_CATALOG);
const checkedCampaign = validateGameCampaign(astraeumCampaign);
assert.equal(checkedCampaign.levels.length, 3);
assert.equal(checkedCampaign.levels[0].map.sections.length, 2);
assert.equal(checkedCampaign.levels[1].map.sections.length, 2);
assert.equal(checkedCampaign.levels[1].boundary.width, 4096);
assert.equal(checkedCampaign.levels[1].camera.x, 1024);
assert.ok(checkedCampaign.levels[0].map.sections[0].map.spawns.some(spawn =>
  spawn.id === "reserved-player-spawn"));
assert.deepEqual(checkedCampaign.levels[1].exits[0].destination, {
  levelId: thirdId, sectionId: "third-root", startId: "aries-start"
});
const mediaBytes = new Map();
const requiredMedia = {};
for (const descriptor of mediaSources.values()) {
  const source = ASTRAEUM_ARTWORK_PROVENANCE[descriptor.file];
  assert.ok(source, `provenance for ${descriptor.file}`);
  const bytes = readFileSync(new URL(`games/astraeum-tower/assets/${descriptor.file}`, root));
  assert.equal(sha256(bytes), source.sha256);
  const path = `art/${descriptor.mediaId}.png`;
  mediaBytes.set(path, bytes);
  requiredMedia[descriptor.mediaId] = { path, sha256: sha256(bytes) };
}
const astraeumTheme = createAstraeumPackageTheme({
  project: "Astraeum test project",
  author: "Astraeum test team",
  assets: { required: requiredMedia, optional: {} },
  assetProvenance: packageAssetProvenance(mediaSources.values())
});
const astraeumInput = {
  model: ASTRAEUM_MODEL,
  theme: astraeumTheme,
  campaign: checkedCampaign,
  media: mediaBytes
};
{
  const longSnapshot = structuredClone(orderedSnapshot);
  const level = longSnapshot.levels[0];
  const longObjectId = "r".repeat(128);
  const firstSection = level.sections[0];
  const secondSection = level.sections[1];
  firstSection.sectionId = `a-b-${"s".repeat(112)}`;
  secondSection.sectionId = `a-${"s".repeat(112)}`;
  const firstRune = firstSection.document.objects.find(object => object.id === "stairs-next");
  firstRune.id = longObjectId;
  const secondRune = tower.createDesignObject(longObjectId, "prop-stairs-rune", { x: 176, y: 80 }, 2000);
  secondRune.exit = structuredClone(firstRune.exit);
  secondSection.document.objects.push(secondRune);
  const extraRune = tower.createDesignObject("another-rune", "prop-stairs-rune", { x: 208, y: 80 }, 2001);
  extraRune.exit = structuredClone(firstRune.exit);
  firstSection.document.objects.push(extraRune);
  const converted = createAstraeumCampaign(longSnapshot, ASSET_CATALOG).campaign;
  const zip = buildGamePackage({ ...astraeumInput, campaign: converted }).bytes;
  assert.deepEqual(buildGamePackage({ ...astraeumInput, campaign: converted }).bytes, zip);
  const exported = validateGameCampaign(readJson(unzipSync(zip)["campaign.json"]));
  const exits = exported.levels[0].exits;
  assert.equal(exits.length, 3);
  assert.equal(new Set(exits.map(exit => exit.id)).size, exits.length);
  assert.deepEqual(exits.map(exit => [exit.sectionId, exit.objectId]).sort(), [
    [firstSection.sectionId, longObjectId], [firstSection.sectionId, "another-rune"],
    [secondSection.sectionId, longObjectId]
  ].sort());
  for (const exit of exits) {
    assert.match(exit.id, /^[a-z0-9][a-z0-9._:-]{0,127}$/);
    assert.deepEqual(exit.destination, { levelId: secondId, sectionId: "second-east", startId: "aries-start" });
  }
  const idsBySource = Object.fromEntries(exits.map(exit => [JSON.stringify([exit.sectionId, exit.objectId]), exit.id]));
  longSnapshot.levels[0].sections.reverse();
  firstSection.document.objects.reverse();
  const reordered = createAstraeumCampaign(longSnapshot, ASSET_CATALOG).campaign;
  assert.deepEqual(Object.fromEntries(reordered.levels[0].exits.map(exit =>
    [JSON.stringify([exit.sectionId, exit.objectId]), exit.id])), idsBySource,
  "exit IDs are deterministic independent of section and object order");

  const ambiguous = structuredClone(orderedSnapshot);
  const [left, right] = ambiguous.levels[0].sections;
  left.sectionId = "a-b";
  right.sectionId = "a";
  const leftRune = left.document.objects.find(object => object.id === "stairs-next");
  leftRune.id = "c";
  const rightRune = tower.createDesignObject("b-c", "prop-stairs-rune", { x: 176, y: 80 }, 2000);
  rightRune.exit = structuredClone(leftRune.exit);
  right.document.objects.push(rightRune);
  const ambiguousCampaign = createAstraeumCampaign(ambiguous, ASSET_CATALOG).campaign;
  const ambiguousZip = buildGamePackage({ ...astraeumInput, campaign: ambiguousCampaign }).bytes;
  const ambiguousExits = validateGameCampaign(readJson(unzipSync(ambiguousZip)["campaign.json"])).levels[0].exits;
  assert.equal(new Set(ambiguousExits.map(exit => exit.id)).size, 2,
    "ambiguous section/object concatenations have unique exit IDs");
}
const astraeumPackage = buildGamePackage(astraeumInput);
const astraeumEntries = unzipSync(astraeumPackage.bytes);
assert.equal(astraeumPackage.manifest.gamePackage.adapter.id, "astraeum-tower");
assert.equal(astraeumPackage.manifest.gamePackage.sdkVersion, GAME_PACKAGE_SDK_VERSION);
assert.equal(astraeumPackage.manifest.module.id, "astraeum-tower");
assert.equal(astraeumPackage.manifest.skin.rendererId, "astraeum-tower-skin");
assert.deepEqual(
  Object.keys(astraeumEntries).sort(),
  ["campaign.json", "theme.json", ...mediaBytes.keys()].sort()
);
assert.deepEqual(GamePackageManifestSchema.parse(readJson(astraeumEntries["theme.json"])),
  astraeumPackage.manifest);
assert.deepEqual(readJson(astraeumEntries["theme.json"]).assetProvenance,
  Object.fromEntries([...mediaSources].map(([id, source]) => [id, source.provenance])));
assert.deepEqual(validateGameCampaign(readJson(astraeumEntries["campaign.json"])), checkedCampaign);
assert.deepEqual(buildGamePackage(astraeumInput).bytes, astraeumPackage.bytes);
const dangling = structuredClone(checkedCampaign);
dangling.levels[0].exits[0].destination.startId = "missing-start";
assert.throws(() => buildGamePackage({ ...astraeumInput, campaign: dangling }), /missing-start|start/i);

const rootDocument = tower.createBlankDocument("safety-level", "Safety");
rootDocument.objects.find(object => object.assetId === "spawn-aries").transform = { x: 2000, y: 80 };
rootDocument.objects.push(tower.createDesignObject("edge-wall", "wall-damp-stone", { x: 2016, y: 64 }, 3000));
const eastDocument = tower.createEmptyLevelDocument("safety-east", "Safety East");
eastDocument.objects.push(tower.createDesignObject("east-floor", "floor-cobblestone", { x: 0, y: 64 }, 0));
const safetySections = [
  makeSection("safety-root", rootDocument.id, 0, 0, rootDocument),
  makeSection("safety-east", eastDocument.id, 1, 0, eastDocument)
];
rootDocument.playableBoundary = createGridRectangleBoundary(
  { x: 62, y: 2 }, { x: 65, y: 2 }, safetySections).boundary;
const startingSafety = { model: ASTRAEUM_MODEL, startingMapId: rootDocument.id,
  levels: [{ mapId: rootDocument.id, model: ASTRAEUM_MODEL, sections: safetySections, archivedSections: [] }] };
assert.throws(() => createAstraeumCampaign(startingSafety, ASSET_CATALOG),
  /requires two player starts in the starting section/i);
const entryRoot = structuredClone(firstRoot);
entryRoot.objects.find(object => object.id === "stairs-next").exit = {
  levelId: rootDocument.id, sectionId: "safety-root", startId: "aries-start"
};
const safetySnapshot = { model: ASTRAEUM_MODEL, startingMapId: firstId, levels: [
  { mapId: firstId, model: ASTRAEUM_MODEL, sections: [makeSection("entry", firstId, 0, 0, entryRoot)],
    archivedSections: [] },
  ...startingSafety.levels
] };
const safetyCampaign = validateGameCampaign(createAstraeumCampaign(safetySnapshot, ASSET_CATALOG).campaign);
const safetyMaps = safetyCampaign.levels[1].map.sections;
assert.ok(safetyMaps[1].map.spawns.some(spawn => spawn.id === "reserved-player-spawn"));
for (const sectionId of ["safety-root", "safety-east"]) {
  const candidate = structuredClone(safetyCampaign);
  candidate.startingLevelId = rootDocument.id;
  candidate.startingSectionId = sectionId;
  assert.throws(() => validateGameCampaign(candidate), /must contain at least two player starts/i,
    "neither one-start section satisfies the initial-section SDK contract");
}
const preview = createConnectedPreview(safetySections, { mapId: rootDocument.id,
  model: ASTRAEUM_MODEL, assetCatalog: ASSET_CATALOG });
for (const exported of safetyMaps) {
  const played = preview.options.world.sections.find(section => section.id === exported.id);
  const isBlocked = (map, x, y) => map.collisions.some(collision => {
      const object = map.objects.find(item => item.id === collision.objectId);
      return Math.abs(x - object.position.x) < collision.shape.width / 2 &&
        Math.abs(y - object.position.y) < collision.shape.height / 2;
    });
  for (let y = 16; y < 2048; y += 32) for (let x = 16; x < 2048; x += 32) {
    assert.equal(isBlocked(exported.map, x, y), isBlocked(played.map, x, y),
      `export and connected Play block the same cell ${exported.id} ${x},${y}`);
  }
  if (exported.id === "safety-east") assert.ok(isBlocked(exported.map, 48, 80),
    "a floor hole inside the playable boundary remains blocked");
}
const noSafe = structuredClone(safetySnapshot);
noSafe.levels[1].sections[1].document.objects = [];
assert.throws(() => createAstraeumCampaign(noSafe, ASSET_CATALOG), /no safe cell.*reserved multiplayer start/i);

const importedBytes = files["art/logo.png"];
const importedHash = sha256(importedBytes);
const record = { assetId: `asset-${importedHash}`, importId: "test-import", name: "Imported",
  width: 32, height: 32, category: "prop", direction: "", sha256: importedHash,
  author: "Artist", source: "Source license", sourceFilename: "original.png" };
const importedCatalog = { ...ASSET_CATALOG, [record.assetId]: importedAssetDefinition(record) };
const withImport = structuredClone(orderedSnapshot);
withImport.levels[0].sections[0].document.objects.push(tower.createDesignObject("imported-art", record.assetId,
  { x: 240, y: 240 }, 2000, {}, importedCatalog));
const importedResult = createAstraeumCampaign(withImport, importedCatalog, [{
  asset_id: record.assetId, sha256: record.sha256, author: record.author, source: record.source,
  source_filename: record.sourceFilename
}]);
const importedDescriptor = [...importedResult.media.values()].find(item => item.kind === "imported");
assert.deepEqual(importedDescriptor.provenance, {
  author: record.author, source: record.source, sourceFilename: record.sourceFilename
});
const importedPath = `art/${importedDescriptor.mediaId}.png`;
const importedTheme = createAstraeumPackageTheme({ project: "Project", author: "Author",
  assets: { required: { ...requiredMedia, [importedDescriptor.mediaId]: { path: importedPath, sha256: importedHash } },
    optional: {} }, assetProvenance: packageAssetProvenance(importedResult.media.values()) });
const importedZip = unzipSync(buildGamePackage({ model: ASTRAEUM_MODEL, theme: importedTheme,
  campaign: importedResult.campaign, media: new Map([...mediaBytes, [importedPath, importedBytes]]) }).bytes);
assert.deepEqual(readJson(importedZip["theme.json"]).assetProvenance[importedDescriptor.mediaId],
  importedDescriptor.provenance, "imported attribution survives in the ZIP");
assert.deepEqual(readJson(importedZip["theme.json"]).assetProvenance,
  Object.fromEntries([...importedResult.media].map(([id, source]) => [id, source.provenance])));
assert.throws(() => packageAssetProvenance([{ mediaId: "bad", provenance: {
  author: "", source: "source", sourceFilename: "file.png" } }]), /cannot represent.*attribution/i);
const otherHash = `${importedHash.slice(0, 24)}${"a".repeat(40)}`;
const otherRecord = { ...record, assetId: `asset-${otherHash}`, sha256: otherHash, author: "Another artist" };
const collisionCatalog = { ...importedCatalog, [otherRecord.assetId]: importedAssetDefinition(otherRecord) };
const collisionSnapshot = structuredClone(withImport);
collisionSnapshot.levels[0].sections[0].document.objects.push(tower.createDesignObject("other-import",
  otherRecord.assetId, { x: 272, y: 240 }, 2001, {}, collisionCatalog));
const importedRows = [record, otherRecord].map(item => ({ asset_id: item.assetId, sha256: item.sha256,
  author: item.author, source: item.source, source_filename: item.sourceFilename }));
assert.throws(() => createAstraeumCampaign(collisionSnapshot, collisionCatalog, importedRows),
  /conflicting attribution or source identity/i);
console.log("Game packages: Dots round-trip and Astraeum sections, archived root, credits, artwork hashes and exits passed.");
