import { createLocalGame, mountLocalPreview } from "@multiplayer-game/local-preview";
import { ARTWORK_CREDIT } from "../../games/astraeum-tower/src/catalog.js";
import * as towerProject from "../../games/astraeum-tower/src/project.js";
import * as generic from "../../games/generic-grid-v1/src/project.js";
import { genericPreview, genericSkin } from "../../games/generic-grid-v1/src/runtime.js";
const {
  MAP_CELL_SIZE,
  artworkReplacementAssets,
  assignArtworkToCollision,
  createFloorDocument,
  keepCollisionBox,
  planArtworkReplacement
} = towerProject;
let {
  ASSET_CATALOG,
  DESIGN_LAYERS,
  FLOOR1_BOUNDS,
  OBJECT_TYPES,
  clampTransform,
  collisionRect,
  createDesignObject,
  createFloorMap,
  floorDocumentGrid,
  hitTest,
  isUnresolvedCollision,
  objectBounds,
  playStartProblems,
  snapTransform,
  transformAtPoint,
  validateFloorDocument
} = towerProject;
import * as towerRender from "../../games/astraeum-tower/src/design-render.js";
let { drawAsset, drawDesign } = towerRender;
import { createTowerGameModule, towerSettings } from "../../games/astraeum-tower/src/game.js";
import { towerSkinFactory } from "../../games/astraeum-tower/src/skin.js";
import { ASTRAEUM_PROJECT_ID, ASTRAEUM_FLOOR_1_MAP_ID, ASTRAEUM_MODEL } from "../project-identity.js";
import { importedAssetDefinition } from "../project-assets.js";
import "./styles.css";

const CELL = MAP_CELL_SIZE;
const mapUrl = ({ projectId, mapId }) => `/api/projects/${encodeURIComponent(projectId)}/maps/${encodeURIComponent(mapId)}`;
const projectAssetsUrl = projectId => `/api/projects/${encodeURIComponent(projectId)}/assets`;
const LAYER_PREFS_KEY = "web-studio.astraeum.layers.v1";
const layerPrefsKey = model => model === generic.MODEL ? "web-studio.generic-grid-v1.layers.v1" : LAYER_PREFS_KEY;
const PALETTE_VIEW_KEY = "web-studio.palette-view.v1";
const PALETTE_VIEWS = Object.freeze({
  large: { label: "Large", thumb: 72 },
  medium: { label: "Medium", thumb: 44 },
  small: { label: "Small", thumb: 28 },
  list: { label: "List", thumb: 0 }
});
const UNRESOLVED_LABEL = "Unresolved collision";
const HISTORY_LIMIT = 100;
const NUDGE_PX = 5;
const PLAY_BADGES = Object.freeze({
  implemented: { text: "In Play", className: "badge play" },
  partial: { text: "Partial in Play", className: "badge partial" },
  "editor-only": { text: "Editor only", className: "badge editor-only" }
});
const $ = selector => document.querySelector(selector);
const studio = $("#studio");
const canvas = $("#map-canvas");
const context = canvas.getContext("2d", { alpha: false });
const editorView = $("#editor-view");
const playHost = $("#play-host");

const state = {
  document: null,
  identity: { projectId: ASTRAEUM_PROJECT_ID, mapId: ASTRAEUM_FLOOR_1_MAP_ID },
  saving: false,
  switching: false,
  creating: false,
  model: ASTRAEUM_MODEL,
  openSelection: null,
  pendingSave: false,
  openRequest: 0,
  importedAssets: [],
  assetCatalog: towerProject.ASSET_CATALOG,
  savedJson: "",
  artwork: null,
  selectedId: null,
  tool: "select",
  placeAssetId: null,
  preview: null,
  showGrid: true,
  snap: true,
  zoom: 1,
  cameraX: 0,
  cameraY: 0,
  viewportWidth: 1,
  viewportHeight: 1,
  pixelRatio: 1,
  undo: [],
  redo: [],
  spaceDown: false,
  pointerMode: null,
  pointerStart: null,
  paletteDrag: null,
  layers: loadLayerPrefs(),
  paletteView: loadPaletteView(),
  openGroups: new Set(["walls", "props", "items", "spawns", "collision"]),
  hierarchyKey: "",
  scene: { document: null, key: "", canvas: null },
  play: { phase: "idle", game: null, mount: null, timer: null, view: null, resizeObserver: null }
};

function loadLayerPrefs(model = ASTRAEUM_MODEL) {
  const layers = model === generic.MODEL ? generic.DESIGN_LAYERS : towerProject.DESIGN_LAYERS;
  const defaults = Object.fromEntries(layers.map(layer => [layer.id,
    { visible: true, locked: layer.id === "terrain" }]));
  try {
    const stored = JSON.parse(localStorage.getItem(layerPrefsKey(model)) ?? "null");
    if (stored && typeof stored === "object") {
      for (const layer of layers) {
        const value = stored[layer.id];
        if (value && typeof value.visible === "boolean" && typeof value.locked === "boolean") {
          defaults[layer.id] = { visible: value.visible, locked: value.locked };
        }
      }
    }
  } catch {
    // Ignore unreadable editor preferences; they are not part of the design.
  }
  return defaults;
}

function loadPaletteView() {
  try {
    const stored = localStorage.getItem(PALETTE_VIEW_KEY);
    return Object.hasOwn(PALETTE_VIEWS, stored) ? stored : "medium";
  } catch {
    return "medium";
  }
}

function saveLayerPrefs() {
  try {
    localStorage.setItem(layerPrefsKey(state.model), JSON.stringify(state.layers));
  } catch {
    // Preferences are optional.
  }
}

async function loadProjectAssets(projectId, model) {
  const response = await fetch(projectAssetsUrl(projectId));
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? `Asset catalog failed (${response.status}).`);
  const baseCatalog = model === generic.MODEL ? generic.ASSET_CATALOG : towerProject.ASSET_CATALOG;
  const catalog = { ...baseCatalog };
  const images = {};
  for (const record of payload.assets) {
    if (record.projectId !== projectId || !/^asset-[a-f0-9]{64}$/.test(record.assetId)) {
      throw new Error("The imported asset catalog contains an invalid project identity.");
    }
    catalog[record.assetId] = importedAssetDefinition(record, model);
    const imageResponse = await fetch(`${projectAssetsUrl(projectId)}/${record.assetId}`);
    if (!imageResponse.ok) throw new Error(`Could not load imported image ${record.name}.`);
    const image = new Image();
    const imageUrl = URL.createObjectURL(await imageResponse.blob());
    image.src = imageUrl;
    try {
      await image.decode();
    } finally {
      URL.revokeObjectURL(imageUrl);
    }
    if (image.naturalWidth !== record.width || image.naturalHeight !== record.height) {
      throw new Error(`Imported image ${record.name} dimensions do not match its catalog.`);
    }
    images[record.assetId] = image;
  }
  return { catalog, images, records: payload.assets };
}

const isPlaying = () => state.play.phase !== "idle";
const selectedObject = () => state.document?.objects.find(object => object.id === state.selectedId) ?? null;
const isSelectable = object => state.layers[object.layer].visible && !state.layers[object.layer].locked;
const layerName = id => DESIGN_LAYERS.find(layer => layer.id === id).name;

function dirty() {
  return JSON.stringify(state.document) !== state.savedJson;
}

function setStatus(message, isError = false) {
  const status = $("#status");
  status.textContent = message;
  status.classList.toggle("error", isError);
}

// ---------------------------------------------------------------- history

function pushUndo(before) {
  state.undo.push(before);
  if (state.undo.length > HISTORY_LIMIT) state.undo.shift();
  state.redo.length = 0;
}

/** Documents are never mutated in place, so history can keep references. */
function commitDocument(next, before = state.document) {
  state.document = validateFloorDocument(next);
  pushUndo(before);
  refreshChrome();
}

function replaceObject(document, id, patch) {
  return { ...document, objects: document.objects.map(object => object.id === id ? { ...object, ...patch } : object) };
}

function undo() {
  if (!state.undo.length || isPlaying()) return;
  state.redo.push(state.document);
  state.document = state.undo.pop();
  if (!selectedObject()) state.selectedId = null;
  refreshChrome();
  setStatus("Undone.");
}

function redo() {
  if (!state.redo.length || isPlaying()) return;
  state.undo.push(state.document);
  state.document = state.redo.pop();
  if (!selectedObject()) state.selectedId = null;
  refreshChrome();
  setStatus("Redone.");
}

// ---------------------------------------------------------------- chrome

