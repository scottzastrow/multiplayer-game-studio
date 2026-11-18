import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { zipSync } from "fflate";
import {
  calculateThemeAssetHash,
  calculateThemePackageDigest,
  MAX_THEME_ARCHIVE_BYTES,
  MAX_THEME_ARCHIVE_ENTRIES,
  MAX_THEME_EXTRACTED_BYTES,
  MAX_THEME_MANIFEST_BYTES,
  MAX_THEME_PATH_BYTES,
  ThemeCreditsSchema,
  ThemePackageManifestSchema,
  validateThemePackageAssets
} from "@multiplayer-game/theme-sdk/package";

const extensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".woff2", ".ogg", ".mp3", ".wav"]);

function validatePath(path) {
  if (Buffer.byteLength(path, "utf8") > MAX_THEME_PATH_BYTES ||
      path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path) ||
      isAbsolute(path) || /^[a-zA-Z]:/.test(path) ||
      path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`Unsafe theme asset path: ${JSON.stringify(path)}.`);
  }
  if (!extensions.has(extname(path))) {
    throw new Error(`Unsupported theme asset format: ${path}.`);
  }
}

function readRegularFile(root, path, limit, optional = false) {
  let current = root;
  const segments = path.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    current = resolve(current, segments[index]);
    const contained = relative(root, current);
    if (contained.startsWith(`..${sep}`) || contained === ".." || isAbsolute(contained)) {
      throw new Error(`Theme file escapes its root: ${path}.`);
    }
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (optional && error.code === "ENOENT") return undefined;
      throw error;
    }
    if (stat.isSymbolicLink() ||
        (index < segments.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error(`Theme path is not a regular file/directory: ${path}.`);
    }
    if (index === segments.length - 1 && stat.size > limit) {
      throw new Error(`Theme file ${path} exceeds the package byte limit.`);
    }
  }
  const bytes = readFileSync(current);
  if (bytes.length > limit) throw new Error(`Theme file ${path} exceeds the package byte limit.`);
  return bytes;
}

export function exportTheme(themeDirectory, outputPath) {
  const root = resolve(themeDirectory);
  const output = resolve(outputPath);
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) {
    throw new Error("Theme root must be a regular directory.");
  }
  const source = JSON.parse(readRegularFile(root, "theme.json", MAX_THEME_MANIFEST_BYTES).toString("utf8"));
  ThemeCreditsSchema.parse({
    project: source.project,
    author: source.author,
    ...(source.course === undefined ? {} : { course: source.course })
  });
  const manifest = ThemePackageManifestSchema.parse({ ...source, assetsDigest: "0".repeat(64) });
  const files = new Map();
  const hashes = new Map();
  let extractedBytes = 0;
  for (const [optional, mappings] of [
    [false, manifest.assets.required], [true, manifest.assets.optional]
  ]) {
    for (const mapping of Object.values(mappings)) {
      validatePath(mapping.path);
      if (output === resolve(root, ...mapping.path.split("/"))) {
        throw new Error("ZIP output must not replace a theme asset.");
      }
      const bytes = readRegularFile(root, mapping.path, MAX_THEME_EXTRACTED_BYTES - extractedBytes, optional);
      if (bytes === undefined) continue;
      mapping.sha256 = calculateThemeAssetHash(bytes);
      files.set(mapping.path, bytes);
      hashes.set(mapping.path, { sha256: mapping.sha256 });
      extractedBytes += bytes.length;
      if (files.size + 1 > MAX_THEME_ARCHIVE_ENTRIES) {
        throw new Error(`Theme exceeds the ${MAX_THEME_ARCHIVE_ENTRIES}-entry limit.`);
      }
    }
  }
  validateThemePackageAssets(manifest, hashes);
  manifest.assetsDigest = calculateThemePackageDigest(manifest);
  ThemePackageManifestSchema.parse(manifest);
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  if (manifestBytes.length > MAX_THEME_MANIFEST_BYTES) {
    throw new Error("Theme manifest exceeds the package manifest byte limit.");
  }
  if (extractedBytes + manifestBytes.length > MAX_THEME_EXTRACTED_BYTES) {
    throw new Error("Theme exceeds the extracted byte limit.");
  }
  if (output === resolve(root, "theme.json")) {
    throw new Error("ZIP output must not replace the theme manifest.");
  }
  const entries = Object.create(null);
  entries["theme.json"] = manifestBytes;
  for (const [path, bytes] of files) entries[path] = bytes;
  const archive = zipSync(entries, { level: 6, mtime: new Date(1980, 0, 1) });
  if (archive.length > MAX_THEME_ARCHIVE_BYTES) {
    throw new Error("Theme ZIP exceeds the archive byte limit.");
  }
  writeFileSync(output, archive, { flag: "wx" });
  return { manifest, bytes: archive.length, output };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 3 || args[1] !== "--output") {
      throw new Error("Usage: npm run theme:export -- <theme-directory> --output <archive.zip>");
    }
    const result = exportTheme(args[0], args[2]);
    console.log(`Exported ${result.manifest.id}@${result.manifest.version} to ${result.output}`);
    console.log(`assetsDigest: ${result.manifest.assetsDigest} (${result.bytes} ZIP bytes)`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
