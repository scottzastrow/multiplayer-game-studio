import { extname } from "node:path";
import { zipSync } from "fflate";
import { MAX_GAME_CAMPAIGN_BYTES, validateGameCampaign } from "@multiplayer-game/theme-sdk";
import {
  GAME_PACKAGE_SDK_VERSION, AssetProvenanceMapSchema,
  GamePackageManifestSchema, calculateThemeAssetHash, calculateThemePackageDigest,
  MAX_THEME_ARCHIVE_BYTES, MAX_THEME_ARCHIVE_ENTRIES, MAX_THEME_EXTRACTED_BYTES,
  MAX_THEME_MANIFEST_BYTES, MAX_THEME_PATH_BYTES, validateThemePackageAssets
} from "@multiplayer-game/theme-sdk/package";

const registrations = Object.freeze({
  "dots-and-squares": {
    adapterId: "dots-and-squares",
    error: "Dots and Squares requires the Engine's registered default module and skin 1.0.0 (state schema 4).",
    module: { id: "default", version: "1.0.0", stateSchemaVersion: 4 },
    skin: { rendererId: "default", version: "1.0.0", acceptedModuleId: "default", stateSchemaVersion: 4 }
  },
  "astraeum-floor-v2": {
    adapterId: "astraeum-tower",
    error: "Astraeum requires the Engine's registered Astraeum module and skin 1.0.0 (state schema 1).",
    module: { id: "astraeum-tower", version: "1.0.0", stateSchemaVersion: 1 },
    skin: {
      rendererId: "astraeum-tower-skin", version: "1.0.0",
      acceptedModuleId: "astraeum-tower", stateSchemaVersion: 1
    }
  }
});
const mediaExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".woff2", ".ogg", ".mp3", ".wav"]);
const encode = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");

export function packageAssetProvenance(descriptors) {
  const entries = Object.create(null);
  for (const descriptor of descriptors) {
    if (Object.hasOwn(entries, descriptor.mediaId)) {
      throw new TypeError(`Artwork attribution for ${descriptor.mediaId} is ambiguous.`);
    }
    entries[descriptor.mediaId] = descriptor.provenance;
  }
  const result = AssetProvenanceMapSchema.safeParse(entries);
  if (!result.success) {
    throw new TypeError(`The selected Engine kit cannot represent the required artwork attribution: ${result.error.message}`);
  }
  return result.data;
}

function validateMediaPath(path) {
  if (Buffer.byteLength(path) > MAX_THEME_PATH_BYTES ||
      /[\\:\u0000-\u001f\u007f]/.test(path) ||
      path.split("/").some(part => !part || part === "." || part === "..") ||
      !mediaExtensions.has(extname(path))) {
    throw new TypeError(`Invalid game package media path: ${JSON.stringify(path)}.`);
  }
}

// Expects a registered model's already-adapted campaign and exact saved media bytes,
// not editor documents, a directory, or caller-supplied executable code.
export function buildGamePackage({ model, theme, campaign: input, media }) {
  const registration = registrations[model];
  if (!registration) {
    throw new TypeError(`No Engine campaign adapter registered for Studio model "${model}".`);
  }
  const campaign = validateGameCampaign(input);
  const campaignBytes = encode(campaign);
  if (campaignBytes.length > MAX_GAME_CAMPAIGN_BYTES) throw new RangeError("Campaign exceeds the package byte limit.");
  const declaration = { path: "campaign.json", sha256: calculateThemeAssetHash(campaignBytes) };
  const manifest = GamePackageManifestSchema.parse({
    ...theme,
    assetsDigest: "0".repeat(64),
    gamePackage: {
      schemaVersion: 1, sdkVersion: GAME_PACKAGE_SDK_VERSION,
      adapter: { id: registration.adapterId, version: "1.0.0" },
      campaign: declaration }
  });
  if (manifest.engineApiMajor !== 1 || manifest.module.id !== registration.module.id ||
      manifest.module.version !== registration.module.version ||
      manifest.module.stateSchemaVersion !== registration.module.stateSchemaVersion ||
      manifest.skin.rendererId !== registration.skin.rendererId ||
      manifest.skin.version !== registration.skin.version ||
      manifest.skin.acceptedModuleId !== registration.skin.acceptedModuleId ||
      !manifest.skin.acceptedStateSchemaVersions.includes(registration.skin.stateSchemaVersion)) {
    throw new TypeError(registration.error);
  }
  if (!(media instanceof Map)) throw new TypeError("Game package media must be a Map of declared paths to bytes.");

  const paths = new Set();
  for (const { path } of [...Object.values(manifest.assets.required), ...Object.values(manifest.assets.optional)]) {
    validateMediaPath(path);
    if (paths.has(path.toLowerCase())) throw new TypeError(`Duplicate game package media path: ${path}.`);
    paths.add(path.toLowerCase());
  }
  if (media.size + 2 > MAX_THEME_ARCHIVE_ENTRIES) throw new RangeError("Game package exceeds the ZIP entry limit.");
  const hashes = new Map([[declaration.path, declaration]]);
  const entries = Object.create(null);
  entries[declaration.path] = campaignBytes;
  let extractedBytes = campaignBytes.length;
  for (const [path, bytes] of media) {
    if (typeof path !== "string" || !(bytes instanceof Uint8Array)) {
      throw new TypeError("Game package media entries must contain a path and bytes.");
    }
    validateMediaPath(path);
    extractedBytes += bytes.length;
    if (extractedBytes > MAX_THEME_EXTRACTED_BYTES) throw new RangeError("Game package exceeds the extracted byte limit.");
    hashes.set(path, { sha256: calculateThemeAssetHash(bytes) });
    entries[path] = bytes;
  }
  validateThemePackageAssets(manifest, hashes, [declaration]);
  const { assetsDigest: _, ...unsigned } = manifest;
  manifest.assetsDigest = calculateThemePackageDigest(unsigned);
  const manifestBytes = encode(GamePackageManifestSchema.parse(manifest));
  if (manifestBytes.length > MAX_THEME_MANIFEST_BYTES || extractedBytes + manifestBytes.length > MAX_THEME_EXTRACTED_BYTES) {
    throw new RangeError("Game package manifest exceeds the available byte budget.");
  }
  entries["theme.json"] = manifestBytes;
  const bytes = zipSync(entries, { level: 6, mtime: new Date(1980, 0, 1) });
  if (bytes.length > MAX_THEME_ARCHIVE_BYTES) throw new RangeError("Game package exceeds the ZIP byte limit.");
  return { manifest, bytes };
}