function refreshChrome({ structure = true } = {}) {
  const loaded = Boolean(state.document);
  const isDirty = loaded && dirty();
  $("#save-state").textContent = !loaded ? "Not loaded" : isDirty ? "● Unsaved changes" : "✓ Saved";
  $("#save-state").className = `save-state ${isDirty || !loaded ? "dirty" : "saved"}`;
  $("#save").disabled = !loaded || !isDirty || isPlaying();
  $("#save").disabled ||= state.saving;
  $("#open-game").disabled = isPlaying() || state.saving || state.switching || !state.artwork;
  $("#new-game").disabled = isPlaying() || state.saving || state.switching || state.creating || !state.artwork;
  $("#import-assets").disabled = !loaded || isPlaying() || state.saving || state.switching || state.creating;
  $("#play").disabled = !loaded || isPlaying() || state.saving || !state.artwork;
  $("#undo").disabled = state.undo.length === 0 || isPlaying();
  $("#redo").disabled = state.redo.length === 0 || isPlaying();
  $("#zoom-label").textContent = `${Math.round(state.zoom * 100)}%`;
  $("#select-tool").classList.toggle("active", state.tool === "select");
  $("#place-tool").classList.toggle("active", state.tool === "place");
  $("#place-tool").disabled = !state.placeAssetId;
  $("#place-asset-label").textContent = state.placeAssetId ? ASSET_CATALOG[state.placeAssetId].label : "—";
  canvas.classList.toggle("selecting", state.tool === "select");
  for (const card of $("#asset-list").querySelectorAll(".asset-card")) {
    card.classList.toggle("active", state.tool === "place" && card.dataset.assetId === state.placeAssetId);
  }
  if (loaded) {
    updateInspector();
    if (structure) {
      updateLayers();
      updateHierarchy();
    }
  }
  render();
}

function updateLayers() {
  const list = $("#layer-list");
  const counts = layerCounts();
  list.replaceChildren(...DESIGN_LAYERS.map(layer => {
    const prefs = state.layers[layer.id];
    const row = document.createElement("div");
    row.className = `layer-row${prefs.locked ? " locked" : ""}${prefs.visible ? "" : " hidden-layer"}`;
    row.dataset.layer = layer.id;
    const name = document.createElement("span");
    name.className = "layer-name";
    name.textContent = `${layer.name}`;
    const count = document.createElement("small");
    count.textContent = String(counts[layer.id]);
    const visible = document.createElement("button");
    visible.type = "button";
    visible.className = `layer-toggle${prefs.visible ? " on" : ""}`;
    visible.dataset.action = "visible";
    visible.setAttribute("aria-pressed", String(prefs.visible));
    visible.setAttribute("aria-label", `${prefs.visible ? "Hide" : "Show"} ${layer.name} layer`);
    visible.title = prefs.visible ? "Visible — click to hide" : "Hidden — click to show";
    visible.textContent = prefs.visible ? "👁" : "◌";
    visible.addEventListener("click", () => {
      prefs.visible = !prefs.visible;
      afterLayerChange();
    });
    const lock = document.createElement("button");
    lock.type = "button";
    lock.className = `layer-toggle${prefs.locked ? " on" : ""}`;
    lock.dataset.action = "lock";
    lock.setAttribute("aria-pressed", String(prefs.locked));
    lock.setAttribute("aria-label", `${prefs.locked ? "Unlock" : "Lock"} ${layer.name} layer`);
    lock.title = prefs.locked ? "Locked: visible but not selectable — click to unlock" : "Unlocked — click to lock";
    lock.textContent = prefs.locked ? "🔒" : "🔓";
    lock.addEventListener("click", () => {
      prefs.locked = !prefs.locked;
      afterLayerChange();
    });
    row.append(visible, lock, name, count);
    return row;
  }));
}

function afterLayerChange() {
  saveLayerPrefs();
  const selected = selectedObject();
  if (selected && !isSelectable(selected)) state.selectedId = null;
  state.hierarchyKey = "";
  refreshChrome();
}

function layerCounts() {
  const counts = Object.fromEntries(DESIGN_LAYERS.map(layer => [layer.id, 0]));
  for (const object of state.document?.objects ?? []) counts[object.layer] += 1;
  return counts;
}

function updateHierarchy() {
  const objects = state.document.objects;
  const unresolved = objects.filter(isUnresolvedCollision);
  const key = `${objects.length}|${objects.map(object => object.id).join(",").length}|${state.selectedId}|` +
    `${unresolved.map(object => object.id).join(",")}|` +
    `${JSON.stringify(state.layers)}|${[...state.openGroups].join(",")}|${state.undo.length}|${state.redo.length}`;
  if (key === state.hierarchyKey) return;
  state.hierarchyKey = key;
  $("#object-count").textContent = String(objects.length);
  const tree = $("#object-tree");
  const scrollTop = tree.scrollTop;
  const groups = DESIGN_LAYERS.map(layer => {
    const members = objects.filter(object => object.layer === layer.id)
      .sort((left, right) => left.order - right.order);
    const details = document.createElement("details");
    details.className = "tree-group";
    details.dataset.layer = layer.id;
    details.open = state.openGroups.has(layer.id);
    const summary = document.createElement("summary");
    const prefs = state.layers[layer.id];
    const unresolvedHere = members.filter(isUnresolvedCollision).length;
    summary.textContent = `${layer.name} (${members.length})${unresolvedHere ? ` · ${unresolvedHere} unresolved` : ""}` +
      `${prefs.locked ? " · locked" : ""}${prefs.visible ? "" : " · hidden"}`;
    details.append(summary);
    details.addEventListener("toggle", () => {
      if (!details.isConnected || details.open === state.openGroups.has(layer.id)) return;
      if (details.open) state.openGroups.add(layer.id);
      else state.openGroups.delete(layer.id);
      if (details.open && members.length && !details.querySelector(".tree-item")) {
        state.hierarchyKey = "";
        updateHierarchy();
      }
    });
    if (details.open) {
      const fragment = document.createDocumentFragment();
      for (const object of members) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = `tree-item${object.id === state.selectedId ? " selected" : ""}`;
        item.dataset.objectId = object.id;
        item.setAttribute("role", "treeitem");
        item.disabled = !isSelectable(object);
        const unresolvedItem = isUnresolvedCollision(object);
        item.title = item.disabled ? `${layer.name} layer is ${prefs.locked ? "locked" : "hidden"}`
          : unresolvedItem ? `${UNRESOLVED_LABEL}: former off-grid format 1 wall with no artwork` : ASSET_CATALOG[object.assetId].label;
        const glyph = document.createElement("span");
        glyph.className = `type-glyph type-${object.type}`;
        glyph.textContent = unresolvedItem ? "⚠" : { "terrain-tile": "▦", wall: "▧", prop: "◆", item: "✦", spawn: "◎", collision: "▢" }[object.type];
        const label = document.createElement("span");
        label.textContent = object.id;
        item.append(glyph, label);
        if (unresolvedItem) {
          item.classList.add("unresolved");
          const flag = document.createElement("span");
          flag.className = "unresolved-flag";
          flag.textContent = UNRESOLVED_LABEL;
          item.append(flag);
        } else if (object.migration) {
          const flag = document.createElement("span");
          flag.className = "migrated-flag";
          flag.title = object.migration.note;
          flag.textContent = "migrated";
          item.append(flag);
        }
        item.addEventListener("click", () => selectObject(object.id, { reveal: true }));
        fragment.append(item);
      }
      details.append(fragment);
    }
    return details;
  });
  tree.replaceChildren(...groups);
  tree.scrollTop = scrollTop;
  tree.querySelector(".tree-item.selected")?.scrollIntoView({ block: "nearest" });
}

function updateInspector() {
  updateUnresolvedSummary();
  const object = selectedObject();
  $("#empty-inspector").hidden = Boolean(object);
  $("#object-inspector").hidden = !object;
  if (!object) return;
  const asset = ASSET_CATALOG[object.assetId];
  const bounds = objectBounds(object);
  const unresolved = isUnresolvedCollision(object);
  $("#object-id").value = object.id;
  $("#object-type").textContent = unresolved ? `${UNRESOLVED_LABEL} (${OBJECT_TYPES[object.type].label.toLowerCase()})`
    : asset.importedInfo ? `${OBJECT_TYPES[object.type].label} · ${asset.importedInfo.category} artwork (visual only)`
      : OBJECT_TYPES[object.type].label;
  $("#object-asset").textContent = `${asset.label} (${object.assetId})`;
  $("#object-layer").textContent = `${layerName(object.layer)} (fixed by type)`;
  $("#object-order").textContent = String(object.order);
  $("#object-size").textContent = `${bounds.width} × ${bounds.height} px`;
  for (const [axis, field] of [["x", $("#object-x")], ["y", $("#object-y")]]) {
    if (document.activeElement !== field) field.value = String(object.transform[axis]);
    field.step = asset.snap.forced ? String(CELL) : "1";
  }
  const collision = $("#object-collision");
  collision.checked = Boolean(object.collision);
  collision.disabled = asset.collision !== "optional";
  $("#object-collision-label").textContent = asset.collision === "none"
    ? "No collision (asset defines none)"
    : asset.collision === "required"
      ? `Collision ${asset.collisionBox.width} × ${asset.collisionBox.height} (required)`
      : `Collision ${asset.collisionBox.width} × ${asset.collisionBox.height} (optional)`;
  const badge = PLAY_BADGES[asset.play];
  $("#object-play").textContent = `${badge.text}. ${asset.playNote}`;
  $("#object-play").className = `play-note ${asset.play}`;
  $("#object-artwork").textContent = asset.importedInfo
    ? `Imported artwork · ${asset.importedInfo.author} · ${asset.importedInfo.source}` +
      (asset.importedInfo.direction ? ` · ${asset.importedInfo.direction}` : "") +
      ` · SHA-256 ${asset.importedInfo.sha256}`
    : asset.artwork
    ? `Artwork: ${asset.artwork.file} region ${asset.artwork.region.x},${asset.artwork.region.y} ` +
      `${asset.artwork.region.width}×${asset.artwork.region.height} · ${ARTWORK_CREDIT}`
    : asset.type === "collision" ? "No artwork: an invisible collision-only blocker, not a wall." : "No artwork: shown as a placeholder.";
  $("#object-migration").hidden = !object.migration || unresolved;
  $("#object-migration").textContent = object.migration ? `Migration: ${object.migration.note}` : "";
  $("#unresolved-panel").hidden = !unresolved;
  if (unresolved) {
    $("#unresolved-origin").textContent =
      `Origin: format 1 wall ${object.id} sat off the 32 px grid, so format 1 drew its cell with the floor tile ` +
      "while it still blocked movement. The migration could not tell which artwork was intended, so it kept " +
      "the exact 32 × 32 collision as this box and left the original document untouched in the database backup. " +
      "It keeps blocking movement in Play until you choose an action below.";
    updateResolveOutcome();
  }
  $("#delete-object").hidden = unresolved;
  $("#delete-object").disabled = Boolean(asset.required);
  $("#delete-object").title = asset.required ? `${asset.label} is required; move it instead.` : "Delete (Del)";
}

