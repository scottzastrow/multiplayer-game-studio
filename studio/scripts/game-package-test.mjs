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

for (const model of ["generic-grid-v1", "sample-grid-runner", "astraeum-floor-v2"]) {
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
console.log("Game packages: Dots fixture round-trip and unregistered model rejections passed.");
