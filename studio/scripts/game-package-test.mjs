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
const { buildGamePackage } = await import("../extensions/game-package.mjs");
const tower = await import("../../games/astraeum-tower/src/project.js");
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
const thirdRoot = tower.createEmptyLevelDocument(thirdId, "Third Level");
thirdRoot.objects.push(tower.createDesignObject("aries-start", "spawn-aries", { x: 144, y: 144 }, 1));
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
  assets: { required: requiredMedia, optional: {} }
});
const astraeumInput = {
  model: ASTRAEUM_MODEL,
  theme: astraeumTheme,
  campaign: checkedCampaign,
  media: mediaBytes
};
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
assert.deepEqual(validateGameCampaign(readJson(astraeumEntries["campaign.json"])), checkedCampaign);
assert.deepEqual(buildGamePackage(astraeumInput).bytes, astraeumPackage.bytes);
const dangling = structuredClone(checkedCampaign);
dangling.levels[0].exits[0].destination.startId = "missing-start";
assert.throws(() => buildGamePackage({ ...astraeumInput, campaign: dangling }), /missing-start|start/i);
console.log("Game packages: Dots round-trip and Astraeum sections, archived root, credits, artwork hashes and exits passed.");