function updateUnresolvedSummary() {
  const count = state.document?.objects.filter(isUnresolvedCollision).length ?? 0;
  $("#unresolved-summary").hidden = count === 0;
  $("#unresolved-count").textContent = `⚠ ${count} ${UNRESOLVED_LABEL.toLowerCase()}${count === 1 ? "" : "s"} from the migration`;
}

function updateResolveOutcome() {
  const object = selectedObject();
  if (!object || !isUnresolvedCollision(object)) return;
  const plan = planArtworkReplacement(object, $("#resolve-asset").value);
  $("#resolve-outcome").textContent = plan.text;
  $("#resolve-outcome").dataset.outcome = plan.outcome;
}

function configureResolveActions() {
  const select = $("#resolve-asset");
  select.replaceChildren(...artworkReplacementAssets().map(assetId => {
    const asset = ASSET_CATALOG[assetId];
    const option = document.createElement("option");
    option.value = assetId;
    option.textContent = `${asset.label} — ${OBJECT_TYPES[asset.type].label}${asset.play === "editor-only" ? " (editor only)" : ""}`;
    return option;
  }));
  select.value = "wall-damp-stone";
  select.addEventListener("change", updateResolveOutcome);
  $("#resolve-assign").addEventListener("click", () => {
    const object = selectedObject();
    if (!object || !isUnresolvedCollision(object)) return;
    const assetId = select.value;
    const plan = planArtworkReplacement(object, assetId);
    commitDocument(assignArtworkToCollision(state.document, object.id, assetId));
    setStatus(`${object.id} now uses ${ASSET_CATALOG[assetId].label} artwork. ${plan.text} Undo with Ctrl+Z.`);
  });
  $("#resolve-keep").addEventListener("click", () => {
    const object = selectedObject();
    if (!object || !isUnresolvedCollision(object)) return;
    commitDocument(keepCollisionBox(state.document, object.id));
    setStatus(`${object.id} kept as an intentional collision box; it still blocks movement in Play. Undo with Ctrl+Z.`);
  });
  $("#resolve-delete").addEventListener("click", () => {
    const object = selectedObject();
    if (!object || !isUnresolvedCollision(object)) return;
    deleteSelected();
    setStatus(`Deleted ${object.id}; its collision is removed and the spot is walkable in Play. Undo with Ctrl+Z.`);
  });
  $("#next-unresolved").addEventListener("click", () => {
    const unresolved = state.document.objects.filter(isUnresolvedCollision);
    if (!unresolved.length) return;
    const index = unresolved.findIndex(object => object.id === state.selectedId);
    const next = unresolved[(index + 1) % unresolved.length];
    const layer = state.layers[next.layer];
    if (!layer.visible || layer.locked) {
      layer.visible = true;
      layer.locked = false;
      saveLayerPrefs();
      state.hierarchyKey = "";
    }
    state.openGroups.add(next.layer);
    selectObject(next.id, { reveal: true });
    setStatus(`Reviewing ${next.id} (${UNRESOLVED_LABEL.toLowerCase()}): assign artwork, keep it, or delete it.`);
  });
}

function selectObject(id, { reveal = false } = {}) {
  state.selectedId = id;
  if (reveal && id) {
    const object = selectedObject();
    const bounds = objectBounds(object);
    const visibleWidth = state.viewportWidth / state.zoom;
    const visibleHeight = state.viewportHeight / state.zoom;
    if (bounds.x < state.cameraX || bounds.y < state.cameraY ||
        bounds.x + bounds.width > state.cameraX + visibleWidth ||
        bounds.y + bounds.height > state.cameraY + visibleHeight) {
      state.cameraX = bounds.x + bounds.width / 2 - visibleWidth / 2;
      state.cameraY = bounds.y + bounds.height / 2 - visibleHeight / 2;
    }
  }
  canvas.focus();
  refreshChrome();
}

function setTool(tool) {
  state.tool = tool === "place" && state.placeAssetId ? "place" : "select";
  if (state.tool === "select") state.preview = null;
  refreshChrome({ structure: false });
}

// ---------------------------------------------------------------- rendering

function visibleLayers() {
  return Object.fromEntries(DESIGN_LAYERS.map(layer => [layer.id, state.layers[layer.id].visible]));
}

function sceneCanvas() {
  const visible = visibleLayers();
  const key = JSON.stringify(visible);
  const scene = state.scene;
  if (scene.document === state.document && scene.key === key && scene.canvas) return scene.canvas;
  if (!scene.canvas) {
    scene.canvas = document.createElement("canvas");
  }
  scene.canvas.width = FLOOR1_BOUNDS.width;
  scene.canvas.height = FLOOR1_BOUNDS.height;
  const sceneContext = scene.canvas.getContext("2d", { alpha: false });
  sceneContext.imageSmoothingEnabled = false;
  drawDesign(sceneContext, state.artwork, state.document, {
    grid: floorDocumentGrid(state.document),
    map: createFloorMap(state.document),
    mode: "editor",
    visible
  });
  scene.document = state.document;
  scene.key = key;
  return scene.canvas;
}

function drawMap() {
  context.setTransform(state.pixelRatio, 0, 0, state.pixelRatio, 0, 0);
  context.imageSmoothingEnabled = false;
  context.fillStyle = "#14161a";
  context.fillRect(0, 0, state.viewportWidth, state.viewportHeight);
  const scale = state.pixelRatio * state.zoom;
  context.setTransform(scale, 0, 0, scale, -state.cameraX * scale, -state.cameraY * scale);
  context.imageSmoothingEnabled = false;
  context.drawImage(sceneCanvas(), 0, 0);
  const line = 1 / state.zoom;
  if (state.showGrid) {
    context.save();
    context.strokeStyle = "#d4e4f21b";
    context.lineWidth = line;
    context.beginPath();
    for (let x = 0; x <= FLOOR1_BOUNDS.width; x += CELL) {
      context.moveTo(x, 0);
      context.lineTo(x, FLOOR1_BOUNDS.height);
    }
    for (let y = 0; y <= FLOOR1_BOUNDS.height; y += CELL) {
      context.moveTo(0, y);
      context.lineTo(FLOOR1_BOUNDS.width, y);
    }
    context.stroke();
    context.restore();
  }
  const selected = selectedObject();
  if (selected) {
    const bounds = objectBounds(selected);
    context.save();
    context.strokeStyle = "#ffcc55";
    context.lineWidth = 2 * line;
    context.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
    const rect = collisionRect(selected);
    if (rect) {
      context.strokeStyle = "#59d8ff";
      context.setLineDash([3 * line, 2 * line]);
      context.lineWidth = line;
      context.strokeRect(rect.x, rect.y, rect.width, rect.height);
    }
    context.setLineDash([]);
    context.fillStyle = "#ffcc55";
    context.fillRect(selected.transform.x - 2 * line, selected.transform.y - 2 * line, 4 * line, 4 * line);
    context.restore();
  }
  const preview = state.preview;
  if (preview) {
    const bounds = drawAsset(context, state.artwork, preview.assetId, preview.transform, { alpha: 0.65 });
    context.save();
    context.strokeStyle = preview.problem ? "#ff6670" : "#7dffa8";
    context.lineWidth = 2 * line;
    context.setLineDash([4 * line, 3 * line]);
    context.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
    context.restore();
  }
  const counts = layerCounts();
  canvas.dataset.cameraX = String(state.cameraX);
  canvas.dataset.cameraY = String(state.cameraY);
  canvas.dataset.zoom = String(state.zoom);
  canvas.dataset.objectCount = String(state.document.objects.length);
  canvas.dataset.wallCount = String(state.document.objects.filter(object => object.type === "wall").length);
  canvas.dataset.layerCounts = JSON.stringify(counts);
  canvas.dataset.selectedId = state.selectedId ?? "";
  canvas.dataset.tool = state.tool;
  canvas.dataset.preview = preview ? `${preview.assetId}@${preview.transform.x},${preview.transform.y}${preview.problem ? ":invalid" : ""}` : "";
}

