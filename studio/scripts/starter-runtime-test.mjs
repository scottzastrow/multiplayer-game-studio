import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import * as tower from "../../games/astraeum-tower/src/project.js";
import { ASTRAEUM_MODEL } from "../project-identity.js";

register("./public-runtime-loader.mjs", import.meta.url);
const { createLocalGame } = await import("@multiplayer-game/local-preview");
const { createConnectedPreview } = await import("../extensions/connected-play.js");
const path = new URL("../../starter-data/astraeum/studio.sqlite", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("../../starter-data/astraeum/manifest.json", import.meta.url)));
const hash = async () => createHash("sha256").update(await readFile(path)).digest("hex");
assert.equal(await hash(), manifest.database.sha256);
const db = new DatabaseSync(fileURLToPath(path), { readOnly: true });
try {
  const rows = db.prepare(`SELECT s.level_map_id, s.section_id, s.map_id, s.grid_x, s.grid_y, m.document_json
    FROM level_sections s JOIN maps m ON m.project_id=s.project_id AND m.map_id=s.map_id
    WHERE s.project_id=? AND m.deleted_at IS NULL ORDER BY s.level_map_id, s.grid_x, s.grid_y`)
    .all(manifest.game.projectId);
  assert.equal(rows.length, manifest.database.activeSections);
  const levels = new Map();
  for (const row of rows) {
    const section = {
      sectionId: row.section_id, mapId: row.map_id, gridX: row.grid_x, gridY: row.grid_y,
      document: JSON.parse(row.document_json)
    };
    tower.validateFloorDocument(structuredClone(section.document), tower.ASSET_CATALOG);
    if (!levels.has(row.level_map_id)) levels.set(row.level_map_id, []);
    levels.get(row.level_map_id).push(section);
  }
  assert.equal(levels.size, manifest.database.activeLevels);
  for (const [mapId, sections] of levels) {
    const original = structuredClone(sections);
    const preview = createConnectedPreview(sections, { mapId, model: ASTRAEUM_MODEL, assetCatalog: tower.ASSET_CATALOG });
    const game = await createLocalGame(preview.options);
    try {
      for (let tick = 0; tick < 8; tick++) game.step();
      assert.equal(game.tick, 8);
    } finally { game.dispose(); }
    assert.deepEqual(sections, original);
  }
  console.log("Starter runtime: all saved sections validated and all levels initialized and stepped.");
} finally {
  db.close();
}
assert.equal(await hash(), manifest.database.sha256, "Runtime probe must not change starter database bytes.");
