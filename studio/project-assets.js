export function importedAssetDefinition(record, model = "astraeum-floor-v2") {
  const generic = model === "generic-grid-v1";
  return Object.freeze({
    type: "prop",
    label: record.name,
    size: Object.freeze({ width: record.width, height: record.height }),
    pivot: Object.freeze(generic ? { x: 0, y: 0 } : { x: Math.floor(record.width / 2), y: record.height }),
    snap: Object.freeze(generic ? { x: 0, y: 0, forced: false } : { x: 16, y: 24, forced: false }),
    collision: "none",
    collisionBox: null,
    unique: false,
    alpha: 1,
    artwork: null,
    imported: true,
    paint: record.category === "prop" ? "static" : null,
    importedInfo: Object.freeze({
      direction: record.direction,
      category: record.category,
      author: record.author,
      source: record.source,
      sha256: record.sha256,
      importId: record.importId
    }),
    play: "implemented",
    playVisible: true,
    playNote: "Visual artwork only; no automatic collision, AI, combat, or animation.",
    details: `${record.category} · ${record.width}×${record.height} px` +
      (record.direction ? ` · ${record.direction}` : "") +
      " · visual only; no collision or behavior"
  });
}