function render() {
  if (!state.artwork || !state.document || isPlaying()) return;
  drawMap();
}

function resize() {
  const rect = canvas.getBoundingClientRect();
  state.viewportWidth = Math.max(1, Math.floor(rect.width));
  state.viewportHeight = Math.max(1, Math.floor(rect.height));
  state.pixelRatio = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.round(state.viewportWidth * state.pixelRatio);
  canvas.height = Math.round(state.viewportHeight * state.pixelRatio);
  render();
}

function centerCamera() {
  state.cameraX = (FLOOR1_BOUNDS.width - state.viewportWidth / state.zoom) / 2;
  state.cameraY = (FLOOR1_BOUNDS.height - state.viewportHeight / state.zoom) / 2;
}

function setZoom(nextZoom, anchorX = state.viewportWidth / 2, anchorY = state.viewportHeight / 2) {
  const worldX = state.cameraX + anchorX / state.zoom;
  const worldY = state.cameraY + anchorY / state.zoom;
  state.zoom = Math.max(0.25, Math.min(4, nextZoom));
  state.cameraX = worldX - anchorX / state.zoom;
  state.cameraY = worldY - anchorY / state.zoom;
  refreshChrome({ structure: false });
}

function worldPointFromClient(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (clientX - rect.left) / state.zoom + state.cameraX,
    y: (clientY - rect.top) / state.zoom + state.cameraY
  };
}

function overCanvas(clientX, clientY) {
  if (editorView.hidden) return false;
  const rect = canvas.getBoundingClientRect();
  return clientX >= rect.left && clientX < rect.right && clientY >= rect.top && clientY < rect.bottom;
}

// ---------------------------------------------------------------- placement

function placementTransform(assetId, point) {
  let transform = transformAtPoint(assetId, point);
  if (state.snap || ASSET_CATALOG[assetId].snap.forced) transform = snapTransform(assetId, transform);
  return clampTransform(assetId, transform, FLOOR1_BOUNDS);
}

function placementProblem(assetId, transform) {
  const asset = ASSET_CATALOG[assetId];
  if (asset.size.width > FLOOR1_BOUNDS.width || asset.size.height > FLOOR1_BOUNDS.height) {
    return `${asset.label} (${asset.size.width}×${asset.size.height} px) is larger than this ` +
      `${FLOOR1_BOUNDS.width}×${FLOOR1_BOUNDS.height} px map and cannot be placed.`;
  }
  const layer = OBJECT_TYPES[asset.type].layer;
  if (state.layers[layer].locked) return `The ${layerName(layer)} layer is locked. Unlock it in Layers to place ${asset.label}.`;
  if (!state.layers[layer].visible) return `The ${layerName(layer)} layer is hidden. Show it in Layers to place ${asset.label}.`;
  if (asset.unique && state.document.objects.some(object => object.assetId === assetId)) {
    return `Only one ${asset.label} is allowed. Select and move the existing one.`;
  }
  if (asset.type === "terrain-tile" && state.document.objects.some(object => object.type === "terrain-tile" &&
      object.transform.x === transform.x && object.transform.y === transform.y)) {
    return "This cell already has a terrain tile.";
  }
  return null;
}

function previewAt(assetId, point) {
  const transform = placementTransform(assetId, point);
  return { assetId, transform, problem: placementProblem(assetId, transform) };
}

function nextObjectId(assetId) {
  const ids = new Set(state.document.objects.map(object => object.id));
  let number = 1;
  while (ids.has(`${assetId}-${number}`)) number += 1;
  return `${assetId}-${number}`;
}

function placeFromPreview(preview) {
  if (!preview) return;
  if (preview.problem) {
    setStatus(preview.problem, true);
    return;
  }
  const asset = ASSET_CATALOG[preview.assetId];
  const layer = OBJECT_TYPES[asset.type].layer;
  const order = Math.max(-1, ...state.document.objects.filter(object => object.layer === layer)
    .map(object => object.order)) + 1;
  const object = createDesignObject(nextObjectId(preview.assetId), preview.assetId, preview.transform, order);
  commitDocument({ ...state.document, objects: [...state.document.objects, object] });
  state.selectedId = object.id;
  refreshChrome();
  const note = asset.play === "editor-only" ? " Editor only — no gameplay yet." :
    asset.play === "partial" ? ` ${asset.playNote}` : "";
  setStatus(`Placed ${asset.label} (${object.id}) at ${object.transform.x}, ${object.transform.y}.${note}`);
}

function armPlace(assetId) {
  state.placeAssetId = assetId;
  state.tool = "place";
  state.preview = null;
  const asset = ASSET_CATALOG[assetId];
  setStatus(`Place ${asset.label}: click the map (Esc to cancel).` +
    (asset.play === "editor-only" ? " Editor only — no gameplay yet." : ""));
  refreshChrome({ structure: false });
  canvas.focus();
}

// ---------------------------------------------------------------- editing

function moveSelectedTo(transform, { snap = false } = {}) {
  const object = selectedObject();
  if (!object) return;
  const asset = ASSET_CATALOG[object.assetId];
  let next = { x: Math.round(transform.x), y: Math.round(transform.y) };
  if (snap || asset.snap.forced) next = snapTransform(object.assetId, next);
  next = clampTransform(object.assetId, next, FLOOR1_BOUNDS);
  if (next.x === object.transform.x && next.y === object.transform.y) {
    refreshChrome({ structure: false });
    return;
  }
  commitDocument(replaceObject(state.document, object.id, { transform: next }));
}

function nudgeSelected(dx, dy) {
  const object = selectedObject();
  if (!object) return;
  const step = ASSET_CATALOG[object.assetId].snap.forced ? CELL : NUDGE_PX;
  moveSelectedTo({ x: object.transform.x + dx * step, y: object.transform.y + dy * step });
  const moved = selectedObject();
  setStatus(`Nudged ${moved.id} to ${moved.transform.x}, ${moved.transform.y}.`);
}

function deleteSelected() {
  const object = selectedObject();
  if (!object) return;
  if (ASSET_CATALOG[object.assetId].required) {
    setStatus(`${ASSET_CATALOG[object.assetId].label} is required and cannot be deleted; move it instead.`, true);
    return;
  }
  commitDocument({ ...state.document, objects: state.document.objects.filter(item => item.id !== object.id) });
  state.selectedId = null;
  refreshChrome();
  setStatus(`Deleted ${object.id}.`);
}

function pointerDown(event) {
  if (isPlaying() || !state.document) return;
  canvas.focus();
  if (event.button === 1 || (event.button === 0 && state.spaceDown)) {
    state.pointerMode = "pan";
    state.pointerStart = { x: event.clientX, y: event.clientY, cameraX: state.cameraX, cameraY: state.cameraY };
    canvas.classList.add("panning");
    canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
    return;
  }
  if (event.button !== 0) return;
  const point = worldPointFromClient(event.clientX, event.clientY);
  if (state.tool === "place" && state.placeAssetId) {
    placeFromPreview(previewAt(state.placeAssetId, point));
    state.preview = previewAt(state.placeAssetId, point);
    render();
    return;
  }
  const object = hitTest(state.document, point, isSelectable);
  if (!object) {
    state.selectedId = null;
    refreshChrome();
    return;
  }
  state.selectedId = object.id;
  state.pointerMode = "move";
  state.pointerStart = { point, transform: object.transform, before: state.document, id: object.id };
  canvas.setPointerCapture(event.pointerId);
  refreshChrome();
}

function pointerMove(event) {
  if (state.pointerMode === "pan") {
    state.cameraX = state.pointerStart.cameraX - (event.clientX - state.pointerStart.x) / state.zoom;
    state.cameraY = state.pointerStart.cameraY - (event.clientY - state.pointerStart.y) / state.zoom;
    render();
    return;
  }
  const point = worldPointFromClient(event.clientX, event.clientY);
  if (state.pointerMode === "move") {
    const start = state.pointerStart;
    const assetId = start.before.objects.find(item => item.id === start.id).assetId;
    let transform = {
      x: Math.round(start.transform.x + point.x - start.point.x),
      y: Math.round(start.transform.y + point.y - start.point.y)
    };
    if (state.snap || ASSET_CATALOG[assetId].snap.forced) transform = snapTransform(assetId, transform);
    transform = clampTransform(assetId, transform, FLOOR1_BOUNDS);
    state.document = replaceObject(start.before, start.id, { transform });
    refreshChrome({ structure: false });
    return;
  }
  if (state.tool === "place" && state.placeAssetId && !state.paletteDrag) {
    state.preview = previewAt(state.placeAssetId, point);
    render();
  }
}

