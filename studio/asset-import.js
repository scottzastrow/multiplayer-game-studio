import { inflateRawSync, inflateSync } from "node:zlib";
import { createHash } from "node:crypto";

export const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_IMAGE_WIDTH = 2048;
export const MAX_IMAGE_HEIGHT = 2048;
export const MAX_ARCHIVE_ENTRIES = 40;
export const MAX_ARCHIVE_TOTAL_BYTES = 16 * 1024 * 1024;

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const DIRECTIONS = new Set(["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"]);
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function pngDimensions(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 45 || bytes.length > MAX_IMAGE_BYTES ||
      !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new TypeError("Image must be a valid PNG no larger than 4 MB.");
  }
  let offset = 8;
  let width;
  let height;
  let sawData = false;
  let sawPalette = false;
  let sawEnd = false;
  const imageData = [];
  let colorType;
  let bitDepth;
  let interlace;
  let dataEnded = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (length > MAX_IMAGE_BYTES || offset + 12 + length > bytes.length) throw new TypeError("PNG has an invalid chunk length.");
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const body = bytes.subarray(offset + 4, offset + 8 + length);
    if (crc32(body) !== bytes.readUInt32BE(offset + 8 + length)) throw new TypeError("PNG chunk checksum is invalid.");
    if (offset === 8) {
      if (type !== "IHDR" || length !== 13) throw new TypeError("PNG must start with a valid IHDR chunk.");
      width = bytes.readUInt32BE(offset + 8);
      height = bytes.readUInt32BE(offset + 12);
      bitDepth = bytes[offset + 16];
      colorType = bytes[offset + 17];
      interlace = bytes[offset + 20];
      const validDepths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!width || !height || width > MAX_IMAGE_WIDTH || height > MAX_IMAGE_HEIGHT ||
          width * height > 4_194_304 || !validDepths[colorType]?.includes(bitDepth) ||
          bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || interlace > 1) {
        throw new TypeError("PNG dimensions or color format are unsupported.");
      }
    }
    if (type === "PLTE") {
      const entries = length / 3;
      if (sawPalette || sawData || colorType === 0 || colorType === 4 ||
          length < 3 || length > 768 || length % 3 !== 0 ||
          (colorType === 3 && entries > 2 ** bitDepth)) {
        throw new TypeError("PNG palette chunk is invalid or out of order.");
      }
      sawPalette = true;
    }
    if (type === "IDAT") {
      if (colorType === 3 && !sawPalette) throw new TypeError("Indexed PNG images must include a palette before image data.");
      if (dataEnded) throw new TypeError("PNG image data chunks must be consecutive.");
      sawData = true;
      imageData.push(bytes.subarray(offset + 8, offset + 8 + length));
    } else if (sawData && type !== "IEND") dataEnded = true;
    if (["acTL", "fcTL", "fdAT"].includes(type)) throw new TypeError("Animated PNG files are not supported.");
    if (type === "IEND") {
      if (length !== 0 || !sawData || offset + 12 !== bytes.length) throw new TypeError("PNG has an invalid end chunk.");
      sawEnd = true;
      break;
    }
    if (type !== "IHDR" && type !== "IDAT" && type !== "IEND" &&
        (type[0] === type[0].toUpperCase() && !["PLTE"].includes(type))) {
      throw new TypeError(`PNG contains an unsupported critical chunk: ${type}.`);
    }
    offset += 12 + length;
  }
  if (!sawEnd) throw new TypeError("PNG is incomplete.");
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const bitsPerPixel = channels * bitDepth;
  const passes = interlace
    ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]
    : [[0, 0, 1, 1]];
  const rows = [];
  let expectedInflatedLength = 0;
  for (const [startX, startY, stepX, stepY] of passes) {
    const passWidth = width <= startX ? 0 : Math.ceil((width - startX) / stepX);
    const passHeight = height <= startY ? 0 : Math.ceil((height - startY) / stepY);
    if (!passWidth || !passHeight) continue;
    const rowBytes = Math.ceil(passWidth * bitsPerPixel / 8);
    expectedInflatedLength += (rowBytes + 1) * passHeight;
    rows.push({ rowBytes, passHeight });
  }
  try {
    const inflated = inflateSync(Buffer.concat(imageData), { maxOutputLength: expectedInflatedLength });
    if (inflated.length !== expectedInflatedLength) throw new Error("Unexpected image data size.");
    let rowOffset = 0;
    for (const { rowBytes, passHeight } of rows) {
      for (let row = 0; row < passHeight; row += 1) {
        if (inflated[rowOffset] > 4) throw new Error("Invalid PNG row filter.");
        rowOffset += rowBytes + 1;
      }
    }
  } catch {
    throw new TypeError("PNG compressed image data is invalid or exceeds its declared dimensions.");
  }
  return { width, height };
}

