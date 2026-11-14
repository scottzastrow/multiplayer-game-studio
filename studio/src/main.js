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
import {
  MAX_MAP_DIMENSION as RUNTIME_MAX_MAP_DIMENSION,
  MAP_CELL_SIZE as RUNTIME_MAP_CELL_SIZE,
  readStandardGamepad
} from "@multiplayer-game/theme-sdk";
import { ASTRAEUM_PROJECT_ID, ASTRAEUM_FLOOR_1_MAP_ID, ASTRAEUM_MODEL } from "../project-identity.js";
import { importedAssetDefinition } from "../project-assets.js";
import { configureWorldWorkspace } from "./world-workspace.js";
import "./styles.css";

const CELL = MAP_CELL_SIZE;
const MIN_MAP_DIMENSION = RUNTIME_MAP_CELL_SIZE * 2;
const mapUrl = ({ projectId, mapId }) => `/api/projects/${encodeURIComponent(projectId)}/maps/${encodeURIComponent(mapId)}`;
const projectAssetsUrl = projectId => `/api/projects/${encodeURIComponent(projectId)}/assets`;
const LAYER_PREFS_KEY = "web-studio.astraeum.layers.v1";
const layerPrefsKey = model => model === generic.MODEL ? "web-studio.generic-grid-v1.layers.v1" : LAYER_PREFS_KEY;
const PALETTE_VIEW_KEY = "web-studio.palette-view.v1";
const PLAYER_CONTROL_MODE_KEY = "web-studio.player-control-mode.v1";
const PLAYER_CONTROL_MODES = Object.freeze({
  "keyboard-only": { label: "Keyboard Only", bindings: "WASD: Move · Arrow keys: Dodge · Space: Attack." },
  "keyboard-mouse": { label: "Keyboard + Mouse", bindings: "Arrow keys move · Pointer aims · Left click attacks · Hold right mouse + arrow to dodge." },
  "game-controller": { label: "Game Controller", bindings: "Left stick moves · Right stick aims · RT attacks · Hold B/Circle + left-stick direction to dodge." }
});
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
const CLEAR_CATEGORIES = Object.freeze([
  { id: "terrain", label: "Terrain", type: "terrain-tile" },
  { id: "walls", label: "Walls", type: "wall" },
  { id: "props", label: "Props", type: "prop" },
  { id: "items", label: "Items", type: "item" },
  { id: "collision", label: "Collision boxes", type: "collision" },
  { id: "spawns", label: "Spawns", type: "spawn" }
]);
const $ = selector => document.querySelector(selector);
const studio = $("#studio");
const canvas = $("#map-canvas");
const context = canvas.getContext("2d", { alpha: false });
const editorView = $("#editor-view");
const playHost = $("#play-host");
let playerSettingsReturnFocus = null;
let playerControllerStatusTimer = null;

const state = {
  document: null,
  loadedPayload: null,
  mapSizeDraft: null,
  identity: { projectId: ASTRAEUM_PROJECT_ID, mapId: ASTRAEUM_FLOOR_1_MAP_ID },
  saving: false,
  switching: false,
  creating: false,
  levelBusy: false,
  levels: [],
  startingMapId: null,
  levelAction: null,
  persisted: false,
  model: ASTRAEUM_MODEL,
  openSelection: null,
  pendingSave: false,
  openRequest: 0,
  importedAssets: [],
  assetCatalog: towerProject.ASSET_CATALOG,
  savedJson: "",
  artwork: null,
  selectedId: null,
  selectedIds: new Set(),
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
  playerControlMode: loadPlayerControlMode(),
  openGroups: new Set(),
  hierarchyKey: "",
  scene: { document: null, key: "", canvas: null },
  play: { phase: "idle", game: null, mount: null, timer: null, view: null, resizeObserver: null }
};

function loadPlayerControlMode() {
  try {
    const stored = localStorage.getItem(PLAYER_CONTROL_MODE_KEY);
    return Object.hasOwn(PLAYER_CONTROL_MODES, stored) ? stored : "keyboard-mouse";
  } catch {
    return "keyboard-mouse";
  }
}

function savePlayerControlMode(mode) {
  if (!Object.hasOwn(PLAYER_CONTROL_MODES, mode)) return;
  state.playerControlMode = mode;
  try {
    localStorage.setItem(PLAYER_CONTROL_MODE_KEY, mode);
  } catch {
    // Player controls are optional preferences, separate from the game design.
  }
  updatePlayerSettings();
  window.dispatchEvent(new CustomEvent("studio:player-settings-mode-change", { detail: { mode } }));
}

function updatePlayerSettings() {
  const selected = PLAYER_CONTROL_MODES[state.playerControlMode];
  $("#player-mode-summary").textContent = selected.label;
  $("#player-control-mode").value = state.playerControlMode;
  $("#player-control-bindings").textContent = selected.bindings;
  const cameraZoom = $("#camera-zoom");
  if (cameraZoom && document.activeElement !== cameraZoom) {
    cameraZoom.value = String(state.document?.cameraZoom ?? towerProject.DEFAULT_CAMERA_ZOOM);
  }
  $("#camera-zoom-value").textContent = `${Number(cameraZoom?.value ?? towerProject.DEFAULT_CAMERA_ZOOM).toFixed(1)}×`;
  if (cameraZoom) cameraZoom.disabled = !state.document || isPlaying() || state.saving || state.switching;
  $("#player-settings-note").textContent = state.model === generic.MODEL
    ? "Generic Grid supports WASD and arrow-key movement. Camera zoom is saved with the current level."
    : "Camera zoom is saved with the current level; control mode remains a local browser preference.";
}

function updatePlayerControllerStatus(status, id = "") {
  const output = $("#player-controller-status");
  output.dataset.status = status;
  if (status === "connected") {
    output.textContent = `Connected · Standard mapping${id ? ` · ${id}` : ""}`;
  } else if (status === "unsupported") {
    output.textContent = "Connected · Standard mapping unavailable";
  } else if (status === "invalid") {
    output.textContent = `Connected · Standard mapping · Invalid input${id ? ` · ${id}` : ""}`;
  } else if (status === "unavailable") {
    output.textContent = "Gamepad access unavailable";
  } else {
    output.textContent = "Disconnected · Standard mapping required";
  }
}