function pointerUp() {
  if (state.pointerMode === "pan") canvas.classList.remove("panning");
  if (state.pointerMode === "move") {
    const { before, id } = state.pointerStart;
    if (state.document !== before) {
      try {
        state.document = validateFloorDocument(state.document);
        pushUndo(before);
        const object = selectedObject();
        setStatus(`Moved ${id} to ${object.transform.x}, ${object.transform.y}.`);
      } catch (error) {
        state.document = before;
        setStatus(`Move rejected: ${error.message}`, true);
      }
    }
  }
  state.pointerMode = null;
  state.pointerStart = null;
  refreshChrome();
}

// ---------------------------------------------------------------- palette

function assetThumbnail(assetId, size) {
  const asset = ASSET_CATALOG[assetId];
  const thumb = document.createElement("canvas");
  thumb.width = size;
  thumb.height = size;
  thumb.className = "asset-thumb";
  const thumbContext = thumb.getContext("2d");
  thumbContext.imageSmoothingEnabled = false;
  const maxScale = size >= 64 ? 3 : 2;
  const scale = Math.min(maxScale, (size - 4) / asset.size.width, (size - 4) / asset.size.height);
  thumbContext.setTransform(scale, 0, 0, scale,
    (size - asset.size.width * scale) / 2, (size - asset.size.height * scale) / 2);
  drawAsset(thumbContext, state.artwork, assetId, { x: asset.pivot.x, y: asset.pivot.y });
  return thumb;
}

function setPaletteView(view) {
  if (!Object.hasOwn(PALETTE_VIEWS, view)) return;
  state.paletteView = view;
  try {
    localStorage.setItem(PALETTE_VIEW_KEY, view);
  } catch {
    // Display preferences are optional and never part of the design.
  }
  configurePalette();
  refreshChrome({ structure: false });
}

function configurePaletteView() {
  for (const button of $("#palette-view").querySelectorAll("button")) {
    button.addEventListener("click", () => setPaletteView(button.dataset.view));
  }
}

function configurePalette() {
  const list = $("#asset-list");
  const view = state.paletteView;
  const thumbSize = PALETTE_VIEWS[view].thumb;
  list.className = `asset-list view-${view}`;
  list.dataset.view = view;
  for (const button of $("#palette-view").querySelectorAll("button")) {
    const active = button.dataset.view === view;
    button.classList.toggle("active", active);
    button.setAttribute("aria-checked", String(active));
  }
  list.replaceChildren();
  for (const type of Object.keys(OBJECT_TYPES)) {
    const entries = Object.entries(ASSET_CATALOG).filter(([, asset]) => asset.type === type);
    if (!entries.length) continue;
    const group = document.createElement("div");
    group.className = "asset-group";
    const heading = document.createElement("span");
    heading.className = "asset-group-title";
    heading.textContent = OBJECT_TYPES[type].label;
    group.append(heading);
    for (const [assetId, asset] of entries) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "asset-card";
      card.dataset.assetId = assetId;
      card.dataset.type = asset.type;
      card.dataset.playStatus = asset.play;
      const credit = asset.importedInfo
        ? `${asset.importedInfo.author} · ${asset.importedInfo.source} · ${asset.importedInfo.category} artwork`
        : asset.artwork
        ? `${asset.artwork.file} [${asset.artwork.region.x},${asset.artwork.region.y} ${asset.artwork.region.width}×${asset.artwork.region.height}] · ${ARTWORK_CREDIT}`
        : "No artwork";
      card.title = `${asset.label} — ${OBJECT_TYPES[asset.type].label}\n${asset.details}\n${asset.playNote}\n${credit}`;
      card.setAttribute("aria-label", `${asset.label}, ${OBJECT_TYPES[asset.type].label}. ${PLAY_BADGES[asset.play].text}.`);
      const copy = document.createElement("span");
      copy.className = "asset-copy";
      const title = document.createElement("strong");
      title.textContent = asset.label;
      title.title = asset.label;
      const badge = document.createElement("span");
      const badgeInfo = PLAY_BADGES[asset.play];
      badge.className = badgeInfo.className;
      badge.dataset.testid = "play-badge";
      badge.textContent = badgeInfo.text;
      if (asset.play === "editor-only") badge.title = "Editor only — no gameplay yet. Saved with the design but not used by Play.";
      const small = document.createElement("small");
      small.textContent = asset.importedInfo
        ? `${asset.importedInfo.direction ?? asset.importedInfo.category} · ${asset.importedInfo.author} · ${asset.importedInfo.source}`
        : asset.artwork ? `${asset.artwork.file} · ${ARTWORK_CREDIT}` : asset.type === "collision" ? "No artwork · invisible blocker" : "No artwork · placeholder";
      copy.append(title, badge, small);
      if (thumbSize) card.append(assetThumbnail(assetId, thumbSize));
      else {
        const glyph = document.createElement("span");
        glyph.className = `type-glyph type-${asset.type}`;
        glyph.setAttribute("aria-hidden", "true");
        glyph.textContent = { "terrain-tile": "▦", wall: "▧", prop: "◆", item: "✦", spawn: "◎", collision: "▢" }[asset.type];
        card.append(glyph);
      }
      card.append(copy);
      card.addEventListener("pointerdown", event => paletteDown(event, assetId, card));
      card.addEventListener("pointermove", paletteMove);
      card.addEventListener("pointerup", paletteUp);
      card.addEventListener("pointercancel", paletteCancel);
      card.addEventListener("keydown", event => {
        if (event.code === "Enter" || event.code === "Space") {
          event.preventDefault();
          armPlace(assetId);
        }
      });
      group.append(card);
    }
    list.append(group);
  }
}

function paletteDown(event, assetId, card) {
  if (event.button !== 0 || isPlaying() || !state.document) return;
  event.preventDefault();
  card.setPointerCapture(event.pointerId);
  state.paletteDrag = { assetId, x: event.clientX, y: event.clientY, dragging: false };
}

function paletteMove(event) {
  const drag = state.paletteDrag;
  if (!drag) return;
  if (!drag.dragging && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 4) {
    drag.dragging = true;
    document.body.classList.add("dragging-asset");
  }
  if (!drag.dragging) return;
  state.preview = overCanvas(event.clientX, event.clientY)
    ? previewAt(drag.assetId, worldPointFromClient(event.clientX, event.clientY))
    : null;
  render();
}

function paletteUp(event) {
  const drag = state.paletteDrag;
  if (!drag) return;
  state.paletteDrag = null;
  document.body.classList.remove("dragging-asset");
  if (!drag.dragging) {
    armPlace(drag.assetId);
    return;
  }
  if (overCanvas(event.clientX, event.clientY)) {
    placeFromPreview(previewAt(drag.assetId, worldPointFromClient(event.clientX, event.clientY)));
  } else {
    setStatus("Placement cancelled: drop the asset onto the map.");
  }
  state.preview = null;
  refreshChrome({ structure: false });
}

function paletteCancel() {
  state.paletteDrag = null;
  state.preview = null;
  document.body.classList.remove("dragging-asset");
  render();
}

// ---------------------------------------------------------------- save

async function save() {
  if (!state.document || isPlaying() || state.saving) return false;
  const identity = { ...state.identity };
  const document = structuredClone(state.document);
  state.saving = true;
  refreshChrome({ structure: false });
  try {
    const response = await fetch(mapUrl(identity), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: identity.projectId, model: state.model, document })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? `Save failed (${response.status}).`);
    if (payload.projectId !== identity.projectId || payload.mapId !== identity.mapId ||
        payload.model !== state.model || payload.document?.id !== identity.mapId) {
      throw new Error("The saved design identity did not match the requested project and map.");
    }
    state.savedJson = JSON.stringify(validateFloorDocument(payload.document));
    setStatus("Map saved to the local Studio database.");
    return true;
  } catch (error) {
    setStatus(`Save failed: ${error.message}`, true);
    return false;
  } finally {
    state.saving = false;
    refreshChrome();
  }
}

// ---------------------------------------------------------------- play

const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => resolve()));

function showPlayError(message) {
  $("#play-error-message").textContent = message;
  $("#play-error").hidden = false;
  studio.dataset.playState = "error";
  setStatus(`Play could not start: ${message}`, true);
}

function teardownPlay() {
  const play = state.play;
  if (play.timer) window.clearInterval(play.timer);
  play.resizeObserver?.disconnect();
  try {
    play.mount?.dispose();
  } finally {
    try {
      play.game?.dispose();
    } catch {
      // A game that failed mid-step disposes itself.
    }
  }
  Object.assign(play, { phase: "idle", game: null, mount: null, timer: null, resizeObserver: null });
  playHost.replaceChildren();
  playHost.hidden = true;
  $("#play-loading").hidden = true;
  editorView.hidden = false;
  document.body.classList.remove("is-playing");
  $("#play").hidden = false;
  $("#stop").hidden = true;
  studio.dataset.playState = "idle";
  if (play.view) {
    state.zoom = play.view.zoom;
    state.cameraX = play.view.cameraX;
    state.cameraY = play.view.cameraY;
    play.view = null;
  }
}