function archivePath(name) {
  if (!name || name.includes("\0") || name.includes("\\") || name.startsWith("/") ||
      /^[a-zA-Z]:/.test(name) || name.normalize("NFC") !== name) {
    throw new TypeError(`Unsafe ZIP path: ${JSON.stringify(name)}.`);
  }
  const directory = name.endsWith("/");
  const parts = name.split("/");
  if (directory) parts.pop();
  if (parts.some(part => !part || part === "." || part === ".." || part.includes(":"))) {
    throw new TypeError(`Unsafe ZIP path: ${JSON.stringify(name)}.`);
  }
  return { path: parts.join("/"), directory };
}

function unzip(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 22 || bytes.length > MAX_ARCHIVE_BYTES) {
    throw new TypeError("ZIP archive must be between 22 bytes and 16 MB.");
  }
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0 || eocd + 22 + bytes.readUInt16LE(eocd + 20) !== bytes.length) {
    throw new TypeError("ZIP end directory is invalid.");
  }
  const disk = bytes.readUInt16LE(eocd + 4);
  const centralDisk = bytes.readUInt16LE(eocd + 6);
  const diskEntries = bytes.readUInt16LE(eocd + 8);
  const count = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  if (disk || centralDisk || diskEntries !== count || !count || count > MAX_ARCHIVE_ENTRIES ||
      centralOffset + centralSize !== eocd || count === 0xffff ||
      centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new TypeError("Multi-volume, ZIP64 or oversized ZIP archives are not supported.");
  }
  const files = new Map();
  const foldedPaths = new Set();
  let cursor = centralOffset;
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > eocd || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new TypeError("ZIP central directory is invalid.");
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const expectedCrc = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const entryDisk = bytes.readUInt16LE(cursor + 34);
    const externalAttributes = bytes.readUInt32LE(cursor + 38);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const end = cursor + 46 + nameLength + extraLength + commentLength;
    if (end > eocd || entryDisk || !nameLength || compressedSize === 0xffffffff ||
        uncompressedSize === 0xffffffff || localOffset === 0xffffffff ||
        flags & 0x0041 || ![0, 8].includes(method)) {
      throw new TypeError("ZIP entry uses unsupported flags, compression or ZIP64 fields.");
    }
    const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = rawName.toString("utf8");
    if (!Buffer.from(name, "utf8").equals(rawName)) throw new TypeError("ZIP paths must be valid UTF-8.");
    const normalized = archivePath(name);
    const folded = normalized.path.toLocaleLowerCase("en-US");
    if (foldedPaths.has(folded)) throw new TypeError(`ZIP contains duplicate paths: ${normalized.path}.`);
    foldedPaths.add(folded);
    const unixMode = externalAttributes >>> 16;
    const unixType = unixMode & 0xf000;
    if (unixType && unixType !== 0x8000 && !(normalized.directory && unixType === 0x4000)) {
      throw new TypeError(`ZIP entry is not a regular file: ${normalized.path}.`);
    }
    if (normalized.directory) {
      if (uncompressedSize !== 0 || compressedSize !== 0) throw new TypeError("ZIP directory entries must be empty.");
    } else {
      if (!["metadata.json"].includes(normalized.path) && !normalized.path.toLowerCase().endsWith(".png")) {
        throw new TypeError(`Unsupported file type in ZIP: ${normalized.path}.`);
      }
      total += uncompressedSize;
      const limit = normalized.path === "metadata.json" ? 1_000_000 : MAX_IMAGE_BYTES;
      if (uncompressedSize > limit || total > MAX_ARCHIVE_TOTAL_BYTES) {
        throw new TypeError("ZIP entry or total uncompressed data exceeds the import limit.");
      }
      if (localOffset + 30 > centralOffset || bytes.readUInt32LE(localOffset) !== 0x04034b50) {
        throw new TypeError(`ZIP local header is invalid: ${normalized.path}.`);
      }
      const localFlags = bytes.readUInt16LE(localOffset + 6);
      const localMethod = bytes.readUInt16LE(localOffset + 8);
      const localNameLength = bytes.readUInt16LE(localOffset + 26);
      const localExtraLength = bytes.readUInt16LE(localOffset + 28);
      const localName = bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      if (localFlags !== flags || localMethod !== method || !localName.equals(rawName) ||
          dataOffset + compressedSize > centralOffset) throw new TypeError(`ZIP local header does not match ${normalized.path}.`);
      const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize);
      let contents;
      try {
        contents = method === 0 ? Buffer.from(compressed) :
          inflateRawSync(compressed, { maxOutputLength: limit });
      } catch {
        throw new TypeError(`ZIP entry could not be safely decompressed: ${normalized.path}.`);
      }
      if (contents.length !== uncompressedSize || crc32(contents) !== expectedCrc) {
        throw new TypeError(`ZIP entry checksum or size is invalid: ${normalized.path}.`);
      }
      files.set(normalized.path, contents);
    }
    cursor = end;
  }
  if (cursor !== eocd) throw new TypeError("ZIP central directory length is inconsistent.");
  return files;
}