function refreshPlayerControllerStatus() {
  const gamepads = navigator.getGamepads?.() ?? null;
  const input = readStandardGamepad(gamepads);
  updatePlayerControllerStatus(input.status, input.id ?? "");
}

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
const selectedObjects = () => state.document?.objects.filter(object => state.selectedIds.has(object.id)) ?? [];
const isSelectable = object => state.layers[object.layer].visible && !state.layers[object.layer].locked;
const layerName = id => DESIGN_LAYERS.find(layer => layer.id === id).name;
const mapBounds = () => state.document?.bounds ?? FLOOR1_BOUNDS;

function setSelection(ids, preferredId = null) {
  const available = new Set(state.document?.objects.map(object => object.id) ?? []);
  state.selectedIds = new Set([...ids].filter(id => available.has(id)));
  state.selectedId = preferredId && state.selectedIds.has(preferredId)
    ? preferredId : [...state.selectedIds].at(-1) ?? null;
  for (const object of selectedObjects()) state.openGroups.add(object.layer);
}

function toggleSelection(id) {
  const next = new Set(state.selectedIds);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  setSelection(next, next.has(id) ? id : [...next].at(-1) ?? null);
}

function currentMapSizeDraft() {
  const bounds = mapBounds();
  const identity = `${state.identity.projectId}/${state.identity.mapId}`;
  const draft = state.mapSizeDraft;
  if (!draft || draft.identity !== identity ||
      draft.baseWidth !== bounds.width || draft.baseHeight !== bounds.height) {
    state.mapSizeDraft = {
      identity,
      baseWidth: bounds.width,
      baseHeight: bounds.height,
      width: String(bounds.width),
      height: String(bounds.height)
    };
  }
  return state.mapSizeDraft;
}

function mapSizeDraftChanged(draft) {
  const bounds = mapBounds();
  return Number(draft.width) !== bounds.width || Number(draft.height) !== bounds.height;
}

function updateMapSettings() {
  const bounds = mapBounds();
  const draft = currentMapSizeDraft();
  const width = $("#map-width");
  const height = $("#map-height");
  width.value = draft.width;
  height.value = draft.height;
  for (const [field, current] of [[width, bounds.width], [height, bounds.height]]) {
    field.min = String(current);
    field.max = String(RUNTIME_MAX_MAP_DIMENSION);
    field.step = String(RUNTIME_MAP_CELL_SIZE);
  }
  const next = { width: Number(draft.width), height: Number(draft.height) };
  const message = $("#map-size-error");
  const valid = [next.width, next.height].every((value, index) =>
    Number.isInteger(value) && value >= [bounds.width, bounds.height][index] &&
    value <= RUNTIME_MAX_MAP_DIMENSION && value % RUNTIME_MAP_CELL_SIZE === 0);
  message.textContent = valid ? "" : `Expand only, in ${RUNTIME_MAP_CELL_SIZE} px increments, up to ${RUNTIME_MAX_MAP_DIMENSION} px.`;
  const unavailable = !state.document || isPlaying() || state.saving || state.switching || state.creating || state.levelBusy;
  width.disabled = unavailable;
  height.disabled = unavailable;
  $("#apply-map-size").disabled = unavailable || !valid || !mapSizeDraftChanged(draft);
  $("#cancel-map-size").disabled = unavailable || !mapSizeDraftChanged(draft);
}

function expandMap() {
  const current = mapBounds();
  const draft = currentMapSizeDraft();
  const bounds = { width: Number(draft.width), height: Number(draft.height) };
  const valid = [bounds.width, bounds.height].every((value, index) =>
    Number.isInteger(value) && value >= [current.width, current.height][index] &&
    value >= MIN_MAP_DIMENSION && value <= RUNTIME_MAX_MAP_DIMENSION &&
    value % RUNTIME_MAP_CELL_SIZE === 0);
  if (!valid) {
    $("#map-size-error").textContent = `Map dimensions can only expand in ${RUNTIME_MAP_CELL_SIZE} px increments up to ${RUNTIME_MAX_MAP_DIMENSION} px.`;
    return;
  }
  if (bounds.width === current.width && bounds.height === current.height) return;
  try {
    const next = validateFloorDocument({ ...state.document, bounds });
    state.mapSizeDraft = null;
    commitDocument(next);
    setStatus(`Map expanded to ${bounds.width} × ${bounds.height} px. Existing content was not moved or scaled; added space is empty. Undo with Ctrl+Z.`);
  } catch (error) {
    $("#map-size-error").textContent = `Could not apply map dimensions: ${error.message}`;
  }
}

function cancelMapSizeDraft() {
  state.mapSizeDraft = null;
  updateMapSettings();
}

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
  state.undo.push({ document: before, selection: [...state.selectedIds] });
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
  state.redo.push({ document: state.document, selection: [...state.selectedIds] });
  const entry = state.undo.pop();
  state.document = entry.document;
  setSelection(entry.selection.filter(id => state.document.objects.some(object => object.id === id) &&
    isSelectable(state.document.objects.find(object => object.id === id))));
  refreshChrome();
  setStatus("Undone.");
}

function redo() {
  if (!state.redo.length || isPlaying()) return;
  state.undo.push({ document: state.document, selection: [...state.selectedIds] });
  const entry = state.redo.pop();
  state.document = entry.document;
  setSelection(entry.selection.filter(id => state.document.objects.some(object => object.id === id) &&
    isSelectable(state.document.objects.find(object => object.id === id))));
  refreshChrome();
  setStatus("Redone.");
}

// ---------------------------------------------------------------- chrome