async function play() {
  if (isPlaying() || state.saving || !state.document || !state.artwork) return;
  $("#play-error").hidden = true;
  let design;
  try {
    design = validateFloorDocument(structuredClone(state.document));
    const problems = playStartProblems(design);
    if (problems.length) throw new Error(problems.join(" "));
  } catch (error) {
    showPlayError(error.message);
    return;
  }
  const play = state.play;
  play.phase = "starting";
  play.view = { zoom: state.zoom, cameraX: state.cameraX, cameraY: state.cameraY };
  studio.dataset.playState = "starting";
  $("#play-loading").hidden = false;
  setStatus("Starting Play with the edited map…");
  refreshChrome({ structure: false });
  try {
    // The runtime measures its world slot when mounting, so the host must be
    // visible and laid out first; mounting into a hidden host gave a 1×1 canvas.
    document.body.classList.add("is-playing");
    editorView.hidden = true;
    playHost.hidden = false;
    $("#play").hidden = true;
    $("#stop").hidden = false;
    await nextFrame();
    await nextFrame();
    play.game = await createLocalGame(state.model === generic.MODEL ? genericPreview(design, ASSET_CATALOG, state.artwork) : {
      moduleFactory: createTowerGameModule(design, ASSET_CATALOG),
      settings: towerSettings,
      map: createFloorMap(design),
      seed: 1,
      roster: [{ accountId: "aries", username: "Aries", joinedOrder: 0 }],
      viewer: { accountId: "aries", role: "player" }
    });
    if (play.phase !== "starting") throw new Error("Play was cancelled.");
    play.mount = mountLocalPreview(playHost, play.game,
      state.model === generic.MODEL ? genericSkin(design, ASSET_CATALOG, state.artwork)
        : towerSkinFactory(state.artwork, undefined, design, ASSET_CATALOG), {
      onInputRejected: () => setStatus("The runtime rejected an input.", true)
    });
    // The runtime re-measures only on window resize; forward layout changes too.
    play.resizeObserver = new ResizeObserver(() => window.dispatchEvent(new Event("resize")));
    play.resizeObserver.observe(playHost);
    const playCanvas = playHost.querySelector("canvas");
    if (!playCanvas || playCanvas.clientWidth < 2 || playCanvas.clientHeight < 2) {
      throw new Error("The Play view has no visible size. Enlarge the browser window and try again.");
    }
    play.timer = window.setInterval(() => {
      try {
        play.game.step();
      } catch (error) {
        teardownPlay();
        refreshChrome();
        showPlayError(`The game stopped with an error: ${error.message}`);
      }
    }, 1000 / 30);
    play.phase = "playing";
    studio.dataset.playState = "playing";
    $("#play-loading").hidden = true;
    playCanvas.focus();
    setStatus(`Playing the edited map (unsaved edits included). Arrows/WASD move ${state.model === generic.MODEL ? "the player" : "Aries"}. Stop returns to editing.`);
  } catch (error) {
    teardownPlay();
    refreshChrome();
    showPlayError(`${error.message} Check the map for blocked spawns or invalid collisions, then press Play again.`);
  }
}

function stop() {
  if (!isPlaying()) return;
  teardownPlay();
  refreshChrome();
  setStatus("Stopped. Back to editing; the authored design and editor view are unchanged.");
  canvas.focus();
}

// ---------------------------------------------------------------- events

function ignoredShortcutTarget(target) {
  return target instanceof Element &&
    target.closest("input, textarea, select, [contenteditable='true']") !== null;
}

function configureEvents() {
  new ResizeObserver(resize).observe(editorView);
  canvas.addEventListener("pointerdown", pointerDown);
  canvas.addEventListener("pointermove", pointerMove);
  canvas.addEventListener("pointerup", pointerUp);
  canvas.addEventListener("pointercancel", pointerUp);
  canvas.addEventListener("pointerleave", () => {
    if (state.tool === "place" && !state.paletteDrag && state.preview) {
      state.preview = null;
      render();
    }
  });
  canvas.addEventListener("wheel", event => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    setZoom(state.zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1), event.clientX - rect.left, event.clientY - rect.top);
  }, { passive: false });
  canvas.addEventListener("contextmenu", event => event.preventDefault());
  window.addEventListener("keydown", event => {
    if ($("#open-dialog").open || $("#new-dialog").open) return;
    if ((event.ctrlKey || event.metaKey) && event.code === "KeyS") {
      event.preventDefault();
      save();
      return;
    }
    if (ignoredShortcutTarget(event.target)) return;
    if (isPlaying()) {
      if (event.code === "Escape" && state.play.phase === "playing") stop();
      return;
    }
    if (event.code === "Space" && event.target === canvas) {
      state.spaceDown = true;
      event.preventDefault();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.code === "KeyZ") {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.code === "KeyY") {
      event.preventDefault();
      redo();
      return;
    }
    if (event.code === "Escape") {
      if (state.paletteDrag) paletteCancel();
      setTool("select");
      return;
    }
    const nudges = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (nudges[event.code] && state.selectedId && event.target === canvas) {
      event.preventDefault();
      nudgeSelected(...nudges[event.code]);
      return;
    }
    if ((event.code === "Delete" || event.code === "Backspace") && state.selectedId && event.target === canvas) {
      event.preventDefault();
      deleteSelected();
    }
  });
  window.addEventListener("keyup", event => {
    if (event.code === "Space") state.spaceDown = false;
  });
  window.addEventListener("blur", () => { state.spaceDown = false; });
  window.addEventListener("beforeunload", event => {
    if (state.document && dirty()) event.preventDefault();
  });
  $("#select-tool").addEventListener("click", () => setTool("select"));
  $("#place-tool").addEventListener("click", () => setTool("place"));
  $("#undo").addEventListener("click", undo);
  $("#redo").addEventListener("click", redo);
  $("#show-grid").addEventListener("change", event => {
    state.showGrid = event.target.checked;
    render();
  });
  $("#snap-grid").addEventListener("change", event => {
    state.snap = event.target.checked;
    setStatus(state.snap ? "Snapping on: positions snap to the 32 px grid." :
      "Snapping off: free placement (terrain, spawns and the stairs portal still snap).");
  });
  $("#zoom-in").addEventListener("click", () => setZoom(state.zoom * 1.2));
  $("#zoom-out").addEventListener("click", () => setZoom(state.zoom / 1.2));
  $("#save").addEventListener("click", save);
  $("#open-game").addEventListener("click", showOpenDialog);
  configureNewGame();
  configureAssetImport();
  $("#open-cancel").addEventListener("click", () => $("#open-dialog").close());
  $("#switch-cancel").addEventListener("click", () => showSwitchConfirmation(false));
  $("#open-selected").addEventListener("click", () => {
    if (!state.openSelection) return;
    if (state.openSelection.projectId === state.identity.projectId && state.openSelection.mapId === state.identity.mapId && state.document) {
      $("#open-dialog").close();
    } else if (state.document && dirty()) {
      showSwitchConfirmation(true);
    } else {
      requestSwitch();
    }
  });
  $("#switch-save").addEventListener("click", () => requestSwitch(true));
  $("#switch-discard").addEventListener("click", () => requestSwitch());
  $("#model-confirm").addEventListener("click", () => switchToSelected(state.pendingSave));
  $("#model-cancel").addEventListener("click", () => showSwitchConfirmation(false));
  $("#open-dialog").addEventListener("cancel", event => {
    if (state.switching) event.preventDefault();
  });
  $("#play").addEventListener("click", play);
  $("#stop").addEventListener("click", stop);
  $("#play-error-close").addEventListener("click", () => {
    $("#play-error").hidden = true;
    studio.dataset.playState = "idle";
    canvas.focus();
  });
  $("#delete-object").addEventListener("click", deleteSelected);
  $("#object-inspector").addEventListener("submit", event => event.preventDefault());
  for (const [axis, field] of [["x", $("#object-x")], ["y", $("#object-y")]]) {
    field.addEventListener("change", () => {
      const object = selectedObject();
      const value = Number(field.value);
      if (!object || !Number.isFinite(value)) return;
      moveSelectedTo({ ...object.transform, [axis]: value });
    });
  }
  $("#object-collision").addEventListener("change", event => {
    const object = selectedObject();
    const asset = object && ASSET_CATALOG[object.assetId];
    if (!asset || asset.collision !== "optional") return;
    commitDocument(replaceObject(state.document, object.id,
      { collision: event.target.checked ? { ...asset.collisionBox } : null }));
    setStatus(`${object.id} collision ${event.target.checked ? "enabled" : "disabled"}.`);
  });
}

function describeMigrations(migrations) {
  const latest = migrations?.[0];
  if (!latest) return null;
  if (latest.status === "failed") return { error: true, text: `Migration failed: ${latest.report.error}` };
  const report = latest.report;
  const boxes = report.collisionBoxes?.length ?? 0;
  return {
    error: false,
    text: `Upgraded from format ${latest.fromVersion} to ${latest.toVersion} on ` +
      `${new Date(latest.createdAt).toLocaleString()}: ${report.walls} walls kept as walls` +
      (boxes ? `; ${boxes} off-grid former walls had no wall artwork and are now collision boxes (` +
        report.collisionBoxes.map(box => box.id).join(", ") + ")" : "") +
      (report.overlappingWalls?.length ? `; ${report.overlappingWalls.length} sets of overlapping walls kept as-is` : "") +
      `. The original is kept untouched in backup #${latest.backupId}.`
  };
}