function metadataImages(metadata, files) {
  if (!metadata || !Array.isArray(metadata.states) || metadata.states.length < 1 || metadata.states.length > 16) {
    throw new TypeError("PixelLab metadata must contain one to sixteen states.");
  }
  const expected = new Set();
  const images = [];
  let animations = 0;
  for (const state of metadata.states) {
    const stateName = state?.character?.name;
    const size = state?.character?.size;
    const frames = state?.frames;
    if (typeof stateName !== "string" || !stateName.trim() || !size ||
        !Number.isInteger(size.width) || !Number.isInteger(size.height) ||
        !frames?.rotations || typeof frames.rotations !== "object" || Array.isArray(frames.rotations) ||
        !frames.animations || typeof frames.animations !== "object" || Array.isArray(frames.animations)) {
      throw new TypeError("PixelLab state metadata is incomplete.");
    }
    const animationEntries = Object.values(frames.animations);
    if (animationEntries.length) throw new TypeError("Animated frames are not supported; import static directions only.");
    animations += animationEntries.length;
    for (const [direction, sourcePath] of Object.entries(frames.rotations)) {
      if (!DIRECTIONS.has(direction) || typeof sourcePath !== "string") {
        throw new TypeError(`Unsupported PixelLab direction: ${direction}.`);
      }
      const normalized = archivePath(sourcePath);
      if (normalized.directory || expected.has(normalized.path)) throw new TypeError("PixelLab metadata has duplicate or invalid image paths.");
      expected.add(normalized.path);
      const bytes = files.get(normalized.path);
      if (!bytes) throw new TypeError(`PixelLab image is missing: ${normalized.path}.`);
      const dimensions = pngDimensions(bytes);
      if (dimensions.width !== size.width || dimensions.height !== size.height) {
        throw new TypeError(`Image ${normalized.path} is ${dimensions.width}×${dimensions.height}; metadata declares ${size.width}×${size.height}.`);
      }
      images.push({ path: normalized.path, stateName, direction, bytes, ...dimensions });
    }
  }
  const pngFiles = [...files.keys()].filter(path => path.toLowerCase().endsWith(".png"));
  if (!images.length || images.length > 32 || expected.size !== pngFiles.length ||
      pngFiles.some(path => !expected.has(path))) {
    throw new TypeError("Every PNG in the PixelLab ZIP must be referenced once by its metadata.");
  }
  return { images, animations };
}

export function parseAssetUpload(filename, bytes) {
  if (typeof filename !== "string" || !filename.trim() || filename.length > 255) {
    throw new TypeError("Choose a PNG image or PixelLab ZIP file.");
  }
  const archive = filename.toLowerCase().endsWith(".zip");
  if (!archive) {
    if (!filename.toLowerCase().endsWith(".png")) throw new TypeError("Only individual PNG images and PixelLab ZIP files are supported.");
    const dimensions = pngDimensions(bytes);
    const metadata = { formatVersion: 1, image: filename, dimensions, animations: [] };
    return {
      filename, archive: false, images: [{ path: filename, stateName: "", direction: null, bytes, ...dimensions }],
      metadata, metadataBytes: Buffer.from(JSON.stringify(metadata, null, 2) + "\n"),
      archiveHash: sha256(bytes), animations: 0
    };
  }
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_ARCHIVE_BYTES) throw new TypeError("ZIP archive exceeds the 16 MB limit.");
  const files = unzip(bytes);
  const metadataBytes = files.get("metadata.json");
  if (!metadataBytes) throw new TypeError("PixelLab ZIP must include metadata.json.");
  let metadata;
  try {
    metadata = JSON.parse(metadataBytes.toString("utf8"));
  } catch {
    throw new TypeError("PixelLab metadata.json is not valid UTF-8 JSON.");
  }
  const { images, animations } = metadataImages(metadata, files);
  return { filename, archive: true, images, metadata, metadataBytes, archiveHash: sha256(bytes), animations };
}

export function validateImportFields({ name, category, author, source }) {
  for (const [key, max] of [["name", 64], ["author", 128], ["source", 256]]) {
    if (typeof ({ name, author, source })[key] !== "string" || !({ name, author, source })[key].trim() ||
        ({ name, author, source })[key].trim().length > max ||
        /[\u0000-\u001f\u007f]/.test(({ name, author, source })[key])) {
      throw new TypeError(`${key} must be nonblank and at most ${max} characters, without control characters.`);
    }
  }
  if (!["prop", "character", "item"].includes(category)) throw new TypeError("Select a supported visual asset type.");
  return { name: name.trim(), category, author: author.trim(), source: source.trim() };
}