function refreshChrome({ structure = true } = {}) {
  const loaded = Boolean(state.document);
  const isDirty = loaded && dirty();
  updatePlayerSettings();
  updateMapSettings();
  $("#save-state").textContent = !loaded ? "Not loaded" : isDirty ? "● Unsaved changes" : "✓ Saved";
  $("#save-state").className = `save-state ${isDirty || !loaded ? "dirty" : "saved"}`;
  $("#save").disabled = !loaded || !isDirty || isPlaying();
  $("#save").disabled ||= state.saving;
  $("#open-game").disabled = isPlaying() || state.saving || state.switching || !state.artwork;
  $("#new-game").disabled = isPlaying() || state.saving || state.switching || state.creating || !state.artwork;
  $("#import-assets").disabled = !loaded || isPlaying() || state.saving || state.switching || state.creating;
  $("#play").disabled = !loaded || isPlaying() || state.saving || !state.artwork;
  for (const id of ["save", "play", "open-game", "new-game", "import-assets"]) {
    $(`#${id}`).disabled ||= state.levelBusy || state.switching;
  }
  const levelDisabled = !loaded || isPlaying() || state.saving || state.switching || state.creating || state.levelBusy;
  $(".workspace").inert = state.switching || state.creating || state.levelBusy;
  $("#asset-list").inert = state.switching || state.creating || state.levelBusy;
  for (const action of ["add", "duplicate", "rename", "start", "delete"]) {
    $(`#level-${action}`).disabled = levelDisabled ||
      (action === "start" && state.startingMapId === state.identity.mapId) ||
      (action === "delete" && state.levels.filter(level => !level.deletedAt).length <= 1);
  }
  $("#level-select").disabled = levelDisabled;
  $("#level-recovery").inert = levelDisabled;
  $("#undo").disabled = state.undo.length === 0 || isPlaying();
  $("#redo").disabled = state.redo.length === 0 || isPlaying();
  $("#duplicate-selection").disabled = !loaded || !selectedObjects().length || isPlaying() ||
    state.saving || state.switching || state.creating || state.levelBusy;
  $("#clear-level-contents").disabled = !loaded || isPlaying() || state.saving ||
    state.switching || state.creating || state.levelBusy;
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

function refreshAfterOperation() {
  try {
    refreshChrome();
  } catch (error) {
    setStatus(`${$("#status").textContent} Editor refresh failed: ${error.message}`, true);
  }
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
  setSelection(selectedObjects().filter(isSelectable).map(object => object.id));
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
  const selectionKey = [...state.selectedIds].sort().join(",");
  const key = `${objects.length}|${objects.map(object => object.id).join(",").length}|${selectionKey}|` +
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
        item.className = `tree-item${state.selectedIds.has(object.id) ? " selected" : ""}`;
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
        item.addEventListener("click", event => {
          if (event.shiftKey) toggleSelection(object.id);
          else setSelection([object.id], object.id);
          revealSelection(object.id);
          refreshChrome();
        });
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
  const selected = selectedObjects();
  const multiple = selected.length > 1;
  $("#empty-inspector").hidden = selected.length > 0;
  $("#object-inspector").hidden = selected.length !== 1;
  $("#selection-inspector").hidden = !multiple;
  if (multiple) {
    updateSelectionInspector(selected);
    return;
  }
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
  const requiredNonSpawn = Boolean(asset.required && object.type !== "spawn");
  $("#delete-object").disabled = requiredNonSpawn;
  $("#delete-object").title = requiredNonSpawn ? `${asset.label} is required; move it instead.` : "Delete (Del)";
}

function updateSelectionInspector(objects) {
  $("#selection-count").textContent = String(objects.length);
  const fields = {
    "selection-type": objects.map(object => OBJECT_TYPES[object.type].label),
    "selection-asset": objects.map(object => ASSET_CATALOG[object.assetId].label),
    "selection-layer": objects.map(object => layerName(object.layer)),
    "selection-order": objects.map(object => String(object.order)),
    "selection-size": objects.map(object => {
      const bounds = objectBounds(object);
      return `${bounds.width} × ${bounds.height} px`;
    }),
    "selection-position": objects.map(object => `${object.transform.x}, ${object.transform.y}`)
  };
  for (const [id, values] of Object.entries(fields)) {
    const output = $(`#${id}`);
    const common = values.every(value => value === values[0]);
    output.textContent = common ? values[0] : "Mixed";
    output.classList.toggle("mixed-value", !common);
    output.dataset.mixed = String(!common);
  }
  const collision = $("#selection-collision");
  const collisionLabel = $("#selection-collision-label");
  const collisionEditable = objects.every(object => ASSET_CATALOG[object.assetId].collision === "optional");
  const collisionValues = objects.map(object => Boolean(object.collision));
  const mixedCollision = collisionValues.some(value => value !== collisionValues[0]);
  collision.checked = collisionValues.every(Boolean);
  collision.indeterminate = mixedCollision;
  collision.disabled = !collisionEditable;
  collisionLabel.textContent = collisionEditable
    ? `Collision${mixedCollision ? " (Mixed)" : ""}`
    : "Collision (not editable for every selected object)";
  collision.title = mixedCollision ? "Mixed values — toggle to set collision for all selected objects." : "";
  for (const [axis, field] of [["x", $("#selection-delta-x")], ["y", $("#selection-delta-y")]]) {
    if (document.activeElement !== field) field.value = "0";
    field.disabled = isPlaying() || !objects.every(isSelectable);
    field.dataset.axis = axis;
  }
  $("#apply-selection-offset").disabled = isPlaying() || !objects.every(isSelectable);
}

function updateUnresolvedSummary() {
  const count = state.document?.objects.filter(isUnresolvedCollision).length ?? 0;
  $("#unresolved-summary").hidden = count === 0;
  $("#unresolved-count").textContent = `⚠ ${count} ${UNRESOLVED_LABEL.toLowerCase()}${count === 1 ? "" : "s"} from the migration`;
}

function updateResolveOutcome() {
  const object = selectedObject();
  if (!object || !isUnresolvedCollision(object)) return;
  const plan = planArtworkReplacement(object, $("#resolve-asset").value, mapBounds());
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
    const plan = planArtworkReplacement(object, assetId, mapBounds());
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

function revealSelection(id = state.selectedId) {
  if (id) {
    const object = state.document.objects.find(item => item.id === id);
    if (!object) return;
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
}

function selectObject(id, { reveal = false } = {}) {
  setSelection(id ? [id] : [], id);
  if (reveal) revealSelection(id);
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
  scene.canvas.width = mapBounds().width;
  scene.canvas.height = mapBounds().height;
  const sceneContext = scene.canvas.getContext("2d", { alpha: false });
  sceneContext.imageSmoothingEnabled = false;
  drawDesign(sceneContext, state.artwork, state.document, {
    grid: floorDocumentGrid(state.document),
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
    for (let x = 0; x <= mapBounds().width; x += CELL) {
      context.moveTo(x, 0);
      context.lineTo(x, mapBounds().height);
    }
    for (let y = 0; y <= mapBounds().height; y += CELL) {
      context.moveTo(0, y);
      context.lineTo(mapBounds().width, y);
    }
    context.stroke();
    context.restore();
  }
  for (const selected of selectedObjects()) {
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
  if (state.pointerMode === "marquee" && state.pointerStart) {
    const { anchor, current } = state.pointerStart;
    context.save();
    context.strokeStyle = "#8fcfff";
    context.fillStyle = "#55a7e833";
    context.lineWidth = line;
    context.setLineDash([4 * line, 3 * line]);
    context.fillRect(Math.min(anchor.x, current.x), Math.min(anchor.y, current.y),
      Math.abs(current.x - anchor.x), Math.abs(current.y - anchor.y));
    context.strokeRect(Math.min(anchor.x, current.x), Math.min(anchor.y, current.y),
      Math.abs(current.x - anchor.x), Math.abs(current.y - anchor.y));
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
  canvas.dataset.selectedIds = JSON.stringify([...state.selectedIds]);
  canvas.dataset.selectionCount = String(state.selectedIds.size);
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
  state.cameraX = (mapBounds().width - state.viewportWidth / state.zoom) / 2;
  state.cameraY = (mapBounds().height - state.viewportHeight / state.zoom) / 2;
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
  return clampTransform(assetId, transform, mapBounds());
}

function placementProblem(assetId, transform) {
  const asset = ASSET_CATALOG[assetId];
  if (asset.size.width > mapBounds().width || asset.size.height > mapBounds().height) {
    return `${asset.label} (${asset.size.width}×${asset.size.height} px) is larger than this ` +
      `${mapBounds().width}×${mapBounds().height} px map and cannot be placed.`;
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
  setSelection([object.id], object.id);
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
  next = clampTransform(object.assetId, next, mapBounds());
  if (next.x === object.transform.x && next.y === object.transform.y) {
    refreshChrome({ structure: false });
    return;
  }
  commitDocument(replaceObject(state.document, object.id, { transform: next }));
}

function snappedDisplacement(objects, dx, dy, enabled) {
  if (objects.length === 1 && (enabled || ASSET_CATALOG[objects[0].assetId].snap.forced)) {
    const object = objects[0];
    const snapped = snapTransform(object.assetId, {
      x: object.transform.x + dx,
      y: object.transform.y + dy
    });
    return { x: snapped.x - object.transform.x, y: snapped.y - object.transform.y };
  }
  if (!enabled && !objects.some(object => ASSET_CATALOG[object.assetId].snap.forced)) {
    return { x: Math.round(dx), y: Math.round(dy) };
  }
  const anchor = objects.find(object => ASSET_CATALOG[object.assetId].snap.forced);
  if (anchor) {
    const snapped = snapTransform(anchor.assetId, {
      x: anchor.transform.x + dx,
      y: anchor.transform.y + dy
    });
    return { x: snapped.x - anchor.transform.x, y: snapped.y - anchor.transform.y };
  }
  return {
    x: Math.round(dx / CELL) * CELL,
    y: Math.round(dy / CELL) * CELL
  };
}

function translatedDocument(before, ids, dx, dy, { snap = false } = {}) {
  const objects = before.objects.filter(object => ids.includes(object.id));
  if (!objects.length || objects.length !== ids.length || !objects.every(isSelectable)) {
    return { error: "Group move rejected: the selection includes missing, hidden, or locked content." };
  }
  const displacement = snappedDisplacement(objects, dx, dy, snap);
  if (displacement.x === 0 && displacement.y === 0) return { document: before };
  const moved = new Map(objects.map(object => [object.id, {
    ...object,
    transform: {
      x: Math.round(object.transform.x + displacement.x),
      y: Math.round(object.transform.y + displacement.y)
    }
  }]));
  if (objects.length === 1) {
    const object = objects[0];
    const nextObject = moved.get(object.id);
    nextObject.transform = clampTransform(object.assetId, nextObject.transform, mapBounds());
  }
  const next = { ...before, objects: before.objects.map(object => moved.get(object.id) ?? object) };
  const bounds = mapBounds();
  for (const object of moved.values()) {
    const rect = objectBounds(object);
    if (rect.x < 0 || rect.y < 0 || rect.x + rect.width > bounds.width || rect.y + rect.height > bounds.height) {
      return { error: "Group move rejected: every selected object must remain inside the map. No objects were moved." };
    }
  }
  try {
    return { document: validateFloorDocument(next) };
  } catch (error) {
    return { error: `Group move rejected: ${error.message} No objects were moved.` };
  }
}

function moveSelectionBy(dx, dy, { snap = false, commit = true } = {}) {
  const ids = [...state.selectedIds];
  const result = translatedDocument(state.document, ids, dx, dy, { snap });
  if (result.error) {
    if (commit) setStatus(result.error, true);
    return false;
  }
  if (result.document !== state.document && JSON.stringify(result.document) !== JSON.stringify(state.document)) {
    if (commit) commitDocument(result.document);
    else state.document = result.document;
    return true;
  }
  return false;
}

function nudgeSelected(dx, dy) {
  const objects = selectedObjects();
  if (!objects.length) return;
  const step = objects.some(object => ASSET_CATALOG[object.assetId].snap.forced) ? CELL : NUDGE_PX;
  if (moveSelectionBy(dx * step, dy * step)) {
    setStatus(`Nudged ${objects.length} selected object${objects.length === 1 ? "" : "s"} by ${step} world pixels.`);
  }
}

function applySelectionOffset() {
  const dx = Number($("#selection-delta-x").value);
  const dy = Number($("#selection-delta-y").value);
  if (![dx, dy].every(Number.isFinite)) {
    setStatus("Enter a finite shared X/Y offset.", true);
    return;
  }
  if (moveSelectionBy(dx, dy, { snap: state.snap })) {
    $("#selection-delta-x").value = "0";
    $("#selection-delta-y").value = "0";
    setStatus(`Moved ${state.selectedIds.size} selected objects by one shared offset. Undo with Ctrl+Z.`);
  }
}

function deleteSelected() {
  const objects = selectedObjects();
  if (!objects.length) return;
  const required = objects.find(object =>
    ASSET_CATALOG[object.assetId].required && object.type !== "spawn");
  if (required) {
    setStatus(`${ASSET_CATALOG[required.assetId].label} is required and cannot be deleted; move it instead.`, true);
    return;
  }
  const ids = new Set(objects.map(object => object.id));
  commitDocument({ ...state.document, objects: state.document.objects.filter(item => !ids.has(item.id)) });
  setSelection([]);
  refreshChrome();
  setStatus(`Deleted ${objects.length} selected object${objects.length === 1 ? "" : "s"}. Undo with Ctrl+Z.`);
}

function duplicateId(object, ids) {
  const stem = object.id.slice(0, 110);
  let suffix = 1;
  while (ids.has(`${stem}-copy-${suffix}`)) suffix += 1;
  const id = `${stem}-copy-${suffix}`;
  ids.add(id);
  return id;
}

function duplicateSelection() {
  const layerOrder = new Map(DESIGN_LAYERS.map((layer, index) => [layer.id, index]));
  const objects = selectedObjects().sort((left, right) =>
    layerOrder.get(left.layer) - layerOrder.get(right.layer) || left.order - right.order);
  if (!objects.length) return;
  const unique = objects.find(object => ASSET_CATALOG[object.assetId].unique);
  if (unique) {
    setStatus(`${ASSET_CATALOG[unique.assetId].label} is unique and cannot be duplicated.`, true);
    return;
  }
  const displacement = snappedDisplacement(objects, CELL, CELL, state.snap);
  const ids = new Set(state.document.objects.map(object => object.id));
  const layerOrders = new Map(DESIGN_LAYERS.map(layer => [
    layer.id,
    Math.max(-1, ...state.document.objects.filter(object => object.layer === layer.id).map(object => object.order))
  ]));
  const copies = objects.map(object => {
    const rect = objectBounds({
      ...object,
      transform: {
        x: object.transform.x + displacement.x,
        y: object.transform.y + displacement.y
      }
    });
    if (rect.x < 0 || rect.y < 0 || rect.x + rect.width > mapBounds().width || rect.y + rect.height > mapBounds().height) {
      return null;
    }
    layerOrders.set(object.layer, layerOrders.get(object.layer) + 1);
    return {
      ...object,
      id: duplicateId(object, ids),
      order: layerOrders.get(object.layer),
      transform: { x: object.transform.x + displacement.x, y: object.transform.y + displacement.y }
    };
  });
  if (copies.some(copy => !copy)) {
    setStatus("Duplicate rejected: every copy must remain inside the map. No objects were duplicated.", true);
    return;
  }
  try {
    const next = validateFloorDocument({ ...state.document, objects: [...state.document.objects, ...copies] });
    commitDocument(next);
    setSelection(copies.map(object => object.id));
    refreshChrome();
    setStatus(`Duplicated ${copies.length} object${copies.length === 1 ? "" : "s"} with new IDs. Undo with Ctrl+Z.`);
  } catch (error) {
    setStatus(`Duplicate rejected: ${error.message} No objects were duplicated.`, true);
  }
}

function clearCategoryCounts(category) {
  const objects = state.document?.objects.filter(object => object.type === category.type) ?? [];
  return {
    affected: objects.filter(object => !state.layers[object.layer].locked).length,
    skipped: objects.filter(object => state.layers[object.layer].locked).length
  };
}

function refreshClearContentsDialog() {
  const selected = [...$("#clear-category-list").querySelectorAll("[data-clear-category]:checked")]
    .map(input => CLEAR_CATEGORIES.find(category => category.id === input.dataset.clearCategory));
  let affected = 0;
  let skipped = 0;
  for (const category of CLEAR_CATEGORIES) {
    const counts = clearCategoryCounts(category);
    const output = $(`#clear-count-${category.id}`);
    output.replaceChildren();
    const affectedText = document.createTextNode(`${counts.affected} affected`);
    output.append(affectedText);
    if (counts.skipped) {
      const skippedText = document.createElement("span");
      skippedText.className = "skipped";
      skippedText.textContent = ` · ${counts.skipped} locked skipped`;
      output.append(skippedText);
    }
    if (selected.some(item => item.id === category.id)) {
      affected += counts.affected;
      skipped += counts.skipped;
    }
  }
  $("#clear-contents-summary").textContent = selected.length
    ? `${affected} object${affected === 1 ? "" : "s"} will be removed; ${skipped} locked object${skipped === 1 ? "" : "s"} will be skipped.`
    : "Select one or more categories to preview the affected counts.";
  $("#clear-contents-confirm").disabled = affected === 0;
}

function showClearContentsDialog() {
  const list = $("#clear-category-list");
  list.replaceChildren(...CLEAR_CATEGORIES.map(category => {
    const row = document.createElement("div");
    row.className = "clear-category";
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.dataset.clearCategory = category.id;
    checkbox.addEventListener("change", refreshClearContentsDialog);
    label.append(checkbox, document.createTextNode(category.label));
    const count = document.createElement("output");
    count.id = `clear-count-${category.id}`;
    row.append(label, count);
    return row;
  }));
  refreshClearContentsDialog();
  $("#clear-contents-dialog").showModal();
}

function clearLevelContents() {
  if (!state.document || isPlaying()) return;
  const categories = new Set([...$("#clear-category-list").querySelectorAll("[data-clear-category]:checked")]
    .map(input => input.dataset.clearCategory));
  const types = new Set(CLEAR_CATEGORIES.filter(category => categories.has(category.id)).map(category => category.type));
  if (!types.size) return;
  const removed = state.document.objects.filter(object =>
    types.has(object.type) && !state.layers[object.layer].locked);
  const skipped = state.document.objects.filter(object =>
    types.has(object.type) && state.layers[object.layer].locked).length;
  if (!removed.length) {
    $("#clear-contents-dialog").close();
    setStatus(`Nothing was removed; ${skipped} selected-category object${skipped === 1 ? " is" : "s are"} on locked layers.`);
    return;
  }
  const removedIds = new Set(removed.map(object => object.id));
  try {
    const next = validateFloorDocument({
      ...state.document,
      objects: state.document.objects.filter(object => !removedIds.has(object.id))
    });
    commitDocument(next);
    setSelection([...state.selectedIds].filter(id => !removedIds.has(id)));
    $("#clear-contents-dialog").close();
    refreshChrome();
    setStatus(`Cleared ${removed.length} object${removed.length === 1 ? "" : "s"} in one undoable edit; ` +
      `${skipped} locked object${skipped === 1 ? " was" : "s were"} skipped. Undo with Ctrl+Z.`);
  } catch (error) {
    setStatus(`Clear rejected: ${error.message}. No objects were removed.`, true);
  }
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
    state.pointerMode = "marquee";
    state.pointerStart = {
      anchor: point,
      current: point,
      baseSelection: event.shiftKey ? [...state.selectedIds] : [],
      moved: false
    };
    canvas.setPointerCapture(event.pointerId);
    refreshChrome();
    return;
  }
  if (event.shiftKey && state.selectedIds.has(object.id)) {
    toggleSelection(object.id);
    refreshChrome();
    return;
  }
  if (event.shiftKey) {
    setSelection([...state.selectedIds, object.id], object.id);
  } else if (!state.selectedIds.has(object.id) || state.selectedIds.size === 1) {
    setSelection([object.id], object.id);
  } else {
    setSelection(state.selectedIds, object.id);
  }
  state.pointerMode = "move";
  state.pointerStart = { point, before: state.document, id: object.id, ids: [...state.selectedIds], error: null };
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
    const result = translatedDocument(start.before, start.ids,
      point.x - start.point.x, point.y - start.point.y, { snap: state.snap });
    start.error = result.error ?? null;
    state.document = result.document ?? start.before;
    refreshChrome({ structure: false });
    return;
  }
  if (state.pointerMode === "marquee") {
    const start = state.pointerStart;
    start.current = point;
    start.moved ||= Math.hypot(point.x - start.anchor.x, point.y - start.anchor.y) > 2 / state.zoom;
    if (start.moved) {
      const rect = {
        left: Math.min(start.anchor.x, point.x),
        top: Math.min(start.anchor.y, point.y),
        right: Math.max(start.anchor.x, point.x),
        bottom: Math.max(start.anchor.y, point.y)
      };
      const hits = state.document.objects.filter(object => {
        if (!isSelectable(object)) return false;
        const bounds = objectBounds(object);
        return bounds.x <= rect.right && bounds.x + bounds.width >= rect.left &&
          bounds.y <= rect.bottom && bounds.y + bounds.height >= rect.top;
      }).map(object => object.id);
      setSelection([...new Set([...start.baseSelection, ...hits])]);
    }
    refreshChrome();
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
    const { before, id, error } = state.pointerStart;
    if (state.document !== before) {
      pushUndo(before);
      setStatus(`Moved ${state.selectedIds.size} selected object${state.selectedIds.size === 1 ? "" : "s"} with one shared displacement.`);
    } else if (error) {
      setStatus(error, true);
    }
  } else if (state.pointerMode === "marquee" && !state.pointerStart.moved && !state.pointerStart.baseSelection.length) {
    setSelection([]);
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
  try {
    state.saving = true;
    const identity = { ...state.identity };
    const document = validateFloorDocument(structuredClone(state.document));
    refreshChrome({ structure: false });
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
    state.persisted = true;
    await refreshLevels();
    setStatus("Map saved to the local Studio database.");
    return true;
  } catch (error) {
    setStatus(`Save failed: ${error.message}`, true);
    return false;
  } finally {
    state.saving = false;
    refreshAfterOperation();
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
        : towerSkinFactory(state.artwork, undefined, design, ASSET_CATALOG, state.playerControlMode), {
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
    playCanvas.focus({ preventScroll: true });
    const playControls = state.model === generic.MODEL
      ? "Arrows/WASD move the player."
      : "See the displayed controls for the selected mode.";
    setStatus(`Playing the edited map (unsaved edits included). ${playControls} Stop returns to editing.`);
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

function openPlayerSettings() {
  const dialog = $("#player-settings-dialog");
  if (dialog.open) return;
  const settingsButton = $("#player-settings");
  playerSettingsReturnFocus = isPlaying() ? playHost.querySelector("canvas") : settingsButton;
  window.dispatchEvent(new Event("studio:player-settings-open"));
  updatePlayerSettings();
  refreshPlayerControllerStatus();
  dialog.showModal();
  playerControllerStatusTimer = window.setInterval(refreshPlayerControllerStatus, 250);
}

function closePlayerSettings() {
  if (playerControllerStatusTimer !== null) {
    window.clearInterval(playerControllerStatusTimer);
    playerControllerStatusTimer = null;
  }
  window.dispatchEvent(new Event("studio:player-settings-close"));
  const target = isPlaying() ? playHost.querySelector("canvas") : playerSettingsReturnFocus;
  playerSettingsReturnFocus = null;
  (target?.isConnected ? target : $("#player-settings")).focus({ preventScroll: true });
}

function ignoredShortcutTarget(target) {
  return target instanceof Element &&
    target.closest("input, textarea, select, [contenteditable='true']") !== null;
}

const playInputCodes = new Set([
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "KeyW", "KeyA", "KeyS", "KeyD", "KeyL", "Space"
]);

function configureEvents() {
  configureWorldWorkspace(() => {
    if (!state.document || isPlaying() || state.saving || state.switching || state.creating || state.levelBusy) {
      setStatus("Open a saved level before using Worlds.", true);
      return null;
    }
    return {
      projectId: state.identity.projectId, mapId: state.identity.mapId, model: state.model,
      draw: (ctx, document) => drawDesign(ctx, state.artwork, document, {
        grid: floorDocumentGrid(document), mode: "editor", visible: visibleLayers()
      }),
      hitTest: (document, point) => hitTest(document, point, isSelectable),
      objectBounds,
      validate: validateFloorDocument,
      transform: (object, dx, dy) => {
        const next = { x: Math.round(object.transform.x + dx), y: Math.round(object.transform.y + dy) };
        return state.snap || ASSET_CATALOG[object.assetId].snap.forced ? snapTransform(object.assetId, next) : next;
      }
    };
  });
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
    if (state.switching || state.creating || state.levelBusy ||
        document.querySelector("dialog[open]")) return;
    if (ignoredShortcutTarget(event.target)) return;
    if (isPlaying()) {
      if (event.code === "Escape" && state.play.phase === "playing") stop();
      else if (playInputCodes.has(event.code) ||
          ((event.ctrlKey || event.metaKey) && ["KeyA", "KeyD", "KeyS", "KeyY", "KeyZ"].includes(event.code)) ||
          event.code === "Delete" || event.code === "Backspace") event.preventDefault();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.code === "KeyS") {
      event.preventDefault();
      save();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.code === "KeyA" &&
        event.target === canvas && document.activeElement === canvas) {
      event.preventDefault();
      setSelection(state.document.objects.filter(isSelectable).map(object => object.id));
      refreshChrome();
      setStatus(`Selected ${state.selectedIds.size} objects on visible, unlocked layers.`);
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.code === "KeyD" &&
        event.target === canvas && document.activeElement === canvas && state.selectedIds.size) {
      event.preventDefault();
      duplicateSelection();
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
    if (nudges[event.code] && state.selectedIds.size && event.target === canvas && document.activeElement === canvas) {
      event.preventDefault();
      nudgeSelected(...nudges[event.code]);
      return;
    }
    if ((event.code === "Delete" || event.code === "Backspace") && state.selectedIds.size &&
        event.target === canvas && document.activeElement === canvas) {
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
  $("#duplicate-selection").addEventListener("click", duplicateSelection);
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
  for (const field of [$("#map-width"), $("#map-height")]) {
    field.addEventListener("input", () => {
      const draft = currentMapSizeDraft();
      draft.width = $("#map-width").value;
      draft.height = $("#map-height").value;
      updateMapSettings();
    });
  }
  $("#apply-map-size").addEventListener("click", expandMap);
  $("#cancel-map-size").addEventListener("click", cancelMapSizeDraft);
  $("#clear-level-contents").addEventListener("click", showClearContentsDialog);
  $("#clear-contents-confirm").addEventListener("click", clearLevelContents);
  $("#clear-contents-cancel").addEventListener("click", () => $("#clear-contents-dialog").close());
  $("#camera-zoom").addEventListener("input", event => {
    $("#camera-zoom-value").textContent = `${Number(event.target.value).toFixed(1)}×`;
  });
  $("#camera-zoom").addEventListener("change", event => {
    if (!state.document || isPlaying()) return;
    const cameraZoom = Number(event.target.value);
    if (cameraZoom === state.document.cameraZoom) return;
    commitDocument(validateFloorDocument({ ...state.document, cameraZoom }));
    setStatus(`Gameplay camera zoom set to ${cameraZoom.toFixed(1)}×. Save the level to keep this setting.`);
  });
  $("#open-game").addEventListener("click", showOpenDialog);
  configureNewGame();
  configureLevels();
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
  $("#player-settings").addEventListener("click", openPlayerSettings);
  $("#player-control-mode").addEventListener("change", event => savePlayerControlMode(event.target.value));
  $("#player-settings-close").addEventListener("click", () => $("#player-settings-dialog").close());
  $("#player-settings-dialog").addEventListener("close", closePlayerSettings);
  window.addEventListener("studio:player-controller-status", event =>
    updatePlayerControllerStatus(event.detail.status, event.detail.id));
  updatePlayerSettings();
  $("#play-error-close").addEventListener("click", () => {
    $("#play-error").hidden = true;
    studio.dataset.playState = "idle";
    canvas.focus();
  });
  $("#delete-object").addEventListener("click", deleteSelected);
  $("#delete-selection").addEventListener("click", deleteSelected);
  $("#apply-selection-offset").addEventListener("click", applySelectionOffset);
  $("#selection-inspector").addEventListener("submit", event => event.preventDefault());
  $("#selection-collision").addEventListener("change", event => {
    const objects = selectedObjects();
    if (!objects.length || !objects.every(object => ASSET_CATALOG[object.assetId].collision === "optional")) return;
    const replacements = new Map(objects.map(object => [object.id, {
      ...object,
      collision: event.target.checked ? { ...ASSET_CATALOG[object.assetId].collisionBox } : null
    }]));
    try {
      commitDocument({
        ...state.document,
        objects: state.document.objects.map(object => replacements.get(object.id) ?? object)
      });
      setStatus(`Updated collision for ${objects.length} selected objects. Undo with Ctrl+Z.`);
    } catch (error) {
      setStatus(`Bulk collision edit rejected: ${error.message}`, true);
      refreshChrome({ structure: false });
    }
  });
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
      title.textContent = `${entry.project?.name ?? entry.projectId} / ${entry.name ?? entry.mapId}${entry.starting ? " (Start)" : ""}`;
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

const levelsUrl = projectId => `/api/projects/${encodeURIComponent(projectId)}/levels`;

async function refreshLevels() {
  const projectId = state.identity.projectId;
  const response = await fetch(levelsUrl(projectId));
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? "Could not load levels.");
  if (state.identity.projectId !== projectId) return;
  state.levels = payload.levels;
  state.startingMapId = payload.startingMapId;
  $("#level-message").textContent = "";
  $("#level-select").replaceChildren();
  $("#level-recovery").replaceChildren();
  for (const level of state.levels) {
    if (!level.deletedAt) {
      const option = new Option(`${level.name}${level.starting ? " (Start)" : ""}`, level.mapId);
      option.dataset.mapId = level.mapId;
      option.disabled = !level.supported;
      option.title = level.reason ?? level.mapId;
      $("#level-select").append(option);
      continue;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "level-entry";
    button.dataset.mapId = level.mapId;
    button.textContent = `${level.name}${level.starting ? " (Start)" : ""}${level.deletedAt ? " - Recover" : ""}`;
    button.disabled = !level.supported;
    button.title = level.reason ?? level.mapId;
    button.addEventListener("click", () => {
      runLevelAction("recover", { mapId: level.mapId });
    });
    $("#level-recovery").append(button);
  }
  if (!state.persisted && !state.levels.length && state.document) {
    $("#level-select").append(new Option(`${state.document.name} (not yet saved)`, state.identity.mapId));
  }
  $("#level-select").value = state.identity.mapId;
  refreshChrome({ structure: false });
}

function configureLevels() {
  $("#level-select").addEventListener("change", () => {
    const mapId = $("#level-select").value;
    $("#level-select").value = state.identity.mapId;
    const level = state.levels.find(level => level.mapId === mapId && !level.deletedAt && level.supported);
    if (!level || mapId === state.identity.mapId) return;
    state.openSelection = { projectId: state.identity.projectId, mapId };
    $("#open-list").replaceChildren();
    openMessage(`Open ${level.name}`);
    showSwitchConfirmation(dirty());
    $("#open-dialog").showModal();
    if (!dirty()) requestSwitch();
  });
  for (const action of ["add", "duplicate", "rename", "delete"]) {
    $(`#level-${action}`).addEventListener("click", () => {
      state.levelAction = action;
      const deleting = action === "delete";
      $("#level-title").textContent = { add: "Add blank level", duplicate: "Duplicate level", rename: "Rename level", delete: "Delete level?" }[action];
      $("#level-description").textContent = deleting
        ? "The saved design stays in SQLite and can be recovered from Deleted levels."
        : action === "add" ? "Uses this game's model, project assets and default settings, with safe starts and no copied layout."
        : action === "duplicate" ? "Creates an independent saved design with a new stable map ID." : "Changes this level's name, not its ID.";
      $("#level-name-field").hidden = deleting;
      $("#level-name").disabled = deleting;
      $("#level-name").value = action === "add" ? "New level" : action === "duplicate"
        ? `${state.document.name.slice(0, 59)} copy` : state.document.name;
      const needsReplacement = deleting && state.startingMapId === state.identity.mapId;
      $("#level-replacement-field").hidden = !needsReplacement;
      $("#level-replacement").disabled = !needsReplacement;
      $("#level-replacement").replaceChildren(new Option("Choose a replacement", ""),
        ...state.levels.filter(level => !level.deletedAt && level.supported && level.mapId !== state.identity.mapId)
          .map(level => new Option(level.name, level.mapId)));
      $("#level-unsaved").hidden = !dirty();
      $("#level-discard").hidden = !dirty();
      $("#level-submit").textContent = dirty() ? "Save and continue" : deleting ? "Confirm delete" : "Continue";
      $("#level-error").textContent = "";
      $("#level-dialog").showModal();
    });
  }
  $("#level-start").addEventListener("click", () => runLevelAction("start"));
  $("#level-cancel").addEventListener("click", () => $("#level-dialog").close());
  $("#level-dialog").addEventListener("cancel", event => {
    if (state.levelBusy) event.preventDefault();
  });
  $("#level-form").addEventListener("submit", event => {
    event.preventDefault();
    submitLevelAction(true);
  });
  $("#level-discard").addEventListener("click", () => {
    if ($("#level-form").reportValidity()) submitLevelAction(false);
  });
}

function submitLevelAction(saveFirst) {
  runLevelAction(state.levelAction, {
    name: $("#level-name").value,
    replacementMapId: $("#level-replacement").disabled ? undefined : $("#level-replacement").value
  }, saveFirst);
}

async function runLevelAction(action, values = {}, saveFirst = false) {
  if (state.levelBusy || state.saving || state.switching || isPlaying()) return;
  try {
    state.levelBusy = true;
    $("#level-form").inert = true;
    refreshChrome({ structure: false });
    if ((!state.persisted || (saveFirst && dirty())) && !(await save())) {
      throw new Error("Could not save the current design; it remains open.");
    }
    const response = await fetch(levelsUrl(state.identity.projectId), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, mapId: state.identity.mapId, ...values })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "Level operation failed.");
    if (!["start", "recover"].includes(action)) {
      const mapId = action === "delete"
        ? result.startingMapId : result.mapId;
      const identity = { projectId: state.identity.projectId, mapId };
      const { payload, document: design, assets } = await fetchDesign(identity);
      applyDesign(identity, payload, design, assets);
    }
    await refreshLevels();
    $("#level-dialog").close();
    setStatus(action === "recover" ? "Level recovered with its saved ID and design." : "Level changes saved in SQLite.");
  } catch (error) {
    $("#level-error").textContent = error.message;
    $("#level-message").textContent = error.message;
    setStatus(`Level operation failed: ${error.message}`, true);
  } finally {
    state.levelBusy = false;
    $("#level-form").inert = false;
    refreshAfterOperation();
  }
}

function newGameValues() {
  return generic.validateCreation({
    name: $("#new-name").value, author: $("#new-author").value,
    model: $("#new-model").value,
    ...generic.DEFAULT_DIMENSIONS
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
  try {
    state.creating = true;
    $("#new-fields").disabled = true;
    refreshChrome({ structure: false });
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
    refreshAfterOperation();
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
  clampTransform = (assetId, point, bounds = mapBounds()) =>
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
  const previous = { ...state, scene: { ...state.scene } };
  try {
    installDesign(identity, payload, design, assets);
  } catch (error) {
    Object.assign(state, previous);
    state.scene.document = null;
    state.hierarchyKey = "";
    if (previous.document) {
      activateAssetCatalog(previous.model, {
        catalog: previous.assetCatalog,
        records: previous.importedAssets,
        images: previous.artwork.imported ?? {}
      });
      try {
        updateDesignChrome(previous.loadedPayload);
        configurePalette();
        refreshChrome();
      } catch (recoveryError) {
        throw new Error(`${error.message} Restoring the editor view also failed: ${recoveryError.message}`);
      }
    }
    throw error;
  }
}

function updateDesignChrome(payload) {
  const { identity, document: design } = state;
  const migration = describeMigrations(payload.migrations);
  $("#migration-notice").hidden = !migration;
  $("#migration-history").open = Boolean(migration?.error);
  if (migration) {
    $("#migration-text").textContent = migration.text;
    $("#migration-notice").classList.toggle("error", migration.error);
  }
  $("#project-name").textContent = payload.project
    ? payload.project.name === design.name ? payload.project.name : `${payload.project.name} · ${design.name}`
    : identity.projectId === ASTRAEUM_PROJECT_ID && identity.mapId === ASTRAEUM_FLOOR_1_MAP_ID && design.name === "Damp Corridors"
      ? "Astraeum Tower · Floor 1" : `${identity.projectId} · ${identity.mapId} · ${design.name}`;
  $("#project-name").title = payload.project ? `Author/credits: ${payload.project.author}\n${identity.projectId} / ${identity.mapId}\n${state.model}` : state.model;
  document.title = `Web Studio - ${$("#project-name").textContent}`;
  canvas.setAttribute("aria-label", `${$("#project-name").textContent} map editor`);
  $("#palette-credit").textContent = state.model === generic.MODEL
    ? `Built-in generic shapes${state.importedAssets.length ? ` · ${state.importedAssets.length} imported images` : ""}`
    : `Floor 1 artwork by Anh Nguyen (PixelLab)${state.importedAssets.length ? ` · ${state.importedAssets.length} imported images` : ""}`;
}

function installDesign(identity, payload, design, assets) {
  state.model = payload.model ?? ASTRAEUM_MODEL;
  activateAssetCatalog(state.model, assets);
  state.layers = loadLayerPrefs(state.model);
  state.placeAssetId = null;
  state.paletteDrag = null;
  state.pointerMode = null;
  state.pointerStart = null;
  state.spaceDown = false;
  document.body.classList.remove("dragging-asset");
  state.scene.document = null;
  const migration = describeMigrations(payload.migrations);
  state.identity = identity;
  state.loadedPayload = payload;
  state.persisted = Boolean(payload.document);
  state.levels = [];
  state.startingMapId = null;
  state.document = design;
  state.savedJson = JSON.stringify(state.document);
  setSelection([]);
  state.undo = [];
  state.redo = [];
  state.tool = "select";
  state.preview = null;
  state.hierarchyKey = "";
  $("#play-error").hidden = true;
  studio.dataset.playState = "idle";
  updateDesignChrome(payload);
  configurePalette();
  centerCamera();
  refreshChrome();
  setStatus(payload.document
    ? migration && !migration.error && payload.migrations[0].createdAt && Date.now() - Date.parse(payload.migrations[0].createdAt) < 60_000
      ? "Reopened Floor 1 — upgraded to the object format (see Inspector)."
      : "Reopened the locally saved design."
    : "Opened the original Floor 1 map (not yet saved).");
  refreshLevels().catch(error => {
    $("#level-message").textContent = `Could not load levels: ${error.message}`;
  });
}

async function switchToSelected(saveFirst = false) {
  if (state.switching || !state.openSelection) return;
  const { projectId, mapId, canAdopt } = state.openSelection;
  const identity = { projectId, mapId };
  try {
    state.switching = true;
    $("#open-dialog").querySelectorAll("button, input").forEach(element => { element.disabled = true; });
    refreshChrome({ structure: false });
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
    refreshAfterOperation();
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
      identity: () => ({ ...state.identity }),
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