function openMessage(message, error = false) {
  $("#open-message").textContent = message;
  $("#open-message").classList.toggle("error", error);
}

function showSwitchConfirmation(show) {
  $("#open-confirm").hidden = !show;
  $("#open-model-confirm").hidden = true;
  $("#open-actions").hidden = show;
  $("#open-list").inert = show;
}

async function showOpenDialog() {
  if (state.saving || state.switching || isPlaying()) return;
  state.openSelection = null;
  const requestId = ++state.openRequest;
  $("#open-selected").disabled = true;
  $("#open-list").replaceChildren();
  showSwitchConfirmation(false);
  openMessage("Loading saved projects…");
  $("#open-dialog").showModal();
  try {
    const response = await fetch("/api/projects");
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? `Listing failed (${response.status}).`);
    if (!$("#open-dialog").open || requestId !== state.openRequest) return;
    for (const entry of payload.maps) {
      const label = document.createElement("label");
      label.className = `open-entry${entry.supported || entry.canAdopt ? "" : " unsupported"}`;
      label.dataset.projectId = entry.projectId;
      label.dataset.mapId = entry.mapId;
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "open-map";
      radio.disabled = !entry.supported && !entry.canAdopt;
      const text = document.createElement("span");
      const title = document.createElement("strong");
      title.textContent = entry.project ? `${entry.project.name} / ${entry.mapId}` : `${entry.projectId} / ${entry.mapId}`;
      const details = document.createElement("small");
      details.textContent = entry.supported ? entry.model === generic.MODEL
        ? `Generic Grid v1 · ${entry.project?.author ?? ""}` : "Astraeum Floor model" : entry.canAdopt
        ? "Untyped compatible design — explicit Astraeum assignment required"
        : `Unsupported: ${entry.reason}`;
      text.append(title, details);
      label.append(radio, text);
      radio.addEventListener("change", () => {
        state.openSelection = { projectId: entry.projectId, mapId: entry.mapId, canAdopt: entry.canAdopt };
        $("#open-selected").disabled = false;
        openMessage("");
      });
      $("#open-list").append(label);
    }
    openMessage(payload.maps.length ? "Select a supported saved map." : "No saved projects or maps yet.");
  } catch (error) {
    if ($("#open-dialog").open && requestId === state.openRequest) {
      openMessage(`Could not list saved projects: ${error.message}`, true);
    }
  }
}

function requestSwitch(saveFirst = false) {
  if (state.openSelection?.canAdopt) {
    state.pendingSave = saveFirst;
    $("#open-confirm").hidden = true;
    $("#open-actions").hidden = true;
    $("#open-model-confirm").hidden = false;
    $("#open-list").inert = true;
  } else {
    switchToSelected(saveFirst);
  }
}

function newGameValues() {
  return generic.validateCreation({
    name: $("#new-name").value, author: $("#new-author").value,
    model: $("#new-model").value,
    width: Number($("#new-width").value), height: Number($("#new-height").value)
  });
}

function configureNewGame() {
  $("#new-game").addEventListener("click", () => {
    if (state.saving || state.switching || state.creating || isPlaying()) return;
    $("#new-form").reset();
    $("#new-message").textContent = "";
    $("#new-confirm").hidden = true;
    $("#new-create").hidden = false;
    $("#new-dialog").showModal();
    $("#new-name").focus();
  });
  $("#new-cancel").addEventListener("click", () => $("#new-dialog").close());
  $("#new-dialog").addEventListener("cancel", event => {
    if (state.creating) event.preventDefault();
  });
  $("#new-form").addEventListener("submit", event => {
    event.preventDefault();
    try {
      newGameValues();
      $("#new-message").textContent = "";
      if (state.document && dirty()) {
        $("#new-confirm").hidden = false;
        $("#new-create").hidden = true;
      } else createNewGame();
    } catch (error) {
      $("#new-message").textContent = error.message;
    }
  });
  $("#new-save").addEventListener("click", () => createNewGame(true));
  $("#new-discard").addEventListener("click", () => createNewGame());
}

async function createNewGame(saveFirst = false) {
  if (state.creating || state.saving || isPlaying()) return;
  let values;
  try {
    if (!$("#new-form").reportValidity()) return;
    values = newGameValues();
  } catch (error) {
    $("#new-message").textContent = error.message;
    return;
  }
  state.creating = true;
  $("#new-fields").disabled = true;
  refreshChrome({ structure: false });
  try {
    if (saveFirst && !(await save())) throw new Error("Could not save the current map; it remains open.");
    const response = await fetch("/api/projects", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(values)
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? `Creation failed (${response.status}).`);
    if (payload.model !== generic.MODEL || payload.document?.id !== payload.mapId) {
      throw new Error("The new game response has an invalid identity. Check Open Game before retrying.");
    }
    const design = generic.validateFloorDocument(payload.document);
    const assets = await loadProjectAssets(payload.projectId, payload.model);
    applyDesign({ projectId: payload.projectId, mapId: payload.mapId }, payload, design, assets);
    $("#new-dialog").close();
    setStatus(`Created ${payload.project.name}. Saved in SQLite; ready to edit.`);
  } catch (error) {
    $("#new-message").textContent = `Could not create game: ${error.message}`;
  } finally {
    state.creating = false;
    $("#new-fields").disabled = false;
    refreshChrome({ structure: false });
  }
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function defaultAssetName(filename) {
  const stem = filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
  return stem ? stem[0].toLocaleUpperCase() + stem.slice(1) : "Imported artwork";
}

function showAssetImportMessage(message, success = false) {
  const element = $("#asset-import-message");
  element.textContent = message;
  element.classList.toggle("success", success);
}

async function previewAssetUpload(file) {
  state.pendingAssetUpload = null;
  $("#asset-import-preview").hidden = true;
  $("#asset-import-submit").disabled = true;
  $("#asset-preview-images").replaceChildren();
  if (!file) return;
  const maximum = file.name.toLowerCase().endsWith(".zip") ? 16 * 1024 * 1024 : 4 * 1024 * 1024;
  if (file.size > maximum) {
    showAssetImportMessage(`File exceeds the ${Math.round(maximum / 1024 / 1024)} MB limit.`);
    return;
  }
  showAssetImportMessage("Validating and previewing image metadata…");
  try {
    const data = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
    const response = await fetch(`${projectAssetsUrl(state.identity.projectId)}/preview`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: file.name, data })
    });
    const preview = await response.json();
    if (!response.ok) throw new Error(preview.error ?? `Preview failed (${response.status}).`);
    if (!$("#asset-import-dialog").open) return;
    state.pendingAssetUpload = { filename: file.name, data };
    $("#asset-import-name").value = defaultAssetName(file.name);
    $("#asset-import-category").value = preview.archive && preview.states.length ? "character" : "prop";
    $("#asset-import-author").value = "";
    $("#asset-import-source").value = preview.archive ? "PixelLab ZIP export" : "";
    const descriptions = preview.states.map(stateInfo =>
      `${stateInfo.name}: ${stateInfo.width}×${stateInfo.height}, ${stateInfo.directions.length} directions, ` +
      `${stateInfo.animations.length} animation frames`).join("; ");
    $("#asset-import-summary").textContent = preview.archive
      ? `${descriptions || `${preview.images.length} static images`}. ${preview.animations} animation frames; no animation will be generated.`
      : `${preview.images[0].width}×${preview.images[0].height} PNG. Static visual only; no animation.`;
    for (const image of preview.images) {
      const item = document.createElement("div");
      item.className = "asset-preview-item";
      const element = document.createElement("img");
      element.alt = `${image.stateName ? `${image.stateName} ` : ""}${image.direction ?? ""} preview`;
      element.src = `data:image/png;base64,${image.data}`;
      const caption = document.createElement("span");
      caption.textContent = `${image.direction ? `${image.direction} · ` : ""}${image.width}×${image.height}`;
      item.append(element, caption);
      $("#asset-preview-images").append(item);
    }
    $("#asset-import-preview").hidden = false;
    $("#asset-import-submit").disabled = false;
    showAssetImportMessage("Preview verified. Add author/source credits before importing.");
  } catch (error) {
    showAssetImportMessage(`Could not preview image: ${error.message}`);
  }
}

function configureAssetImport() {
  $("#import-assets").addEventListener("click", () => {
    if (!state.document || isPlaying() || state.saving || state.switching) return;
    $("#asset-import-form").reset();
    $("#asset-import-preview").hidden = true;
    $("#asset-import-submit").disabled = true;
    $("#asset-preview-images").replaceChildren();
    showAssetImportMessage("");
    state.pendingAssetUpload = null;
    $("#asset-import-dialog").showModal();
  });
  $("#asset-import-cancel").addEventListener("click", () => $("#asset-import-dialog").close());
  $("#asset-import-file").addEventListener("change", event => previewAssetUpload(event.target.files[0]));
  $("#asset-import-form").addEventListener("submit", async event => {
    event.preventDefault();
    if (!state.pendingAssetUpload || !$("#asset-import-form").reportValidity()) return;
    const submit = $("#asset-import-submit");
    submit.disabled = true;
    $("#asset-import-file").disabled = true;
    showAssetImportMessage("Importing validated images…");
    try {
      const response = await fetch(projectAssetsUrl(state.identity.projectId), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...state.pendingAssetUpload,
          name: $("#asset-import-name").value,
          category: $("#asset-import-category").value,
          author: $("#asset-import-author").value,
          source: $("#asset-import-source").value
        })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? `Import failed (${response.status}).`);
      const assets = await loadProjectAssets(state.identity.projectId, state.model);
      activateAssetCatalog(state.model, assets);
      state.scene.document = null;
      configurePalette();
      refreshChrome();
      $("#asset-import-dialog").close();
      setStatus(`Imported ${result.assets.length} static image${result.assets.length === 1 ? "" : "s"} into this project. Visual only; no collision or behavior.`);
    } catch (error) {
      showAssetImportMessage(`Import failed: ${error.message}`);
    } finally {
      $("#asset-import-file").disabled = false;
      submit.disabled = !state.pendingAssetUpload;
    }
  });
}

async function fetchDesign(identity, allowTemplate = false) {
  const response = await fetch(mapUrl(identity));
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? `Local map service responded ${response.status}.`);
  if (payload.projectId !== identity.projectId || payload.mapId !== identity.mapId ||
      (payload.document && (![ASTRAEUM_MODEL, generic.MODEL].includes(payload.model) || payload.document.id !== identity.mapId))) {
    throw new Error("The loaded design identity or model did not match the requested project and map.");
  }
  if (!payload.document && !allowTemplate) throw new Error("The selected saved map no longer exists.");
  const modelId = payload.model ?? ASTRAEUM_MODEL;
  const model = modelId === generic.MODEL ? generic : towerProject;
  const assets = await loadProjectAssets(identity.projectId, modelId);
  return { payload, assets, document: model.validateFloorDocument(payload.document ?? createFloorDocument(), assets.catalog) };
}

function activateAssetCatalog(modelId, assets) {
  const model = modelId === generic.MODEL ? generic : towerProject;
  const assetCatalog = assets.catalog;
  ASSET_CATALOG = assetCatalog;
  DESIGN_LAYERS = model.DESIGN_LAYERS;
  OBJECT_TYPES = model.OBJECT_TYPES;
  clampTransform = (assetId, point, bounds = FLOOR1_BOUNDS) =>
    model.clampTransform(assetId, point, bounds, assetCatalog);
  collisionRect = model.collisionRect;
  createDesignObject = generic.MODEL === modelId
    ? (id, assetId, transform, order) => model.createDesignObject(id, assetId, transform, order, assetCatalog)
    : (id, assetId, transform, order, options) => model.createDesignObject(id, assetId, transform, order, options, assetCatalog);
  createFloorMap = document => model.createFloorMap(document, assetCatalog);
  floorDocumentGrid = document => model.floorDocumentGrid(document, assetCatalog);
  hitTest = (document, point, selectable) => model.hitTest(document, point, selectable, assetCatalog);
  isUnresolvedCollision = model.isUnresolvedCollision;
  objectBounds = object => model.objectBounds(object, assetCatalog);
  playStartProblems = document => model.playStartProblems(document, assetCatalog);
  snapTransform = (assetId, point) => model.snapTransform(assetId, point, assetCatalog);
  transformAtPoint = (assetId, point) => model.transformAtPoint(assetId, point, assetCatalog);
  validateFloorDocument = document => model.validateFloorDocument(document, assetCatalog);
  const renderer = modelId === generic.MODEL ? generic : towerRender;
  drawAsset = (context, artwork, assetId, transform, options = {}) =>
    renderer.drawAsset(context, artwork, assetId, transform, { ...options, assetCatalog });
  drawDesign = (context, artwork, design, options = {}) =>
    renderer.drawDesign(context, artwork, design, { ...options, assetCatalog });
  state.assetCatalog = assetCatalog;
  state.importedAssets = assets.records;
  state.artwork = { ...state.artwork, imported: assets.images };
}

function applyDesign(identity, payload, design, assets) {
  state.model = payload.model ?? ASTRAEUM_MODEL;
  activateAssetCatalog(state.model, assets);
  FLOOR1_BOUNDS = design.bounds;
  state.layers = loadLayerPrefs(state.model);
  state.placeAssetId = null;
  state.paletteDrag = null;
  state.pointerMode = null;
  state.pointerStart = null;
  state.spaceDown = false;
  document.body.classList.remove("dragging-asset");
  state.scene.document = null;
  const migration = describeMigrations(payload.migrations);
  $("#migration-notice").hidden = !migration;
  $("#migration-history").open = Boolean(migration?.error);
  if (migration) {
    $("#migration-text").textContent = migration.text;
    $("#migration-notice").classList.toggle("error", migration.error);
  }
  state.identity = identity;
  state.document = design;
  state.savedJson = JSON.stringify(state.document);
  state.selectedId = null;
  state.undo = [];
  state.redo = [];
  state.tool = "select";
  state.preview = null;
  state.hierarchyKey = "";
  $("#play-error").hidden = true;
  studio.dataset.playState = "idle";
  $("#project-name").textContent = identity.projectId === ASTRAEUM_PROJECT_ID && identity.mapId === ASTRAEUM_FLOOR_1_MAP_ID
    ? "Astraeum Tower · Floor 1" : payload.project ? payload.project.name : `${identity.projectId} · ${identity.mapId}`;
  $("#project-name").title = payload.project ? `Author/credits: ${payload.project.author}\n${identity.projectId} / ${identity.mapId}\n${state.model}` : state.model;
  document.title = `Web Studio - ${$("#project-name").textContent}`;
  canvas.setAttribute("aria-label", `${$("#project-name").textContent} map editor`);
  $("#palette-credit").textContent = state.model === generic.MODEL
    ? `Built-in generic shapes${state.importedAssets.length ? ` · ${state.importedAssets.length} imported images` : ""}`
    : `Floor 1 artwork by Anh Nguyen (PixelLab)${state.importedAssets.length ? ` · ${state.importedAssets.length} imported images` : ""}`;
  configurePalette();
  centerCamera();
  refreshChrome();
  setStatus(payload.document
    ? migration && !migration.error && payload.migrations[0].createdAt && Date.now() - Date.parse(payload.migrations[0].createdAt) < 60_000
      ? "Reopened Floor 1 — upgraded to the object format (see Inspector)."
      : "Reopened the locally saved design."
    : "Opened the original Floor 1 map (not yet saved).");
}

async function switchToSelected(saveFirst = false) {
  if (state.switching || !state.openSelection) return;
  const { projectId, mapId, canAdopt } = state.openSelection;
  const identity = { projectId, mapId };
  state.switching = true;
  $("#open-dialog").querySelectorAll("button, input").forEach(element => { element.disabled = true; });
  refreshChrome({ structure: false });
  try {
    if (saveFirst && !(await save())) throw new Error("Could not save the current map; it remains open.");
    if (canAdopt) {
      const response = await fetch(`${mapUrl(identity)}/model/${ASTRAEUM_MODEL}`, { method: "POST" });
      const result = await response.json();
      if (!response.ok || result.projectId !== identity.projectId || result.mapId !== identity.mapId ||
          result.model !== ASTRAEUM_MODEL) {
        throw new Error(result.error ?? "Could not assign the Astraeum model.");
      }
    }
    const { payload, document: design, assets } = await fetchDesign(identity);
    applyDesign(identity, payload, design, assets);
    $("#open-dialog").close();
  } catch (error) {
    openMessage(`Could not open map: ${error.message}`, true);
  } finally {
    state.switching = false;
    $("#open-dialog").querySelectorAll("button").forEach(element => { element.disabled = false; });
    $("#open-list").querySelectorAll("input").forEach(element => {
      element.disabled = element.closest(".unsupported") !== null;
    });
    $("#open-selected").disabled = !state.openSelection;
    refreshChrome({ structure: false });
  }
}

async function openFloor() {
  state.artwork = await towerRender.loadArtwork();
  configurePalette();
  configurePaletteView();
  configureResolveActions();
  configureEvents();
  await nextFrame();
  resize();
  refreshChrome();
  if (import.meta.env?.DEV) {
    window.__studioTest = Object.freeze({
      document: () => structuredClone(state.document),
      worldToClient(x, y) {
        const rect = canvas.getBoundingClientRect();
        return { x: rect.left + (x - state.cameraX) * state.zoom, y: rect.top + (y - state.cameraY) * state.zoom };
      },
      view: () => ({ zoom: state.zoom, cameraX: state.cameraX, cameraY: state.cameraY }),
      setView(view) {
        Object.assign(state, view);
        render();
      }
    });
  }
  const { payload, document: design, assets } = await fetchDesign(state.identity, true);
  applyDesign(state.identity, payload, design, assets);
}

openFloor().catch(error => {
  $("#save-state").textContent = "Not loaded";
  $("#save-state").className = "save-state dirty";
  setStatus(`Could not open Floor 1: ${error.message}`, true);
});
