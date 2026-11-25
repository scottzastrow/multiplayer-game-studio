import { createLocalGame, mountLocalPreview } from "@multiplayer-game/local-preview";
import { ARTWORK_CREDIT } from "../../games/astraeum-tower/src/catalog.js";
import * as towerProject from "../../games/astraeum-tower/src/project.js";
import * as generic from "../../games/generic-grid-v1/src/project.js";
import { genericPreview, genericSkin } from "../../games/generic-grid-v1/src/runtime.js";
import { createConnectedPreview, connectedSkin } from "../extensions/connected-play.js";
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
import {
  createTowerGameModule,
  createTowerInteractionState,
  towerSettings,
  towerEncounterTuning
} from "../../games/astraeum-tower/src/game.js";
import { towerSkinFactory } from "../../games/astraeum-tower/src/skin.js";
import {
  MAX_MAP_DIMENSION as RUNTIME_MAX_MAP_DIMENSION,
  MAP_CELL_SIZE as RUNTIME_MAP_CELL_SIZE,
  readStandardGamepad
} from "@multiplayer-game/theme-sdk";
import { ASTRAEUM_PROJECT_ID, ASTRAEUM_FLOOR_1_MAP_ID, ASTRAEUM_MODEL } from "../project-identity.js";
import { importedAssetDefinition } from "../project-assets.js";
import { sectionOrigin, worldToSection } from "../world-coordinates.js";
import {
  boundaryEdges,
  createGridRectangleBoundary,
  createPolygonBoundary,
  defaultBoundaryCells,
  playableBoundaryCells,
  validatePlayableBoundaryForSections
} from "../playable-boundaries.js";
import { extendTerrainStroke, terrainBrushFootprint,
  isTerrainBrushAsset } from "../world-terrain.js";
import { fillRectangle, isBorderAsset, isRepeatableAsset, planFill } from "../world-fill.js";
import { isPaintBrushAsset, planPaintStroke } from "../world-paint.js";
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
  "keyboard-only": { label: "Keyboard Only", bindings: "WASD: Move · Arrow keys: Dodge · Space: Attack · H: Use herb · Chests open automatically nearby." },
  "keyboard-mouse": { label: "Keyboard + Mouse", bindings: "Arrow keys move · Pointer aims · Left click attacks · Hold right mouse + arrow to dodge · H: Use herb · Chests open automatically nearby." },
  "game-controller": { label: "Game Controller", bindings: "Left stick moves · Right stick aims · RT attacks · Hold B/Circle + left-stick direction to dodge · Y: Use herb · Chests open automatically nearby." }
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
const SECTION_DIRECTIONS = Object.freeze({
  north: { x: 0, y: -1 }, east: { x: 1, y: 0 },
  south: { x: 0, y: 1 }, west: { x: -1, y: 0 }
});
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
  exporting: false,
  saveError: null,
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
  pendingSectionSave: null,
  openRequest: 0,
  importedAssets: [],
  assetCatalog: towerProject.ASSET_CATALOG,
  savedJson: "",
  artwork: null,
  selectedId: null,
  selectedIds: new Set(),
  inspectedDecoration: null,
  sections: [],
  archivedSections: [],
  activeSectionId: null,
  sectionRevision: 0,
  sectionPlacementDirection: null,
  sectionRemovalId: null,
  sectionBaseline: "",
  boundaryDraft: null,
  boundaryMode: "grid",
  fillPreview: null,
  fillSettings: { gapX: 0, gapY: 0, overlap: "skip", borderAssetId: null, collision: false },
  tool: "select",
  placeAssetId: null,
  paintBrushSize: 1,
  paintDensity: 100,
  paintSpacing: 0,
  paintSeed: 1,
  paintCursor: null,
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

// Temporary, bounded, in-memory observation of the user's real Fill workflow.
const FILL_DIAGNOSTIC_BUILD = "fill-live-2026-11-15-r1";
const fillDiagnostics = {
  loaded: new Date().toISOString(), events: [], sequence: 0,
  documents: new WeakMap(), nextDocument: 0, redraws: 0, sceneBuilds: 0,
  lastRedraw: null, validation: "not run", applying: false, lastApplyEnabled: null
};

function fillDiagnosticDocuments() {
  return state.sections.map(section => {
    const design = section.document;
    if (!fillDiagnostics.documents.has(design)) {
      fillDiagnostics.documents.set(design, ++fillDiagnostics.nextDocument);
    }
    return { section: section.sectionId, ref: fillDiagnostics.documents.get(design),
      objects: design.objects.length, cached: section.scene?.document === design };
  });
}

function fillDiagnosticSnapshot() {
  const fill = state.pointerStart?.mode === "fill" ? state.pointerStart : state.fillPreview;
  const asset = ASSET_CATALOG[state.placeAssetId];
  const layer = asset && state.layers[OBJECT_TYPES[asset.type].layer];
  return {
    tool: state.tool, asset: state.placeAssetId, label: asset?.label ?? null,
    gestureAsset: fill?.assetId ?? null,
    pointer: state.pointerMode, rectangle: fill?.rectangle ?? null,
    preview: { exists: Boolean(state.fillPreview), count: fill?.plan?.count ?? null,
      placements: fill?.plan?.placements?.length ?? null, skipped: fill?.plan?.skipped ?? null,
      overlaps: fill?.plan?.overlaps ?? null, seamSkipped: fill?.plan?.seamSkipped ?? null,
      updates: fill?.plan?.updates?.length ?? null, error: fill?.error ?? null },
    applyEnabled: !$("#fill-apply").disabled,
    panelInert: Boolean($("#fill-apply").closest("[inert]")),
    saving: state.saving, play: state.play.phase, switching: state.switching,
    creating: state.creating, levelBusy: state.levelBusy,
    settings: { ...state.fillSettings }, layer: layer ? { ...layer } : null,
    activeSection: state.activeSectionId, documents: fillDiagnosticDocuments(),
    undo: state.undo.length, redo: state.redo.length,
    validation: fillDiagnostics.validation, redraw: fillDiagnostics.lastRedraw,
    status: $("#status").textContent
  };
}

function updateFillDiagnostics(force = false) {
  const report = $("#fill-diagnostic-report");
  $("#fill-diagnostics").hidden = state.tool !== "fill";
  $("#fill-diagnostic-build").textContent = `Served build: ${FILL_DIAGNOSTIC_BUILD}`;
  if (!force && document.activeElement === report) return;
  const text = [
    `Fill diagnostics | served build=${FILL_DIAGNOSTIC_BUILD}`,
    `loaded=${fillDiagnostics.loaded} | module=${import.meta.url}`,
    `model=${state.model} | level=${state.identity.mapId}`,
    `current ${JSON.stringify(fillDiagnosticSnapshot())}`,
    ...fillDiagnostics.events.map(entry => JSON.stringify(entry))
  ].join("\n");
  if (report.value !== text) report.value = text;
}

function traceFill(event, detail = {}) {
  fillDiagnostics.events.push({ n: ++fillDiagnostics.sequence, at: new Date().toISOString(),
    event, tool: state.tool, asset: state.placeAssetId, pointer: state.pointerMode,
    applyEnabled: !$("#fill-apply").disabled, ...detail });
  if (fillDiagnostics.events.length > 32) fillDiagnostics.events.shift();
  updateFillDiagnostics();
}

function traceFillPointer(event, source) {
  traceFill(`${source}:${event.type}`, {
    id: event.pointerId, button: event.button, client: [event.clientX, event.clientY],
    world: worldPointFromClient(event.clientX, event.clientY),
    captured: canvas.hasPointerCapture(event.pointerId),
    previewExists: Boolean(state.fillPreview), documentLoaded: Boolean(state.document)
  });
}

async function copyFillDiagnostics() {
  updateFillDiagnostics(true);
  const report = $("#fill-diagnostic-report");
  try {
    await navigator.clipboard.writeText(report.value);
    $("#fill-diagnostic-copy-status").textContent = "Report copied.";
  } catch (error) {
    report.focus();
    report.select();
    $("#fill-diagnostic-copy-status").textContent = `Clipboard unavailable (${error.message}); press Ctrl+C to copy the selected report.`;
  }
}

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
  if (cameraZoom) cameraZoom.disabled = !state.document || isPlaying() || state.saving || state.switching ||
    Boolean(state.fillPreview || state.boundaryDraft || state.pointerMode);
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
function levelBounds() {
  if (!state.sections.length) return mapBounds();
  const points = state.sections.map(section => {
    const origin = sectionOrigin(section.gridX, section.gridY);
    return { left: origin.x, top: origin.y,
      right: origin.x + Math.max(2048, section.document.bounds.width),
      bottom: origin.y + Math.max(2048, section.document.bounds.height) };
  });
  return { x: Math.min(...points.map(point => point.left)), y: Math.min(...points.map(point => point.top)),
    width: Math.max(...points.map(point => point.right)) - Math.min(...points.map(point => point.left)),
    height: Math.max(...points.map(point => point.bottom)) - Math.min(...points.map(point => point.top)) };
}

function setSelection(ids, preferredId = null) {
  state.inspectedDecoration = null;
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
  if (state.sections.length > 1) {
    message.textContent = "Section dimensions are fixed; use Add Section to expand this level.";
    width.disabled = true;
    height.disabled = true;
    $("#apply-map-size").disabled = true;
    $("#cancel-map-size").disabled = true;
    return;
  }
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

const activeSection = () => state.sections.find(section => section.sectionId === state.activeSectionId) ?? null;
const allSections = () => [...state.sections, ...state.archivedSections];
const rootSection = () => allSections().find(section => section.mapId === state.identity.mapId);
const usesConnectedPreview = () => state.sections.length > 0 && (state.sections.length > 1 ||
  (state.model === ASTRAEUM_MODEL && state.sections.some(section =>
    section.document.objects.some(object => object.assetId === "prop-stairs-rune"))) ||
  !state.sections.some(section => section.mapId === state.identity.mapId));
const sectionDocuments = () => state.sections.map(section => section.document);
function boundarySections() {
  return state.sections.map(({ gridX, gridY, document }) => ({ gridX, gridY, document }));
}
function levelBoundary() {
  const root = rootSection();
  return root?.document.playableBoundary ?? null;
}
function dirty() {
  if (state.pendingSectionSave) return true;
  return state.sections.length
    ? allSections().some(section => section.isNew ||
      JSON.stringify(section.document) !== section.savedJson ||
      Boolean(section.savedArchived) !== state.archivedSections.includes(section))
    : JSON.stringify(state.document) !== state.savedJson;
}

function setStatus(message, isError = false) {
  const status = $("#status");
  status.textContent = message;
  status.classList.toggle("error", isError);
  if (state.tool === "fill" || fillDiagnostics.applying) {
    traceFill("status", { message, error: isError });
  }
}

// ---------------------------------------------------------------- history

function pushUndo(before) {
  const documents = allSections().map(section => ({
    sectionId: section.sectionId,
    document: section.sectionId === state.activeSectionId ? before : section.document
  }));
  state.undo.push({ documents, selection: [...state.selectedIds], sectionId: state.activeSectionId });
  if (state.undo.length > HISTORY_LIMIT) state.undo.shift();
  state.redo.length = 0;
}

function restoreHistory(entry) {
  if (entry.membership?.kind === "draft-add") {
    const { sectionId, present } = entry.membership;
    const activeIndex = state.sections.findIndex(section => section.sectionId === sectionId);
    const archivedIndex = state.archivedSections.findIndex(section => section.sectionId === sectionId);
    const section = activeIndex >= 0 ? state.sections[activeIndex]
      : archivedIndex >= 0 ? state.archivedSections[archivedIndex] : entry.membership.section;
    if (present) {
      if (state.sections.some(item => item.sectionId !== sectionId &&
          item.gridX === section.gridX && item.gridY === section.gridY)) {
        throw new Error("The section position is occupied. Remove the occupying section before undoing.");
      }
      if (archivedIndex >= 0) state.archivedSections.splice(archivedIndex, 1);
      if (activeIndex < 0) state.sections.push(section);
      state.sections.sort((a, b) => a.gridY - b.gridY || a.gridX - b.gridX);
    } else {
      if (state.sections.length <= 1) throw new Error("A level must retain at least one section.");
      if (activeIndex < 0) throw new Error("The section is no longer available in this history state.");
      if (section.isNew && state.pendingSectionSave?.sections.some(item => item.sectionId === sectionId)) {
        throw new Error("Retry the pending save before removing this newly added section.");
      }
      if (!section.isNew && archivedIndex < 0 && state.archivedSections.length >= 16) {
        throw new Error("The retained archive is full. Save or recover archived sections before undoing this addition.");
      }
      state.sections.splice(activeIndex, 1);
      if (!section.isNew && archivedIndex < 0) state.archivedSections.push(section);
    }
  } else if (entry.membership) {
    const { sectionId, restore } = entry.membership;
    const source = restore ? state.archivedSections : state.sections;
    const target = restore ? state.sections : state.archivedSections;
    const index = source.findIndex(section => section.sectionId === sectionId);
    if (index < 0) throw new Error("The section is no longer available in this history state.");
    const section = source[index];
    if (restore && state.sections.some(item => item.gridX === section.gridX && item.gridY === section.gridY)) {
      throw new Error("The section position is occupied. Remove the occupying section before undoing.");
    }
    if (!restore && state.sections.length <= 1) throw new Error("A level must retain at least one section.");
    if (!restore && state.archivedSections.length >= 16) {
      throw new Error("The retained archive is full. History was not changed.");
    }
    source.splice(index, 1);
    target.push(section);
    state.sections.sort((a, b) => a.gridY - b.gridY || a.gridX - b.gridX);
  }
  for (const saved of entry.documents ?? []) {
    const section = allSections().find(item => item.sectionId === saved.sectionId);
    if (section) section.document = saved.document;
  }
  state.activeSectionId = state.sections.some(section => section.sectionId === entry.sectionId)
    ? entry.sectionId : state.sections[0].sectionId;
  state.document = activeSection().document;
  setSelection(entry.selection.filter(id => state.document.objects.some(object => object.id === id) &&
    isSelectable(state.document.objects.find(object => object.id === id))));
  state.scene.document = null;
  state.hierarchyKey = "";
  refreshChrome();
}

/** Documents are never mutated in place, so history can keep references. */
function commitDocument(next, before = state.document) {
  state.document = validateFloorDocument(next);
  if (activeSection()) activeSection().document = state.document;
  pushUndo(before);
  refreshChrome();
}

function replaceObject(document, id, patch) {
  return { ...document, objects: document.objects.map(object => object.id === id ? { ...object, ...patch } : object) };
}

function undo() {
  if (!state.undo.length || isPlaying() || state.saving || state.switching || state.creating || state.levelBusy ||
      state.fillPreview || state.boundaryDraft || state.pointerMode) return;
  applyHistory(state.undo, state.redo, "Undone.");
}

function redo() {
  if (!state.redo.length || isPlaying() || state.saving || state.switching || state.creating || state.levelBusy ||
      state.fillPreview || state.boundaryDraft || state.pointerMode) return;
  applyHistory(state.redo, state.undo, "Redone.");
}

function applyHistory(from, to, message) {
  const entry = from.at(-1);
  const membership = entry.membership?.kind === "draft-add"
    ? { ...entry.membership, present: !entry.membership.present,
      section: allSections().find(section => section.sectionId === entry.membership.sectionId) ??
        entry.membership.section }
    : entry.membership ? { ...entry.membership, restore: !entry.membership.restore } : null;
  const previous = { sections: [...state.sections], archivedSections: [...state.archivedSections],
    documents: allSections().map(section => ({ section, document: section.document })),
    sectionId: state.activeSectionId, selection: [...state.selectedIds], from: [...from], to: [...to] };
  const inverse = { documents: allSections().map(section => ({ sectionId: section.sectionId, document: section.document })),
    selection: [...state.selectedIds], sectionId: state.activeSectionId,
    ...(membership ? { membership } : {}) };
  try {
    restoreHistory(entry);
    from.pop();
    to.push(inverse);
    refreshChrome();
    setStatus(message);
  } catch (error) {
    state.sections = previous.sections;
    state.archivedSections = previous.archivedSections;
    from.splice(0, from.length, ...previous.from);
    to.splice(0, to.length, ...previous.to);
    for (const saved of previous.documents) saved.section.document = saved.document;
    state.activeSectionId = previous.sectionId;
    state.document = activeSection().document;
    setSelection(previous.selection);
    state.scene.document = null;
    state.hierarchyKey = "";
    setStatus(`History could not be restored: ${error.message}`, true);
    refreshAfterOperation();
  }
}

// ---------------------------------------------------------------- chrome

function refreshChrome({ structure = true } = {}) {
  if (activeSection() && activeSection().document !== state.document) activeSection().document = state.document;
  const loaded = Boolean(state.document);
  const isDirty = loaded && (dirty() || !state.persisted);
  updatePlayerSettings();
  updateMapSettings();
  $("#save-state").textContent = state.saveError ? "Save failed - unsaved" :
    !loaded ? "Not loaded" : isDirty ? "● Unsaved changes" : "✓ Saved";
  $("#save-state").className = `save-state ${isDirty || !loaded ? "dirty" : "saved"}`;
  $("#save-state").classList.toggle("error", Boolean(state.saveError));
  $("#save-error").textContent = state.saveError ?? "";
  $("#save-error").hidden = !state.saveError;
  $("#save").disabled = !loaded || (!isDirty && state.persisted) || isPlaying() || Boolean(state.fillPreview);
  $("#save").disabled ||= state.saving;
  const pendingGesture = Boolean(state.fillPreview || state.boundaryDraft || state.pointerMode);
  $("#export-game").disabled = !loaded || state.model !== ASTRAEUM_MODEL || isPlaying() ||
    state.saving || state.exporting || state.switching || state.creating || state.levelBusy || pendingGesture;
  $("#export-game").title = state.model !== ASTRAEUM_MODEL
    ? "Export Game is available for Astraeum Floor campaigns."
    : pendingGesture ? "Apply or cancel the current edit before exporting."
    : "Export the saved Astraeum campaign as a ZIP.";
  $("#open-game").disabled = isPlaying() || state.saving || state.switching || !state.artwork;
  $("#new-game").disabled = isPlaying() || state.saving || state.switching || state.creating || !state.artwork;
  $("#import-assets").disabled = !loaded || isPlaying() || state.saving || state.switching || state.creating;
  for (const id of ["open-game", "new-game", "import-assets", "save"]) $(`#${id}`).disabled ||= pendingGesture;
  $("#play").disabled = !loaded || isPlaying() || state.saving || !state.artwork || pendingGesture;
  $("#play").title = usesConnectedPreview()
    ? state.model === ASTRAEUM_MODEL
      ? "Play all sections with combat and authored stairs exits. Doors are decorative."
      : "Play all sections of this level (movement, camera and collision only)."
    : pendingGesture ? "Apply or cancel the current edit before Play." : "Play this level.";
  $("#play-limitation").hidden = !usesConnectedPreview();
  for (const id of ["save", "play", "open-game", "new-game", "import-assets"]) {
    $(`#${id}`).disabled ||= state.levelBusy || state.switching;
  }
  const levelDisabled = !loaded || isPlaying() || state.saving || state.switching || state.creating || state.levelBusy || pendingGesture;
  $(".workspace").inert = state.switching || state.creating || state.levelBusy;
  $(".hierarchy").inert = Boolean(state.fillPreview || state.boundaryDraft);
  $(".inspector").inert = Boolean(state.fillPreview || state.boundaryDraft);
  $("#asset-list").inert = state.switching || state.creating || state.levelBusy || Boolean(state.fillPreview || state.boundaryDraft);
  for (const action of ["add", "duplicate", "rename", "start", "delete"]) {
    $(`#level-${action}`).disabled = levelDisabled ||
      (action === "start" && state.startingMapId === state.identity.mapId) ||
      (action === "delete" && state.levels.filter(level => !level.deletedAt).length <= 1);
  }
  $("#level-select").disabled = levelDisabled;
  $("#level-recovery").inert = levelDisabled;
  $("#undo").disabled = state.undo.length === 0 || levelDisabled;
  $("#redo").disabled = state.redo.length === 0 || levelDisabled;
  $("#duplicate-selection").disabled = !loaded || !selectedObjects().length || isPlaying() ||
    state.saving || state.switching || state.creating || state.levelBusy || pendingGesture;
  $("#clear-level-contents").disabled = !loaded || isPlaying() || state.saving ||
    state.switching || state.creating || state.levelBusy || pendingGesture;
  $("#zoom-label").textContent = `${Math.round(state.zoom * 100)}%`;
  $("#editor-tool").value = state.tool;
  canvas.dataset.tool = state.tool;
  $("#editor-tool").disabled = levelDisabled;
  $("#tool-settings").hidden = state.tool === "select";
  $("#paint-options").hidden = state.tool !== "paint";
  $("#fill-actions").hidden = state.tool !== "fill";
  $("#fill-options").hidden = state.tool !== "fill";
  $("#boundary-options").hidden = state.tool !== "boundary";
  $("#boundary-mode").value = state.boundaryMode;
  $("#boundary-mode").disabled = levelDisabled || pendingGesture;
  const asset = ASSET_CATALOG[state.placeAssetId];
  const paintTool = isPaintBrushAsset(asset);
  const targetLayer = asset && state.layers[OBJECT_TYPES[asset.type].layer];
  if (state.tool === "paint") refreshPaintSettings(asset, levelDisabled || Boolean(state.pointerMode));
  refreshFillSettings(asset);
  $("#tool-hint").textContent = state.fillPreview
    ? state.fillPreview.error ? `Fill preview rejected: ${state.fillPreview.error}. Cancel to try again.`
      : fillSummary(state.fillPreview.plan)
    : state.tool === "boundary"
      ? "Drag a grid area or draw a lasso polygon. The preview shows the playable cells; Apply or Cancel before editing."
    : !asset ? state.tool === "fill" ? "Choose a fill asset from the palette" : "Choose an asset from the palette."
    : state.tool === "fill" && !isRepeatableAsset(asset) ? "Rectangle Fill repeats static terrain, walls and props only; not spawns or unique gameplay objects."
    : (paintTool || state.tool === "fill") && (!targetLayer.visible || targetLayer.locked)
      ? `${asset.label}: Target layer is ${targetLayer.locked ? "locked. Unlock" : "hidden. Show"} it in Layers before painting or filling.`
    : `${asset.label}: ${state.tool === "fill" ? "Drag a rectangle, then Apply or Cancel."
      : paintTool ? "Drag to paint; preview shows the actual proposed placements." : "Click to place; drag from the palette to position."}`;
  $("#fill-apply").disabled = !state.fillPreview || state.fillPreview.error || state.saving || isPlaying();
  $("#fill-cancel").disabled = state.tool !== "fill" || state.saving || isPlaying();
  if (state.tool === "fill" || !$("#fill-diagnostics").hidden) {
    const enabled = !$("#fill-apply").disabled;
    if (fillDiagnostics.lastApplyEnabled !== enabled) {
      fillDiagnostics.lastApplyEnabled = enabled;
      traceFill("apply-enabled-state", { enabled, previewError: state.fillPreview?.error ?? null });
    } else updateFillDiagnostics();
  }
  $("#boundary-apply").disabled = !state.boundaryDraft || state.boundaryDraft.error || state.saving || isPlaying();
  $("#boundary-cancel").disabled = !state.boundaryDraft || state.saving || isPlaying();
  $("#boundary-reset").disabled = !levelBoundary() || pendingGesture || levelDisabled;
  $("#boundary-status").textContent = state.boundaryDraft
    ? state.boundaryDraft.error
      ? `Preview rejected: ${state.boundaryDraft.error}`
      : `${state.boundaryDraft.cells.size} playable grid cell(s) previewed. Apply or Cancel.`
    : levelBoundary() ? "Custom boundary is active; Reset restores the section union."
      : "Default boundary is the union of existing sections.";
  $("#section-select").disabled = levelDisabled;
  $("#section-add").disabled = levelDisabled || !state.persisted || state.sections.length >= 16 || Boolean(state.pendingSectionSave);
  $("#section-add").title = !state.persisted ? "Save this initial level before adding sections."
    : state.pendingSectionSave ? "Retry the pending save before adding another section."
    : state.sections.length >= 16 ? "This level reached the 16-section limit." : "Choose a side of the selected section.";
  const archiveFull = state.archivedSections.length >= 16 && !activeSection()?.isNew;
  $("#section-remove").disabled = levelDisabled || state.sections.length <= 1 || archiveFull;
  $("#section-remove").title = state.sections.length <= 1 ? "A level must retain at least one section."
    : archiveFull ? "The level has reached its 16-section retained archive limit."
    : "Review removal of the selected section.";
  $("#section-remove-confirm").disabled = levelDisabled || !state.sectionRemovalId ||
    state.sectionRemovalId !== state.activeSectionId || Boolean(sectionRemovalProblem(activeSection()));
  $("#section-remove-cancel").disabled = levelDisabled;
  if (state.sectionRemovalId && !$("#section-removal").hidden) updateSectionRemoval();
  $("#section-cancel").disabled = levelDisabled;
  updateSectionPicker(levelDisabled);
  canvas.classList.toggle("selecting", state.tool === "select");
  canvas.classList.toggle("boundary-tool", state.tool === "boundary");
  for (const card of $("#asset-list").querySelectorAll(".asset-card")) {
    card.classList.toggle("active", state.tool !== "select" && card.dataset.assetId === state.placeAssetId);
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
  const key = `${state.activeSectionId}|${objects.length}|${objects.map(object => object.id).join(",").length}|${selectionKey}|` +
    `${unresolved.map(object => object.id).join(",")}|` +
    `${JSON.stringify(state.layers)}|${[...state.openGroups].join(",")}|${state.undo.length}|${state.redo.length}`;
  if (key === state.hierarchyKey) return;
  state.hierarchyKey = key;
  $("#object-count").textContent = String(objects.length);
  if (activeSection()) {
    $("#section-summary").textContent = `${state.sections.length} section(s) in this level` +
      (state.sections.length >= 16 ? " · maximum 16 sections reached" : "");
  }
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
        item.dataset.sectionId = state.activeSectionId ?? "";
        item.dataset.identity = `${state.activeSectionId ?? ""}/${object.id}`;
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

let exitInspectorSelection = null;
let exitInspectorVersion = 0;
let inspectorIdentity = "";

function updateBehaviorInspector(object) {
  const asset = object && ASSET_CATALOG[object.assetId];
  const tower = state.model === ASTRAEUM_MODEL;
  const aries = tower && object?.assetId === "spawn-aries";
  const slime = tower && object?.assetId === "spawn-slime";
  const chest = tower && asset?.interaction?.kind === "chest";
  $("#combat-inspector").hidden = !aries && !slime;
  $("#chest-inspector").hidden = !chest;
  if (!object) return;
  $("#object-heading").textContent = aries ? "Aries - player start" : slime ? "Slime - enemy spawn"
    : tower && object.assetId === "prop-stairs-rune" ? "Stairs rune - level exit"
      : asset.imported ? `${asset.label} - decorative artwork` : asset.label;
  if (chest) {
    const tier = object.interaction?.tier ?? asset.interaction.defaultTier;
    $("#chest-tier").value = tier;
    $("#chest-tier-details").textContent = tier === "treasure"
      ? "4-6 items · rare pool: herb, sapphire, ruby, emerald, mana crystal (weighted twice), or amethyst · Floor 1 gold baseline: 24-39."
      : "2-4 items · original pool: herb (weighted twice), mushroom, amethyst (weighted twice), sapphire, ruby, or emerald · Floor 1 gold baseline: 10-16.";
  }
  $("#object-behavior").textContent = aries
    ? "Authored player spawn, not a live character. Edit its start position below. Control mode and level camera zoom are in Player Settings."
    : slime ? "Authored enemy spawn. Its position and presence are editable; every living authored slime in active sections keeps stairs exits locked."
      : asset.imported ? "Visual artwork only - not an exit, player or enemy, regardless of its image or name. No destination, AI, combat, animation or interaction settings are supported. " +
        (tower ? "Place a built-in Stairs portal, Aries start or Slime spawn for gameplay; this artwork is not converted."
          : "Use built-in gameplay assets supported by this game's runtime; this artwork is not converted.")
        : asset.playNote;
  if (!aries && !slime) return;
  const tuning = towerEncounterTuning;
  const values = aries ? [
    ["Starting / max HP", tuning.playerHp], ["Starting / max stamina", tuning.stamina],
    ["Movement (px / frame)", towerSettings.playerSpeed],
    ["Halberd base damage", tuning.halberd.damage], ["Halberd range (px)", tuning.halberd.range],
    ["Attack cooldown (frames)", tuning.halberd.cooldownFrames],
    ["Dodge cost", tuning.dodge.staminaCost], ["Dodge duration (frames)", tuning.dodge.durationFrames],
    ["Hit invulnerability (frames)", tuning.invulnerabilityFrames]
  ] : [
    ["HP", tuning.slime.hp], ["Contact damage", tuning.slime.damage],
    ["Base speed (px / frame)", tuning.slime.speed], ["Aggro range (px)", tuning.slime.aggro],
    ["Hop period (frames)", tuning.slime.hopPeriod], ["Hop duration (frames)", tuning.slime.hopFrames],
    ["Hop speed multiplier", tuning.slime.hopMultiplier]
  ];
  $("#combat-values").replaceChildren(...values.flatMap(([label, value]) => {
    const name = document.createElement("span"), output = document.createElement("output");
    name.textContent = label;
    output.textContent = String(value);
    return [name, output];
  }));
  $("#combat-authoring-note").textContent = "Fixed by the current Tower combat module, not saved per object. " +
    "Per-character HP, stamina, damage, speed, weapons, AI, drops and abilities cannot be authored here. " +
    (aries ? "Level transitions carry current HP/stamina/facing; these are new-run defaults." : "Each Play/level entry creates a fresh slime encounter.");
}

async function loadExitLevel(levelId) {
  const projectId = state.identity.projectId;
  const response = await fetch(levelsUrl(projectId));
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? "Could not check destination levels. Retry the exit.");
  const level = payload.levels?.find(level => level.mapId === levelId && !level.deletedAt);
  if (!level || !level.supported) {
    throw new Error("The destination level is missing, deleted or unsupported. Select an available level in this game's exit Inspector.");
  }
  if (state.identity.projectId !== projectId) throw new Error("The current game changed. Select the exit again.");
  if (levelId === state.identity.mapId) {
    return state.play.sourceLevel ??
      { mapId: levelId, sections: state.sections, rootDocument: rootSection()?.document };
  }
  const sectionResponse = await fetch(`${levelsUrl(projectId)}/${encodeURIComponent(levelId)}/sections`);
  const data = await sectionResponse.json();
  if (!sectionResponse.ok) throw new Error(data.error ?? "Could not load the destination's complete section set. Retry or select another level.");
  if (data.projectId !== projectId || data.levelMapId !== levelId || data.model !== ASTRAEUM_MODEL ||
      !Array.isArray(data.sections) || !data.sections.length) {
    throw new Error("The destination must be an Astraeum level in the current game with active sections.");
  }
  if ([...data.sections, ...(data.archivedSections ?? [])].some(section =>
    section.document?.id !== section.mapId)) {
    throw new Error("A destination section document does not match its saved identity. Reopen or repair that level.");
  }
  const root = [...data.sections, ...(data.archivedSections ?? [])].find(section => section.mapId === levelId);
  if (!root) throw new Error("The destination boundary owner is missing. Reopen or repair that level before using this exit.");
  return { mapId: levelId, sections: data.sections, rootDocument: root.document,
    revision: data.revision, persisted: true, dirty: false };
}

function exitPreview(level, destination, playerState, interactionState) {
  if (!destination?.levelId || !destination.sectionId || !destination.startId) {
    throw new Error("This exit has no complete destination. In its Inspector, select a destination level and player start.");
  }
  return createConnectedPreview(level.sections, {
    mapId: level.mapId, rootDocument: level.rootDocument, model: ASTRAEUM_MODEL,
    assetCatalog: ASSET_CATALOG, arrival: destination, playerState, interactionState,
    requireNeutral: true
  });
}

function updateExitInspector(object) {
  const visible = state.model === ASTRAEUM_MODEL && object?.assetId === "prop-stairs-rune";
  $("#exit-inspector").hidden = !visible;
  if (!visible) {
    exitInspectorSelection = null;
    exitInspectorVersion++;
    return;
  }
  if (exitInspectorSelection?.object === object && exitInspectorSelection.projectId === state.identity.projectId &&
      exitInspectorSelection.levels === state.levels) return;
  exitInspectorSelection = { object, projectId: state.identity.projectId, levels: state.levels };
  const version = ++exitInspectorVersion;
  const destination = object.exit;
  const levels = $("#exit-level"), starts = $("#exit-start"), message = $("#exit-message");
  levels.replaceChildren(new Option("Choose a destination level", ""));
  for (const level of state.levels.filter(level => !level.deletedAt && level.supported)) {
    levels.append(new Option(level.name, level.mapId));
  }
  if (destination?.levelId && !state.levels.some(level =>
    level.mapId === destination.levelId && !level.deletedAt && level.supported)) {
    levels.append(new Option(`Missing/deleted level: ${destination.levelId}`, destination.levelId));
  }
  levels.value = destination?.levelId ?? "";
  starts.replaceChildren(new Option("Choose a player start", ""));
  starts.disabled = true;
  message.textContent = destination?.levelId ? "Checking destination..." :
    "Select a level and an active Aries start. No destination is assigned automatically.";
  if (!destination?.levelId) return;
  void (async () => {
    try {
      const level = await loadExitLevel(destination.levelId);
      if (version !== exitInspectorVersion) return;
      for (const section of level.sections) {
        for (const start of section.document.objects.filter(object => object.assetId === "spawn-aries")) {
          starts.append(new Option(`${section.document.name}: ${start.id} (${start.transform.x}, ${start.transform.y})`,
            JSON.stringify([section.sectionId, start.id])));
        }
      }
      starts.disabled = starts.children.length === 1;
      if (starts.disabled) {
        message.textContent = "No active Aries start. Open the destination and place exactly one Aries start, then reselect this exit.";
        return;
      }
      const selected = destination.sectionId && destination.startId
        ? JSON.stringify([destination.sectionId, destination.startId]) : "";
      starts.value = selected;
      if (!selected) {
        message.textContent = "Select the destination's active Aries start.";
        return;
      }
      const preview = exitPreview(level, destination);
      const probe = await createLocalGame(preview.options);
      probe.dispose();
      if (version === exitInspectorVersion) message.textContent = "Destination and arrival are valid. All active sections will load; HP and stamina carry over.";
    } catch (error) {
      if (version === exitInspectorVersion) {
        message.textContent = `Exit needs attention: ${error.message} Open the destination to repair its active sections/start, or choose another destination.`;
      }
    }
  })();
}

function updateInspector() {
  updateUnresolvedSummary();
  const object = selectedObject();
  const selected = selectedObjects();
  const multiple = selected.length > 1;
  const decoration = state.inspectedDecoration?.sectionId === state.activeSectionId;
  const identity = `${state.identity.projectId}/${state.identity.mapId}/${state.activeSectionId}/${decoration ? "generated-door" : [...state.selectedIds].join(",")}`;
  if (identity !== inspectorIdentity) {
    $(".inspector").scrollTop = 0;
    inspectorIdentity = identity;
  }
  $("#decoration-inspector").hidden = !decoration;
  updateBehaviorInspector(multiple ? null : object);
  updateExitInspector(multiple ? null : object);
  $("#empty-inspector").hidden = selected.length > 0 || decoration;
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
    const origin = activeSection() ? sectionOrigin(activeSection().gridX, activeSection().gridY) : { x: 0, y: 0 };
    const worldBounds = { x: bounds.x + origin.x, y: bounds.y + origin.y };
    const visibleWidth = state.viewportWidth / state.zoom;
    const visibleHeight = state.viewportHeight / state.zoom;
    if (worldBounds.x < state.cameraX || worldBounds.y < state.cameraY ||
        worldBounds.x + bounds.width > state.cameraX + visibleWidth ||
        worldBounds.y + bounds.height > state.cameraY + visibleHeight) {
      state.cameraX = worldBounds.x + bounds.width / 2 - visibleWidth / 2;
      state.cameraY = worldBounds.y + bounds.height / 2 - visibleHeight / 2;
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
  if (tool === "fill" || state.tool === "fill") traceFill("tool-request", { requested: tool });
  if ((state.fillPreview || state.boundaryDraft || ["brush", "fill", "boundary-grid", "boundary-polygon"].includes(state.pointerMode)) &&
      tool !== state.tool) {
    setStatus("Apply or cancel the pending tool preview before changing tools.", true);
    return;
  }
  state.tool = ["paint", "fill", "boundary"].includes(tool) ? tool : "select";
  state.paintCursor = null;
  state.preview = null;
  refreshChrome({ structure: false });
}

// ---------------------------------------------------------------- rendering

function visibleLayers() {
  return Object.fromEntries(DESIGN_LAYERS.map(layer => [layer.id, state.layers[layer.id].visible]));
}

function sceneCanvas(design = state.document, section = activeSection()) {
  const visible = visibleLayers();
  const key = JSON.stringify(visible);
  const scene = section ? (section.scene ??= { document: null, key: "", canvas: null }) : state.scene;
  if (scene.document === design && scene.key === key && scene.canvas) return scene.canvas;
  if (!scene.canvas) {
    scene.canvas = document.createElement("canvas");
  }
  scene.canvas.width = design.bounds.width;
  scene.canvas.height = design.bounds.height;
  const sceneContext = scene.canvas.getContext("2d", { alpha: false });
  sceneContext.imageSmoothingEnabled = false;
  drawDesign(sceneContext, state.artwork, design, {
    grid: floorDocumentGrid(design),
    mode: "editor",
    visible,
    decorations: design.objects.length > 0
  });
  scene.document = design;
  scene.key = key;
  if (state.tool === "fill" || fillDiagnostics.applying) fillDiagnostics.sceneBuilds++;
  return scene.canvas;
}

function drawBoundaryCells(cells, fillStyle) {
  const rows = new Map();
  for (const key of cells) {
    const [x, y] = key.split(",").map(Number);
    if (!rows.has(y)) rows.set(y, []);
    rows.get(y).push(x);
  }
  context.fillStyle = fillStyle;
  for (const [y, values] of rows) {
    values.sort((left, right) => left - right);
    let start = values[0];
    let previous = start;
    for (let index = 1; index <= values.length; index += 1) {
      const current = values[index];
      if (current !== previous + 1) {
        context.fillRect(start * CELL, y * CELL, (previous - start + 1) * CELL, CELL);
        start = current;
      }
      previous = current;
    }
  }
}

function drawBoundaryEdges(cells, color) {
  context.save();
  context.strokeStyle = color;
  context.lineWidth = 2 / state.zoom;
  context.beginPath();
  for (const edge of boundaryEdges(cells)) {
    context.moveTo(edge.x1 * CELL, edge.y1 * CELL);
    context.lineTo(edge.x2 * CELL, edge.y2 * CELL);
  }
  context.stroke();
  context.restore();
}

function drawBoundaryOverlay() {
  if (!state.sections.length || (state.tool !== "boundary" && !levelBoundary())) return;
  const sections = boundarySections();
  const current = levelBoundary()
    ? playableBoundaryCells(levelBoundary(), sections) : defaultBoundaryCells(sections);
  if (state.tool === "boundary") drawBoundaryCells(current, "#60d6a11c");
  drawBoundaryEdges(current, "#66d6a1cc");
  if (state.tool !== "boundary") return;
  const draft = state.boundaryDraft;
  if (draft?.cells?.size) {
    drawBoundaryCells(draft.cells, draft.error ? "#ff586044" : "#51c8ff55");
    if (!draft.error) drawBoundaryEdges(draft.cells, "#7bd8ff");
  }
  const points = draft?.points ?? (state.pointerMode === "boundary-polygon" ? state.pointerStart.points : null);
  if (points?.length) {
    context.save();
    context.strokeStyle = draft?.error ? "#ff6670" : "#b8ecff";
    context.lineWidth = 2 / state.zoom;
    context.setLineDash([6 / state.zoom, 4 / state.zoom]);
    context.beginPath();
    points.forEach(([x, y], index) => {
      if (!index) context.moveTo(x * CELL, y * CELL);
      else context.lineTo(x * CELL, y * CELL);
    });
    if (draft?.boundary) context.closePath();
    context.stroke();
    context.restore();
  }
  if (state.pointerMode === "boundary-grid") {
    const { start, current: end } = state.pointerStart;
    const left = Math.min(start.x, end.x);
    const top = Math.min(start.y, end.y);
    context.save();
    context.fillStyle = "#51c8ff44";
    context.strokeStyle = "#7bd8ff";
    context.lineWidth = 2 / state.zoom;
    context.fillRect(left * CELL, top * CELL,
      (Math.abs(end.x - start.x) + 1) * CELL, (Math.abs(end.y - start.y) + 1) * CELL);
    context.strokeRect(left * CELL, top * CELL,
      (Math.abs(end.x - start.x) + 1) * CELL, (Math.abs(end.y - start.y) + 1) * CELL);
    context.restore();
  }
}

function drawMap() {
  context.setTransform(state.pixelRatio, 0, 0, state.pixelRatio, 0, 0);
  context.imageSmoothingEnabled = false;
  context.fillStyle = "#14161a";
  context.fillRect(0, 0, state.viewportWidth, state.viewportHeight);
  const scale = state.pixelRatio * state.zoom;
  context.setTransform(scale, 0, 0, scale, -state.cameraX * scale, -state.cameraY * scale);
  context.imageSmoothingEnabled = false;
  const sections = state.sections.length ? state.sections : [{
    gridX: 0, gridY: 0, document: state.document, sectionId: state.activeSectionId
  }];
  for (const section of sections) {
    const origin = sectionOrigin(section.gridX, section.gridY);
    const visibleWidth = state.viewportWidth / state.zoom;
    const visibleHeight = state.viewportHeight / state.zoom;
    if (origin.x + 2048 < state.cameraX || origin.y + 2048 < state.cameraY ||
        origin.x > state.cameraX + visibleWidth || origin.y > state.cameraY + visibleHeight) continue;
    context.drawImage(sceneCanvas(section.document, section), origin.x, origin.y);
    context.strokeStyle = "#ffd16688";
    context.lineWidth = 2 / state.zoom;
    context.strokeRect(origin.x, origin.y, Math.max(2048, section.document.bounds.width),
      Math.max(2048, section.document.bounds.height));
    if (state.showGrid) {
      context.save();
      context.strokeStyle = "#d4e4f21b";
      context.lineWidth = 1 / state.zoom;
      context.beginPath();
      for (let x = 0; x <= section.document.bounds.width; x += CELL) {
        context.moveTo(origin.x + x, origin.y);
        context.lineTo(origin.x + x, origin.y + section.document.bounds.height);
      }
      for (let y = 0; y <= section.document.bounds.height; y += CELL) {
        context.moveTo(origin.x, origin.y + y);
        context.lineTo(origin.x + section.document.bounds.width, origin.y + y);
      }
      context.stroke();
      context.restore();
    }
  }
  drawBoundaryOverlay();
  const line = 1 / state.zoom;
  const activeOrigin = activeSection() ? sectionOrigin(activeSection().gridX, activeSection().gridY) : { x: 0, y: 0 };
  for (const selected of selectedObjects()) {
    const bounds = objectBounds(selected);
    context.save();
    context.strokeStyle = "#ffcc55";
    context.lineWidth = 2 * line;
    context.strokeRect(activeOrigin.x + bounds.x, activeOrigin.y + bounds.y, bounds.width, bounds.height);
    const rect = collisionRect(selected);
    if (rect) {
      context.strokeStyle = "#59d8ff";
      context.setLineDash([3 * line, 2 * line]);
      context.lineWidth = line;
      context.strokeRect(activeOrigin.x + rect.x, activeOrigin.y + rect.y, rect.width, rect.height);
    }
    context.setLineDash([]);
    context.fillStyle = "#ffcc55";
    context.fillRect(activeOrigin.x + selected.transform.x - 2 * line, activeOrigin.y + selected.transform.y - 2 * line, 4 * line, 4 * line);
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
    const bounds = drawAsset(context, state.artwork, preview.assetId, {
      x: activeOrigin.x + preview.transform.x, y: activeOrigin.y + preview.transform.y
    }, { alpha: 0.65 });
    context.save();
    context.strokeStyle = preview.problem ? "#ff6670" : "#7dffa8";
    context.lineWidth = 2 * line;
    context.setLineDash([4 * line, 3 * line]);
    context.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
    context.restore();
  }
  canvas.dataset.paintFootprint = "";
  canvas.dataset.paintPlacements = "";
  if (state.tool === "paint" && state.paintCursor && !state.paletteDrag &&
      (!state.pointerMode || state.pointerMode === "brush") &&
      isPaintBrushAsset(ASSET_CATALOG[state.placeAssetId])) {
    const footprint = terrainBrushFootprint(state.paintCursor,
      state.pointerStart?.stroke?.brushSize ?? state.paintBrushSize);
    let problem = state.pointerStart?.stroke?.error;
    let plan = null;
    try {
      const gesture = state.pointerStart?.mode === "brush" ? state.pointerStart : paintGesture(state.paintCursor);
      if (problem) throw new Error(problem);
      plan = paintPlan(gesture);
    } catch (error) { problem = error.message; }
    context.save();
    context.fillStyle = problem ? "#ff667030" : "#7dffa824";
    context.strokeStyle = problem ? "#ff6670" : "#7dffa8";
    context.lineWidth = line;
    context.fillRect(footprint.x, footprint.y, footprint.width, footprint.height);
    for (let y = footprint.y; y < footprint.y + footprint.height; y += CELL) {
      for (let x = footprint.x; x < footprint.x + footprint.width; x += CELL) {
        context.strokeRect(x, y, CELL, CELL);
      }
    }
    context.lineWidth = 2 * line;
    context.strokeRect(footprint.x, footprint.y, footprint.width, footprint.height);
    context.restore();
    for (const placement of plan?.placements ?? []) {
      const definition = ASSET_CATALOG[placement.assetId];
      drawAsset(context, state.artwork, placement.assetId, {
        x: placement.x + definition.pivot.x, y: placement.y + definition.pivot.y
      }, { alpha: 0.65 });
      context.save();
      context.strokeStyle = "#66ccff";
      context.lineWidth = line;
      context.strokeRect(placement.x, placement.y, placement.width, placement.height);
      context.restore();
    }
    canvas.dataset.paintFootprint = JSON.stringify({ ...footprint, problem: problem ?? null });
    canvas.dataset.paintPlacements = JSON.stringify(plan?.placements ?? []);
  }
  const rectangle = state.pointerStart?.mode === "fill" ? state.pointerStart.rectangle : state.fillPreview?.rectangle;
  if (rectangle) {
    context.save();
    const invalid = state.pointerStart?.error ?? state.fillPreview?.error;
    context.fillStyle = invalid ? "#ff667060" : "#66ccff50";
    context.strokeStyle = invalid ? "#ff6670" : "#66ccff";
    context.lineWidth = 2 * line;
    context.fillRect(rectangle.x, rectangle.y, rectangle.width, rectangle.height);
    context.strokeRect(rectangle.x, rectangle.y, rectangle.width, rectangle.height);
    for (const placement of state.fillPreview?.plan?.placements ?? []) {
      context.strokeStyle = placement.border ? "#ffcc55" : "#66ccff";
      context.strokeRect(placement.x, placement.y, placement.width, placement.height);
    }
    context.restore();
  }
  const counts = layerCounts();
  canvas.dataset.cameraX = String(state.cameraX);
  canvas.dataset.cameraY = String(state.cameraY);
  canvas.dataset.zoom = String(state.zoom);
  const allObjects = sections.flatMap(section => section.document.objects);
  canvas.dataset.objectCount = String(allObjects.length);
  canvas.dataset.wallCount = String(allObjects.filter(object => object.type === "wall").length);
  canvas.dataset.layerCounts = JSON.stringify(counts);
  canvas.dataset.selectedId = state.selectedId ?? "";
  canvas.dataset.selectedIds = JSON.stringify([...state.selectedIds]);
  canvas.dataset.selectedIdentity = state.selectedId && activeSection()
    ? `${activeSection().sectionId}/${state.selectedId}` : "";
  canvas.dataset.selectionCount = String(state.selectedIds.size);
  canvas.dataset.tool = state.tool;
  canvas.dataset.preview = preview ? `${preview.assetId}@${preview.transform.x},${preview.transform.y}${preview.problem ? ":invalid" : ""}` : "";
}

function render() {
  const observingFill = state.tool === "fill" || fillDiagnostics.applying;
  if (!state.artwork || !state.document || isPlaying()) {
    if (observingFill) {
      fillDiagnostics.lastRedraw = { result: "skipped", artwork: Boolean(state.artwork),
        document: Boolean(state.document), play: state.play.phase };
      updateFillDiagnostics();
    }
    return;
  }
  try {
    drawMap();
    if (observingFill) {
      fillDiagnostics.lastRedraw = { result: "completed", n: ++fillDiagnostics.redraws,
        at: new Date().toISOString(), sceneBuilds: fillDiagnostics.sceneBuilds,
        documents: fillDiagnosticDocuments(), canvasCounts: canvas.dataset.layerCounts,
        camera: [state.cameraX, state.cameraY, state.zoom], viewport: [canvas.width, canvas.height] };
      updateFillDiagnostics();
    }
  } catch (error) {
    if (observingFill) {
      fillDiagnostics.lastRedraw = { result: "failed", error: error.message };
      traceFill("redraw-error", { error: error.message });
    }
    throw error;
  }
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
  const bounds = levelBounds();
  state.cameraX = bounds.x + (bounds.width - state.viewportWidth / state.zoom) / 2;
  state.cameraY = bounds.y + (bounds.height - state.viewportHeight / state.zoom) / 2;
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

function simplifyBoundaryPoints(points) {
  const result = [];
  for (const point of points) {
    if (result.length && result.at(-1)[0] === point[0] && result.at(-1)[1] === point[1]) continue;
    while (result.length >= 2) {
      const a = result.at(-2);
      const b = result.at(-1);
      const cross = (BigInt(b[0]) - BigInt(a[0])) * (BigInt(point[1]) - BigInt(b[1])) -
        (BigInt(b[1]) - BigInt(a[1])) * (BigInt(point[0]) - BigInt(b[0]));
      if (cross !== 0n) break;
      result.pop();
    }
    result.push(point);
  }
  if (result.length > 1 && result[0][0] === result.at(-1)[0] && result[0][1] === result.at(-1)[1]) result.pop();
  return result;
}

function boundaryPreviewFromGesture(gesture) {
  const sections = boundarySections();
  try {
    const result = gesture.mode === "boundary-grid"
      ? createGridRectangleBoundary(gesture.start, gesture.current, sections)
      : createPolygonBoundary(simplifyBoundaryPoints(gesture.points), sections);
    state.boundaryDraft = { ...result, type: gesture.mode, points: gesture.points,
      before: state.sections.map(({ sectionId, document }) => ({ sectionId, document })) };
  } catch (error) {
    state.boundaryDraft = { boundary: null, cells: new Set(), type: gesture.mode,
      points: gesture.points ?? null, error: error.message };
  }
  refreshChrome({ structure: false });
  render();
}

function applyBoundary() {
  const draft = state.boundaryDraft;
  if (!draft || isPlaying() || state.saving) return;
  try {
    if (draft.error || !draft.boundary) throw new Error(draft.error ?? "Draw a valid playable boundary before applying.");
    if (draft.before && (draft.before.length !== state.sections.length ||
        draft.before.some(saved => state.sections.find(section => section.sectionId === saved.sectionId)?.document !== saved.document))) {
      throw new Error("The level changed after this gesture began. Cancel and preview again.");
    }
    const root = rootSection();
    if (!root) throw new Error("The level boundary owner is missing from its section set.");
    validatePlayableBoundaryForSections(draft.boundary, boundarySections());
    const next = validateFloorDocument({ ...root.document, playableBoundary: draft.boundary });
    const changed = JSON.stringify(root.document.playableBoundary ?? null) !== JSON.stringify(next.playableBoundary);
    commitToolPreview(changed ? [{ sectionId: root.sectionId, document: next }] : [],
      allSections().map(({ sectionId, document }) => ({ sectionId, document })));
    setStatus(changed ? "Playable boundary applied as one undoable edit. Save the level to persist it."
      : "Playable boundary unchanged; no history entry was added.");
  } catch (error) {
    draft.error = error.message;
    setStatus(`Playable boundary rejected: ${error.message}. No changes were applied.`, true);
    refreshAfterOperation();
  }
}

function resetBoundary() {
  if (state.boundaryDraft || isPlaying() || state.saving) return;
  const root = rootSection();
  if (!root?.document.playableBoundary) {
    setStatus("The default section boundary is already active.");
    return;
  }
  const { playableBoundary: _removed, ...document } = root.document;
  const next = validateFloorDocument(document);
  pushSectionUndo(allSections().map(section => ({ sectionId: section.sectionId, document: section.document })));
  root.document = next;
  state.document = activeSection()?.document ?? state.document;
  state.boundaryDraft = null;
  state.scene.document = null;
  refreshChrome();
  setStatus("Reset to the union of existing sections as one undoable edit. Save the level to persist it.");
}

function cancelBoundaryPreview() {
  state.boundaryDraft = null;
  if (["boundary-grid", "boundary-polygon"].includes(state.pointerMode)) {
    state.pointerMode = null;
    state.pointerStart = null;
  }
  refreshChrome();
  render();
  setStatus("Playable boundary preview cancelled; no changes were made.");
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

function previewAtWorld(assetId, point) {
  const local = worldToSection(point.x, point.y);
  const section = state.sections.find(item => item.gridX === local.gridX && item.gridY === local.gridY);
  if (!section) return null;
  activateSection(section);
  return previewAt(assetId, { x: local.x, y: local.y });
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
  if (state.tool === "fill") traceFill("asset-request", { requested: assetId });
  if (state.fillPreview || state.boundaryDraft || state.pointerMode) {
    setStatus("Finish or cancel the current edit before changing assets.", true);
    return;
  }
  state.placeAssetId = assetId;
  state.paintCursor = null;
  if (state.tool !== "fill") state.tool = "paint";
  state.preview = null;
  const asset = ASSET_CATALOG[assetId];
  setStatus(`${state.tool === "fill" ? "Rectangle Fill" : "Paint"}: ${asset.label} (Esc to select).` +
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
  const objects = state.sections.flatMap(section => section.document.objects)
    .filter(object => object.type === category.type);
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
  const before = state.sections.map(section => ({ sectionId: section.sectionId, document: section.document }));
  const objects = state.sections.flatMap(section => section.document.objects);
  const removed = objects.filter(object => types.has(object.type) && !state.layers[object.layer].locked);
  const skipped = objects.filter(object => types.has(object.type) && state.layers[object.layer].locked).length;
  if (!removed.length) {
    $("#clear-contents-dialog").close();
    setStatus(`Nothing was removed; ${skipped} selected-category object${skipped === 1 ? " is" : "s are"} on locked layers.`);
    return;
  }
  try {
    const removedCurrentIds = new Set(activeSection().document.objects
      .filter(object => types.has(object.type) && !state.layers[object.layer].locked).map(object => object.id));
    const updates = state.sections.map(section => ({
      section,
      document: validateFloorDocument({ ...section.document,
        objects: section.document.objects.filter(object => !types.has(object.type) ||
          state.layers[object.layer].locked) })
    }));
    pushSectionUndo(before);
    for (const update of updates) update.section.document = update.document;
    state.document = activeSection().document;
    setSelection([...state.selectedIds].filter(id => !removedCurrentIds.has(id)));
    $("#clear-contents-dialog").close();
    refreshChrome();
    setStatus(`Cleared ${removed.length} object${removed.length === 1 ? "" : "s"} in one undoable edit; ` +
      `${skipped} locked object${skipped === 1 ? " was" : "s were"} skipped. Undo with Ctrl+Z.`);
  } catch (error) {
    setStatus(`Clear rejected: ${error.message}. No objects were removed.`, true);
  }
}

function pointerDown(event) {
  if (state.tool === "fill") traceFillPointer(event, "canvas");
  if (isPlaying() || !state.document || state.fillPreview || state.boundaryDraft) return;
  canvas.focus();
  if (event.button === 1 || (event.button === 0 && state.spaceDown)) {
    state.paintCursor = null;
    state.pointerMode = "pan";
    state.pointerStart = { x: event.clientX, y: event.clientY, cameraX: state.cameraX, cameraY: state.cameraY };
    canvas.classList.add("panning");
    canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
    return;
  }
  if (event.button !== 0) return;
  const worldPoint = worldPointFromClient(event.clientX, event.clientY);
  if (state.tool === "boundary") {
    if (state.boundaryMode === "polygon") {
      const point = [Math.round(worldPoint.x / CELL), Math.round(worldPoint.y / CELL)];
      state.pointerMode = "boundary-polygon";
      state.pointerStart = { mode: "boundary-polygon", points: [point], tooComplex: false };
    } else {
      const cell = { x: Math.floor(worldPoint.x / CELL), y: Math.floor(worldPoint.y / CELL) };
      state.pointerMode = "boundary-grid";
      state.pointerStart = { mode: "boundary-grid", start: cell, current: cell };
    }
    state.boundaryDraft = null;
    canvas.setPointerCapture(event.pointerId);
    render();
    event.preventDefault();
    return;
  }
  let local;
  try { local = worldToSection(worldPoint.x, worldPoint.y); }
  catch (error) { setStatus(error.message, true); return; }
  const section = state.sections.find(item => item.gridX === local.gridX && item.gridY === local.gridY);
  if (!section) {
    setStatus(`No section exists at (${local.gridX}, ${local.gridY}); add it with Add Section.`, true);
    return;
  }
  activateSection(section);
  const point = { x: local.x, y: local.y };
  if (state.tool === "fill" || (state.tool === "paint" && isPaintBrushAsset(ASSET_CATALOG[state.placeAssetId]))) {
    const asset = ASSET_CATALOG[state.placeAssetId];
    if (state.tool === "fill" ? !isRepeatableAsset(asset) : !isPaintBrushAsset(asset)) {
      setStatus(state.tool === "fill"
        ? !asset ? "Choose a fill asset from the palette"
          : "Choose static terrain, a wall or a prop; spawns and unique gameplay objects cannot repeat."
        : "Choose a compatible 32 x 32 terrain tile in the palette first.", true);
      return;
    }
    if (state.tool === "paint") {
      state.paintCursor = worldPoint;
      state.pointerMode = "brush";
      state.preview = null;
      state.pointerStart = paintGesture(worldPoint);
      refreshChrome({ structure: false });
    } else {
      state.pointerMode = "fill";
      state.pointerStart = { mode: "fill", assetId: state.placeAssetId, start: worldPoint,
        before: state.sections.map(item => ({ sectionId: item.sectionId, document: item.document })) };
      try { state.pointerStart.rectangle = currentFillRectangle(state.pointerStart, worldPoint); }
      catch (error) { state.pointerStart.error = error.message; }
    }
    canvas.setPointerCapture(event.pointerId);
    render();
    event.preventDefault();
    return;
  }
  if (state.tool === "paint") {
    if (!state.placeAssetId) {
      setStatus("Choose an asset in the palette before painting.", true);
      return;
    }
    placeFromPreview(previewAt(state.placeAssetId, point));
    state.preview = previewAt(state.placeAssetId, point);
    render();
    return;
  }
  const object = hitTest(state.document, point, isSelectable);
  if (state.model === ASTRAEUM_MODEL && state.layers.terrain.visible && state.layers.walls.visible &&
      !["item", "spawn", "collision"].includes(object?.type)) {
    const start = state.document.objects.find(object => object.assetId === "spawn-aries")?.transform;
    const { door } = towerRender.fixedDecorations(state.artwork, floorDocumentGrid(state.document), start);
    const bounds = door && towerRender.doorBounds(state.artwork, door);
    if (bounds && point.x >= bounds.x && point.x < bounds.x + bounds.width &&
        point.y >= bounds.y && point.y < bounds.y + bounds.height) {
      setSelection([]);
      state.inspectedDecoration = { sectionId: state.activeSectionId };
      refreshChrome();
      setStatus("Decorative door: generated artwork, not an authored object or level exit. Select a stairs rune for exit settings.");
      return;
    }
  }
  if (!object) {
    state.pointerMode = "marquee";
    state.pointerStart = {
      anchor: worldPoint,
      current: worldPoint,
      gridX: section.gridX,
      gridY: section.gridY,
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
  state.pointerStart = { point: worldPoint, before: state.document, id: object.id, ids: [...state.selectedIds], error: null };
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
  if (state.pointerMode === "boundary-grid") {
    state.pointerStart.current = { x: Math.floor(point.x / CELL), y: Math.floor(point.y / CELL) };
    render();
    return;
  }
  if (state.pointerMode === "boundary-polygon") {
    const gesture = state.pointerStart;
    const next = [Math.round(point.x / CELL), Math.round(point.y / CELL)];
    const points = gesture.points;
    if (!points.length || points.at(-1)[0] !== next[0] || points.at(-1)[1] !== next[1]) {
      while (points.length >= 2) {
        const a = points.at(-2);
        const b = points.at(-1);
        const cross = (BigInt(b[0]) - BigInt(a[0])) * (BigInt(next[1]) - BigInt(b[1])) -
          (BigInt(b[1]) - BigInt(a[1])) * (BigInt(next[0]) - BigInt(b[0]));
        if (cross !== 0n) break;
        points.pop();
      }
      if (points.length < 513) points.push(next);
      else gesture.tooComplex = true;
    }
    render();
    return;
  }
  if (state.pointerMode === "brush") {
    state.paintCursor = point;
    for (const sample of event.getCoalescedEvents?.() ?? []) {
      extendTerrainStroke(state.pointerStart.stroke, worldPointFromClient(sample.clientX, sample.clientY));
    }
    extendTerrainStroke(state.pointerStart.stroke, point);
    render();
    return;
  }
  if (state.pointerMode === "fill") {
    try { state.pointerStart.rectangle = currentFillRectangle(state.pointerStart, point); state.pointerStart.error = null; }
    catch (error) { state.pointerStart.rectangle = null; state.pointerStart.error = error.message; }
    render();
    return;
  }
  if (state.pointerMode === "move") {
    const start = state.pointerStart;
    const position = worldToSection(point.x, point.y);
    if (position.gridX !== activeSection().gridX || position.gridY !== activeSection().gridY) {
      start.error = "Move rejected: objects must remain inside their owning section; cross-section moves are not supported.";
      state.document = start.before;
      refreshChrome({ structure: false });
      return;
    }
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
    const position = worldToSection(point.x, point.y);
    if (position.gridX !== start.gridX || position.gridY !== start.gridY) {
      start.error = "Marquee selection is limited to one section.";
      render();
      return;
    }
    start.moved ||= Math.hypot(point.x - start.anchor.x, point.y - start.anchor.y) > 2 / state.zoom;
    if (start.moved) {
      const rect = {
        left: Math.min(start.anchor.x, point.x) - start.gridX * 2048,
        top: Math.min(start.anchor.y, point.y) - start.gridY * 2048,
        right: Math.max(start.anchor.x, point.x) - start.gridX * 2048,
        bottom: Math.max(start.anchor.y, point.y) - start.gridY * 2048
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
  if (state.tool === "paint" && state.placeAssetId && !isPaintBrushAsset(ASSET_CATALOG[state.placeAssetId]) && !state.paletteDrag) {
    state.preview = previewAtWorld(state.placeAssetId, point);
    render();
  } else if (state.tool === "paint" && !state.paletteDrag && isPaintBrushAsset(ASSET_CATALOG[state.placeAssetId])) {
    state.paintCursor = point;
    render();
  }
}

function pointerUp(event) {
  if (state.tool === "fill" || state.pointerMode === "fill") {
    if (event) traceFillPointer(event, "canvas");
    else traceFill("canvas:pointerup", { synthetic: true });
  }
  if (state.pointerMode === "pan") canvas.classList.remove("panning");
  if (state.pointerMode === "boundary-grid") {
    if (event) {
      const point = worldPointFromClient(event.clientX, event.clientY);
      state.pointerStart.current = { x: Math.floor(point.x / CELL), y: Math.floor(point.y / CELL) };
    }
    boundaryPreviewFromGesture(state.pointerStart);
  } else if (state.pointerMode === "boundary-polygon") {
    if (event) {
      const point = worldPointFromClient(event.clientX, event.clientY);
      const next = [Math.round(point.x / CELL), Math.round(point.y / CELL)];
      const points = state.pointerStart.points;
      if (points.at(-1)[0] !== next[0] || points.at(-1)[1] !== next[1]) points.push(next);
    }
    if (state.pointerStart.tooComplex) {
      state.boundaryDraft = { boundary: null, cells: new Set(), type: "boundary-polygon",
        points: state.pointerStart.points, error: "Polygon boundary exceeds 512 simplified points." };
      refreshChrome({ structure: false });
    } else boundaryPreviewFromGesture(state.pointerStart);
  } else if (state.pointerMode === "brush") {
    if (event) {
      state.paintCursor = worldPointFromClient(event.clientX, event.clientY);
      extendTerrainStroke(state.pointerStart.stroke, state.paintCursor);
    }
    finishTerrainStroke();
  } else if (state.pointerMode === "fill") {
    const point = event && worldPointFromClient(event.clientX, event.clientY);
    if (point) {
      state.pointerStart.end = point;
      try { state.pointerStart.rectangle = currentFillRectangle(state.pointerStart, point); state.pointerStart.error = null; }
      catch (error) { state.pointerStart.rectangle = null; state.pointerStart.error = error.message; }
    }
    state.fillPreview = state.pointerStart;
    updateFillPreview();
    if (state.fillPreview.error) setStatus(`Rectangle fill preview rejected: ${state.fillPreview.error}.`, true);
    else setStatus(fillSummary(state.fillPreview.plan));
  }
  if (state.pointerMode === "move") {
    const { before, id, error } = state.pointerStart;
    if (state.document !== before) {
      pushUndo(before);
      setStatus(`Moved ${state.selectedIds.size} selected object${state.selectedIds.size === 1 ? "" : "s"} with one shared displacement.`);
    } else if (error) {
      setStatus(error, true);
    }
  } else if (state.pointerMode === "marquee" && !state.pointerStart.error &&
      !state.pointerStart.moved && !state.pointerStart.baseSelection.length) {
    setSelection([]);
  }
  const marqueeError = state.pointerStart?.error;
  state.pointerMode = null;
  state.pointerStart = null;
  if (marqueeError) setStatus(marqueeError, true);
  refreshChrome();
  render();
}

function finishTerrainStroke() {
  const gesture = state.pointerStart;
  if (!gesture || gesture.mode !== "brush") return;
  if (gesture.stroke.error) {
    setStatus(`Paint stroke rejected: ${gesture.stroke.error}. No sections changed.`, true);
    return;
  }
  try {
    const { updates, seamSkipped } = paintPlan(gesture);
    const edgeNote = seamSkipped
      ? ` ${seamSkipped} footprint slot(s) skipped at section edges; move the brush or adjust spacing to fit them.`
      : "";
    if (!updates.length) {
      setStatus(`Paint stroke unchanged (identical cells, density or minimum spacing left no new placements).${edgeNote}`);
      return;
    }
    commitToolPreview(updates, gesture.before);
    setStatus(`Paint stroke applied to ${updates.length} section(s). Undo with Ctrl+Z. Save to persist.${edgeNote}`);
  } catch (error) {
    setStatus(`Paint stroke rejected: ${error.message}. No sections changed; adjust the settings or use a shorter stroke.`, true);
  } finally {
    state.paintSeed++;
  }
}

function paintGesture(point) {
  const gesture = { mode: "brush", assetId: state.placeAssetId,
    before: state.sections.map(({ sectionId, document }) => ({ sectionId, document })),
    density: state.paintDensity, spacing: state.paintSpacing, seed: state.paintSeed,
    stroke: { cells: new Map(), last: null, error: null, brushSize: state.paintBrushSize } };
  extendTerrainStroke(gesture.stroke, point);
  return gesture;
}

function paintPlan(gesture) {
  if (gesture.before.length !== state.sections.length ||
      gesture.before.some(saved => state.sections.find(section => section.sectionId === saved.sectionId)?.document !== saved.document)) {
    throw new Error("The level changed during this stroke; cancel and paint again.");
  }
  return planPaintStroke(state.sections, gesture.stroke.cells.values(), {
    assetId: gesture.assetId, assetCatalog: ASSET_CATALOG, layers: state.layers,
    createObject: createDesignObject, validate: validateFloorDocument,
    density: gesture.density, spacing: gesture.spacing, seed: gesture.seed
  });
}

function refreshPaintSettings(asset, busy) {
  const thumbnail = $("#paint-asset-thumbnail");
  const assetId = asset ? state.placeAssetId : "";
  if (thumbnail.dataset.assetId !== assetId) {
    thumbnail.replaceChildren(...(asset ? [assetThumbnail(assetId, 48)] : []));
    thumbnail.dataset.assetId = assetId;
  }
  thumbnail.hidden = !asset;
  $("#paint-asset-name").textContent = asset?.label ?? "Choose a Paint asset from the palette";
  const supported = isPaintBrushAsset(asset);
  $("#paint-brush-size").value = String(state.paintBrushSize);
  $("#paint-brush-size").disabled = busy || !supported;
  $("#paint-density").value = String(state.paintDensity);
  $("#paint-spacing").value = String(state.paintSpacing);
  $("#paint-density").disabled = $("#paint-spacing").disabled = busy || !supported;
  $("#paint-support").textContent = !asset ? "Choose an asset to see its Paint support."
    : supported ? `${state.paintBrushSize} x ${state.paintBrushSize} cells (${state.paintBrushSize * CELL} x ${state.paintBrushSize * CELL} world px). ` +
      `Asset footprint: ${asset.size.width} x ${asset.size.height} world px, unchanged. ` +
      "World-grid footprint anchors inside the brush repeat; large artwork may extend past its outline. " +
      "Minimum spacing skips nearby same-layer objects, including across seams. Static slots crossing section edges are omitted, never resized. " +
      "One Undo restores the stroke. Red means the whole stroke is invalid."
    : `${asset.label}: single placement only. Characters, spawns, items, unique gameplay objects and assets without a static Paint capability cannot repeat.`;
}

function pushSectionUndo(documents) {
  state.undo.push({ documents, selection: [...state.selectedIds], sectionId: state.activeSectionId });
  if (state.undo.length > HISTORY_LIMIT) state.undo.shift();
  state.redo.length = 0;
}

function commitToolPreview(updates, before) {
  const previous = {
    documents: allSections().map(({ sectionId, document }) => ({ sectionId, document })),
    undo: [...state.undo], redo: [...state.redo], tool: state.tool,
    boundaryDraft: state.boundaryDraft, fillPreview: state.fillPreview
  };
  const observingFill = fillDiagnostics.applying;
  if (observingFill) traceFill("document-before", { documents: fillDiagnosticDocuments(), updates: updates.length });
  try {
    if (updates.length) pushSectionUndo(before);
    for (const update of updates) {
      allSections().find(section => section.sectionId === update.sectionId).document = update.document;
    }
    state.document = activeSection().document;
    if (state.boundaryDraft) state.tool = "select";
    state.boundaryDraft = null;
    state.fillPreview = null;
    state.preview = null;
    if (observingFill) traceFill("document-published", { documents: fillDiagnosticDocuments(),
      changedSections: updates.map(update => update.sectionId), undo: state.undo.length });
    refreshChrome();
    if (observingFill) traceFill("commit-complete", { documents: fillDiagnosticDocuments(),
      redraw: fillDiagnostics.lastRedraw });
  } catch (error) {
    for (const saved of previous.documents) {
      const section = allSections().find(section => section.sectionId === saved.sectionId);
      section.document = saved.document;
      if (section.scene) section.scene.document = null;
    }
    state.document = activeSection().document;
    state.undo = previous.undo;
    state.redo = previous.redo;
    state.tool = previous.tool;
    state.boundaryDraft = previous.boundaryDraft;
    state.fillPreview = previous.fillPreview;
    state.scene.document = null;
    state.hierarchyKey = "";
    if (observingFill) traceFill("document-rollback", { error: error.message, documents: fillDiagnosticDocuments() });
    throw error;
  }
}

function currentFillRectangle(fill, end = fill.end ?? fill.start) {
  return fillRectangle(fill.start, end, ASSET_CATALOG[fill.assetId], Boolean(state.fillSettings.borderAssetId));
}

function fillPlan(fill) {
  if (fill.before.length !== state.sections.length ||
      fill.before.some(saved => state.sections.find(section => section.sectionId === saved.sectionId)?.document !== saved.document)) {
    throw new Error("The level changed after this gesture began. Cancel and preview again; no sections were changed.");
  }
  return planFill(state.sections, fill.rectangle, { ...state.fillSettings, assetId: fill.assetId,
    assetCatalog: ASSET_CATALOG, layers: state.layers, createObject: createDesignObject, validate: validateFloorDocument });
}

function fillSummary(plan) {
  return `${plan.count} placement target(s), including ${plan.borderCount} border, in ${plan.sectionCount} section(s). ` +
    `${plan.skipped} same-layer overlaps skipped; ${plan.overlaps - plan.skipped} allowed; ` +
    `${plan.seamSkipped} seam-straddling slots skipped. Terrain replaces cells (identical tiles stay unchanged). Apply or Cancel.`;
}

function updateFillPreview() {
  const fill = state.fillPreview;
  if (!fill) return;
  fill.plan = null;
  try {
    fill.rectangle = currentFillRectangle(fill);
    fill.plan = fillPlan(fill);
    fill.error = null;
    fillDiagnostics.validation = "preview passed";
  } catch (error) {
    fill.error = error.message;
    fillDiagnostics.validation = `preview rejected: ${error.message}`;
  }
  traceFill("preview-validation", { rectangle: fill.rectangle ?? null,
    count: fill.plan?.count ?? null, skipped: fill.plan?.skipped ?? null,
    updates: fill.plan?.updates?.length ?? null, result: fillDiagnostics.validation });
}

function refreshFillSettings(asset) {
  const assetId = asset ? state.placeAssetId : "";
  const thumbnail = $("#fill-asset-thumbnail");
  if (thumbnail.dataset.assetId !== assetId) {
    thumbnail.replaceChildren(...(asset ? [assetThumbnail(assetId, 48)] : []));
    thumbnail.dataset.assetId = assetId;
  }
  thumbnail.hidden = !asset;
  $("#fill-asset-name").textContent = asset?.label ?? "Choose a fill asset from the palette";
  const pending = state.saving || isPlaying() || Boolean(state.pointerMode);
  $("#fill-gap-x").value = state.fillSettings.gapX;
  $("#fill-gap-y").value = state.fillSettings.gapY;
  $("#fill-overlap").value = state.fillSettings.overlap;
  $("#fill-collision").checked = state.fillSettings.collision;
  $("#fill-collision-option").hidden = asset?.collision !== "optional";
  for (const id of ["fill-gap-x", "fill-gap-y", "fill-overlap"]) {
    $(`#${id}`).disabled = pending || isTerrainBrushAsset(asset);
  }
  $("#fill-collision").disabled = pending;
  $("#fill-footprint").textContent = asset ? `World footprint: ${asset.size.width} x ${asset.size.height} px. ` +
    "Artwork size is unchanged. Spacing is the gap between footprints; partial edge slots are left empty." : "";
  const choices = Object.entries(ASSET_CATALOG).filter(([, definition]) => isBorderAsset(definition));
  const borderSelect = $("#fill-border-asset");
  const key = JSON.stringify(choices.map(([id, definition]) => [id, definition.label]));
  if (borderSelect.dataset.choices !== key) {
    borderSelect.replaceChildren(...choices.map(([id, definition]) => {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = definition.label;
      return option;
    }));
    borderSelect.dataset.choices = key;
  }
  $("#fill-border").checked = Boolean(state.fillSettings.borderAssetId);
  $("#fill-border").disabled = pending || !choices.length;
  borderSelect.disabled = pending || !state.fillSettings.borderAssetId;
  if (state.fillSettings.borderAssetId) borderSelect.value = state.fillSettings.borderAssetId;
}

function applyFill() {
  traceFill("apply-handler-entry", { previewExists: Boolean(state.fillPreview) });
  const fill = state.fillPreview;
  if (!fill || isPlaying() || state.saving) {
    traceFill("apply-guard-return", { previewExists: Boolean(fill), play: state.play.phase, saving: state.saving });
    return;
  }
  fillDiagnostics.applying = true;
  fillDiagnostics.validation = "Apply pending";
  try {
    if (fill.error || !fill.rectangle) throw new Error(fill.error ?? "Drag a valid fill rectangle before applying.");
    const plan = fillPlan(fill);
    fillDiagnostics.validation = "Apply passed";
    traceFill("apply-validation", { result: fillDiagnostics.validation, rectangle: fill.rectangle,
      count: plan.count, skipped: plan.skipped, updates: plan.updates.length });
    commitToolPreview(plan.updates, fill.before);
    setStatus(plan.updates.length
      ? `Rectangle fill applied to ${plan.updates.length} section(s). Undo with Ctrl+Z.`
      : "Rectangle fill unchanged (no new placements or cell changes).");
  } catch (error) {
    const stage = fillDiagnostics.validation === "Apply passed" ? "commit/refresh" : "validation";
    fillDiagnostics.validation = `${stage} rejected: ${error.message}`;
    traceFill("apply-rejected", { stage, error: error.message });
    fill.error = error.message;
    setStatus(`Rectangle fill rejected: ${error.message}. No sections changed.`, true);
    refreshAfterOperation();
  } finally {
    fillDiagnostics.applying = false;
    updateFillDiagnostics();
  }
}

function cancelFill() {
  traceFill("cancel", { documents: fillDiagnosticDocuments() });
  state.fillPreview = null;
  state.preview = null;
  state.tool = "select";
  if (state.pointerMode === "fill") {
    state.pointerMode = null;
    state.pointerStart = null;
  }
  refreshChrome();
  setStatus("Rectangle fill cancelled; no sections changed.");
}

function cancelPointerGesture() {
  if (state.tool === "fill") traceFill("pointer-cancel", { rectangle: state.pointerStart?.rectangle ?? null });
  const mode = state.pointerStart?.mode;
  state.paintCursor = null;
  state.pointerMode = null;
  state.pointerStart = null;
  if (mode === "fill") state.fillPreview = null;
  if (mode === "boundary-grid" || mode === "boundary-polygon") state.boundaryDraft = null;
  refreshChrome();
  if (mode === "brush") setStatus("Paint stroke cancelled; no sections changed.");
  if (mode === "fill") setStatus("Rectangle fill cancelled; no sections changed.");
  if (mode === "boundary-grid" || mode === "boundary-polygon") {
    setStatus("Playable boundary drawing cancelled; no changes were made.");
  }
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
  delete $("#paint-asset-thumbnail").dataset.assetId;
  delete $("#fill-asset-thumbnail").dataset.assetId;
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
  if (state.tool === "fill") traceFillPointer(event, `palette:${assetId}`);
  if (event.button !== 0 || isPlaying() || !state.document) return;
  event.preventDefault();
  if (state.tool === "fill") {
    armPlace(assetId);
    return;
  }
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
    ? previewAtWorld(drag.assetId, worldPointFromClient(event.clientX, event.clientY))
    : null;
  render();
}

function paletteUp(event) {
  if (state.tool === "fill") traceFillPointer(event, "palette");
  const drag = state.paletteDrag;
  if (!drag) return;
  state.paletteDrag = null;
  document.body.classList.remove("dragging-asset");
  if (!drag.dragging) {
    armPlace(drag.assetId);
    return;
  }
  if (overCanvas(event.clientX, event.clientY)) {
    placeFromPreview(previewAtWorld(drag.assetId, worldPointFromClient(event.clientX, event.clientY)));
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
  if (!state.document || isPlaying() || state.saving || state.fillPreview || state.boundaryDraft || state.pointerMode) return false;
  try {
    state.saving = true;
    state.saveError = null;
    const identity = { ...state.identity };
    const sections = state.sections.map(section => ({ sectionId: section.sectionId, revision: section.revision,
      ...(section.isNew ? { mapId: section.mapId, gridX: section.gridX, gridY: section.gridY } : {}),
      document: validateFloorDocument(structuredClone(section.document)) }));
    const archivedSections = state.archivedSections.map(section => ({ sectionId: section.sectionId, revision: section.revision,
      document: validateFloorDocument(structuredClone(section.document)) }));
    refreshChrome({ structure: false });
    const initialSave = !state.persisted && sections.length === 1;
    const address = initialSave ? mapUrl(identity)
      : mapUrl(identity).replace(/\/maps\/[^/]+$/, `/levels/${encodeURIComponent(identity.mapId)}/sections`);
    const request = initialSave
      ? { projectId: identity.projectId, model: state.model, document: sections[0].document }
      : state.pendingSectionSave ?? { operationId: `save-${crypto.randomUUID()}`, revision: state.sectionRevision, sections, archivedSections };
    if (!initialSave) state.pendingSectionSave = request;
    const response = await fetch(address, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request)
    });
    let payload = await response.json();
    if (!response.ok) {
      if (response.status < 500) state.pendingSectionSave = null;
      throw new Error(`HTTP ${response.status}: ${payload.error ?? "Save request rejected."}`);
    }
    if (initialSave) {
      if (payload.projectId !== identity.projectId || payload.mapId !== identity.mapId ||
          payload.model !== state.model || payload.document?.id !== identity.mapId) {
        throw new Error("The saved map identity did not match the requested initial level.");
      }
      payload = { projectId: payload.projectId, levelMapId: payload.mapId, model: payload.model, revision: 0,
        sections: [{ ...activeSection(), revision: 0, document: payload.document }] };
    }
    if (payload.projectId !== identity.projectId || payload.levelMapId !== identity.mapId ||
        payload.model !== state.model || !Array.isArray(payload.sections) ||
        ![...payload.sections, ...(payload.archivedSections ?? [])].some(section => section.mapId === identity.mapId)) {
      throw new Error("The saved level section identities did not match the requested level.");
    }
    const saved = [...payload.sections.map(section => ({ ...section, savedArchived: false })),
      ...(payload.archivedSections ?? []).map(section => ({ ...section, savedArchived: true }))];
    const local = allSections();
    if (saved.length !== local.length || local.some(section =>
      saved.filter(item => item.sectionId === section.sectionId && item.mapId === section.mapId).length !== 1)) {
      throw new Error("The saved section membership did not match the editor. Retry the pending save.");
    }
    const submitted = initialSave ? sections : [...request.sections, ...request.archivedSections];
    for (const section of local) {
      const persisted = saved.find(item => item.sectionId === section.sectionId);
      const document = validateFloorDocument(persisted.document);
      const sent = submitted.find(item => item.sectionId === section.sectionId);
      section.revision = persisted.revision;
      section.savedArchived = persisted.savedArchived;
      section.isNew = false;
      section.savedJson = JSON.stringify(document);
      if (sent && JSON.stringify(section.document) === JSON.stringify(sent.document)) section.document = document;
    }
    state.pendingSectionSave = null;
    state.sectionRevision = payload.revision;
    state.activeSectionId = state.sections.find(section => section.sectionId === state.activeSectionId)?.sectionId ??
      state.sections[0].sectionId;
    state.document = activeSection().document;
    state.sectionBaseline = JSON.stringify(sectionDocuments());
    state.savedJson = JSON.stringify(state.document);
    updateSectionPicker();
    state.persisted = true;
    await refreshLevels();
    if (dirty()) {
      setStatus("The previous save was confirmed. Later edits remain unsaved; save again before switching.");
      return false;
    }
    setStatus("Map saved to the local Studio database.");
    return true;
  } catch (error) {
    state.saveError = `Save failed: ${error.message}${state.pendingSectionSave
      ? " Retry Save to reconcile the same operation before switching." : ""}`;
    setStatus(state.saveError, true);
    return false;
  } finally {
    state.saving = false;
    refreshAfterOperation();
  }
}

function refreshExportActions() {
  const needsSave = !state.persisted || dirty();
  $("#export-save").hidden = !needsSave;
  $("#export-save").disabled = !needsSave || state.exporting || state.saving;
  $("#export-submit").hidden = needsSave;
  $("#export-submit").disabled = needsSave || state.exporting || state.saving;
  $("#export-cancel").disabled = state.exporting;
}

function setExportSuggestions(select, values) {
  select.replaceChildren(new Option("Choose a suggestion", ""));
  for (const value of values) select.append(new Option(value, value));
}

function validateExportCredits() {
  const project = $("#export-project");
  const author = $("#export-author");
  project.setCustomValidity(project.value.trim()
    ? "" : "Project (project) is required and must be a nonblank string.");
  author.setCustomValidity(author.value.trim()
    ? "" : "Author (author) is required and must be a nonblank string.");
  return $("#export-form").reportValidity();
}

async function showExportDialog() {
  if (!state.document || state.model !== ASTRAEUM_MODEL || isPlaying() || state.saving ||
      state.exporting || state.switching || state.creating || state.levelBusy ||
      state.fillPreview || state.boundaryDraft || state.pointerMode) return;
  $("#export-project").value = "";
  $("#export-author").value = "";
  $("#export-course").value = "";
  $("#export-project-suggestion").value = "";
  $("#export-author-suggestion").value = "";
  setExportSuggestions($("#export-project-suggestion"), []);
  setExportSuggestions($("#export-author-suggestion"), []);
  $("#export-message").textContent = dirty() || !state.persisted
    ? "Unsaved changes are not included. Choose Save and export or Cancel."
    : "Confirm the public project and author credits, then export this saved snapshot.";
  $("#export-dialog").showModal();
  refreshExportActions();
  state.exporting = true;
  refreshChrome({ structure: false });
  refreshExportActions();
  try {
    const projectId = state.identity.projectId;
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/export-credits`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
    if (payload.projectId !== projectId || !payload.suggestions) {
      throw new Error("The saved project credit suggestions did not match the selected game.");
    }
    setExportSuggestions($("#export-project-suggestion"), payload.suggestions.project ?? []);
    setExportSuggestions($("#export-author-suggestion"), payload.suggestions.author ?? []);
    $("#export-message").textContent = "Choose or enter the public project and author credits you confirm.";
  } catch (error) {
    $("#export-message").textContent = `Could not load saved credit suggestions: ${error.message}`;
  } finally {
    state.exporting = false;
    refreshChrome({ structure: false });
    refreshExportActions();
  }
}

async function downloadSavedGamePackage() {
  if (!validateExportCredits()) return false;
  if (dirty() || !state.persisted) {
    $("#export-message").textContent = "Save the current edits before exporting the saved campaign snapshot.";
    refreshExportActions();
    return false;
  }
  state.exporting = true;
  refreshChrome({ structure: false });
  refreshExportActions();
  $("#export-message").textContent = "Building and validating the saved Astraeum campaign ZIP…";
  try {
    const response = await fetch(`/api/projects/${encodeURIComponent(state.identity.projectId)}/export-game`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project: $("#export-project").value,
        author: $("#export-author").value,
        course: $("#export-course").value
      })
    });
    if (!response.ok) {
      const payload = await response.json();
      throw new Error(payload.error ?? `HTTP ${response.status}`);
    }
    if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/zip")) {
      throw new Error("Studio returned an unexpected export format instead of a ZIP.");
    }
    const blob = await response.blob();
    if (!blob.size) throw new Error("Studio returned an empty game package.");
    const address = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = address;
    link.download = "astraeum-game.zip";
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(address), 0);
    $("#export-dialog").close();
    setStatus("Exported the saved Astraeum campaign ZIP.");
    return true;
  } catch (error) {
    $("#export-message").textContent = `Export failed: ${error.message}`;
    setStatus(`Game export failed: ${error.message}`, true);
    return false;
  } finally {
    state.exporting = false;
    refreshChrome({ structure: false });
    refreshExportActions();
  }
}

async function saveThenExportGame() {
  if (!validateExportCredits()) return;
  state.exporting = true;
  refreshChrome({ structure: false });
  refreshExportActions();
  $("#export-message").textContent = "Saving all active and archived section edits before export…";
  try {
    if (!(await save()) || dirty() || !state.persisted) {
      $("#export-message").textContent = `Save failed or did not confirm the entire draft. ${
        state.saveError ?? "Retry Save before exporting."
      }`;
      return;
    }
    refreshExportActions();
    await downloadSavedGamePackage();
  } finally {
    state.exporting = false;
    refreshChrome({ structure: false });
    refreshExportActions();
  }
}

function configureGameExport() {
  $("#export-game").addEventListener("click", showExportDialog);
  $("#export-project-suggestion").addEventListener("change", event => {
    if (event.target.value) $("#export-project").value = event.target.value;
  });
  $("#export-author-suggestion").addEventListener("change", event => {
    if (event.target.value) $("#export-author").value = event.target.value;
  });
  for (const id of ["export-project", "export-author"]) {
    $(`#${id}`).addEventListener("input", event => event.target.setCustomValidity(""));
  }
  $("#export-form").addEventListener("submit", event => {
    event.preventDefault();
    void downloadSavedGamePackage();
  });
  $("#export-save").addEventListener("click", () => void saveThenExportGame());
  $("#export-cancel").addEventListener("click", () => {
    if (!state.exporting) $("#export-dialog").close();
  });
  $("#export-dialog").addEventListener("cancel", event => {
    if (state.exporting) event.preventDefault();
  });
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
  Object.assign(play, { phase: "idle", game: null, mount: null, timer: null, resizeObserver: null,
    run: null, sourceLevel: null, interactionState: null });
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
    state.activeSectionId = play.view.sectionId;
    state.selectedIds = new Set(play.view.selection);
    play.view = null;
  }
}

async function transitionExit(request) {
  const play = state.play, run = play.run, source = play.game;
  if (play.phase !== "playing" || !run || request.sequence === play.exitSequence) return;
  play.exitSequence = request.sequence;
  play.phase = "transitioning";
  window.dispatchEvent(new Event("studio:tower-transition"));
  source.sendInput("aries", { type: "clear" });
  setStatus("Loading the exit destination...");
  window.dispatchEvent(new CustomEvent("studio:tower-exit-status", {
    detail: { exitId: request.exitId, message: "Loading the exit destination..." }
  }));
  let destinationGame;
  let replaced = false;
  try {
    const destination = request.destination;
    if (!destination?.levelId || !destination.sectionId || !destination.startId) {
      throw new Error("This exit has no complete destination. In its Inspector, select a destination level and player start.");
    }
    const level = await loadExitLevel(destination.levelId);
    if (play.run !== run) return;
    const preview = exitPreview(level, destination, source.snapshot.player, play.interactionState);
    destinationGame = await createLocalGame(preview.options);
    if (play.run !== run) {
      destinationGame.dispose();
      return;
    }
    // Validate the entire destination and exact arrival before retiring the source.
    play.mount.dispose();
    source.dispose();
    playHost.replaceChildren();
    play.game = destinationGame;
    play.mount = null;
    replaced = true;
    const destinationSkin = connectedSkin(preview, state.artwork, state.playerControlMode);
    play.mount = mountLocalPreview(playHost, destinationGame,
      destinationSkin, {
        onInputRejected: () => setStatus("The runtime rejected an input.", true)
      });
    const canvas = playHost.querySelector("canvas");
    if (!canvas || canvas.clientWidth < 2 || canvas.clientHeight < 2) {
      throw new Error("The destination Play view has no visible size. Enlarge the window and try Play again.");
    }
    play.exitSequence = 0;
    play.phase = "playing";
    canvas.focus({ preventScroll: true });
    setStatus(`Playing ${level.rootDocument.name}. All active sections loaded; HP and stamina preserved. Release held controls before continuing. Stop returns to the original draft.`);
  } catch (error) {
    if (play.run !== run) return;
    if (replaced) {
      teardownPlay();
      refreshChrome();
      showPlayError(`Destination could not mount: ${error.message}`);
    } else {
      destinationGame?.dispose();
      play.phase = "playing";
      window.dispatchEvent(new Event("studio:tower-transition"));
      source.sendInput("aries", { type: "clear" });
      const message = `Exit failed: ${error.message} Stop to edit its destination, or leave the rune and re-enter to retry.`;
      setStatus(message, true);
      window.dispatchEvent(new CustomEvent("studio:tower-exit-status", {
        detail: { exitId: request.exitId, message }
      }));
    }
  }
}

async function play() {
  if (isPlaying() || state.saving || state.switching || state.creating || state.levelBusy ||
      !state.document || !state.artwork) return;
  if (state.fillPreview || state.boundaryDraft || state.pointerMode) {
    setStatus("Apply or cancel the current edit before Play.", true);
    return;
  }
  $("#play-error").hidden = true;
  let design;
  let connected;
  const interactionState = state.model === ASTRAEUM_MODEL ? createTowerInteractionState() : null;
  try {
    if (usesConnectedPreview()) {
      connected = createConnectedPreview(state.sections.map(section => ({
        ...section, document: section.sectionId === state.activeSectionId ? state.document : section.document
      })), { mapId: state.identity.mapId, model: state.model, assetCatalog: ASSET_CATALOG,
        rootDocument: rootSection()?.document, interactionState });
    } else {
      design = validateFloorDocument(structuredClone(state.document));
      const problems = playStartProblems(design);
      if (problems.length) throw new Error(problems.join(" "));
    }
  } catch (error) {
    showPlayError(error.message);
    return;
  }
  const play = state.play;
  try {
    play.phase = "starting";
    play.run = {};
    play.interactionState = interactionState;
    play.exitSequence = 0;
    play.sourceLevel = structuredClone({
      mapId: state.identity.mapId,
      revision: state.persisted ? state.sectionRevision : null,
      persisted: state.persisted, dirty: dirty(),
      sections: state.sections.map(({ sectionId, mapId, gridX, gridY, revision, document }) =>
        ({ sectionId, mapId, gridX, gridY, revision, document })),
      rootDocument: rootSection()?.document
    });
    play.view = { zoom: state.zoom, cameraX: state.cameraX, cameraY: state.cameraY,
      sectionId: state.activeSectionId, selection: [...state.selectedIds] };
    studio.dataset.playState = "starting";
    $("#play-loading").hidden = false;
    setStatus("Starting Play with the edited map…");
    refreshChrome({ structure: false });
    // The runtime measures its world slot when mounting, so the host must be
    // visible and laid out first; mounting into a hidden host gave a 1×1 canvas.
    document.body.classList.add("is-playing");
    editorView.hidden = true;
    playHost.hidden = false;
    $("#play").hidden = true;
    $("#stop").hidden = false;
    await nextFrame();
    await nextFrame();
    play.game = await createLocalGame(connected ? connected.options
      : state.model === generic.MODEL ? genericPreview(design, ASSET_CATALOG, state.artwork) : {
      moduleFactory: createTowerGameModule(design, ASSET_CATALOG, {
        mapId: state.identity.mapId,
        interactionState
      }),
      settings: towerSettings,
      map: createFloorMap(design),
      seed: 1,
      roster: [{ accountId: "aries", username: "Aries", joinedOrder: 0 }],
      viewer: { accountId: "aries", role: "player" }
    });
    if (play.phase !== "starting") throw new Error("Play was cancelled.");
    const playSkin = connected ? connectedSkin(connected, state.artwork, state.playerControlMode)
      : state.model === generic.MODEL ? genericSkin(design, ASSET_CATALOG, state.artwork)
      : towerSkinFactory(state.artwork, undefined, design, ASSET_CATALOG, state.playerControlMode);
    play.mount = mountLocalPreview(playHost, play.game, playSkin, {
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
      if (play.phase !== "playing") return;
      try {
        play.game.step();
        const request = play.game.snapshot.exitRequest;
        if (request) void transitionExit(request);
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
    const playControls = connected
      ? state.model === ASTRAEUM_MODEL
        ? "All level sections loaded. Defeat all slimes, then enter an authored stairs rune to continue automatically. Doors are decorative."
        : "All level sections loaded. Arrows/WASD move; movement, camera and collision only."
      : state.model === generic.MODEL
      ? "Arrows/WASD move the player."
      : "See the displayed controls for the selected mode.";
    setStatus(`Playing the edited map (unsaved edits included). ${playControls} Stop returns to editing.`);
  } catch (error) {
    teardownPlay();
    refreshAfterOperation();
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
  "KeyW", "KeyA", "KeyS", "KeyD", "KeyL", "KeyH", "Space"
]);

function configureEvents() {
  $("#section-add").addEventListener("click", () => {
    closeSectionRemoval();
    state.sectionPlacementDirection = null;
    $("#section-placement").hidden = false;
    updateSectionPicker();
    [...$("#section-placement").querySelectorAll("[data-direction]")].find(button => !button.disabled)?.focus();
  });
  $("#section-cancel").addEventListener("click", () => {
    state.sectionPlacementDirection = null;
    $("#section-placement").hidden = true;
    $("#section-add").focus();
  });
  $("#section-confirm").addEventListener("click", () => addSection(state.sectionPlacementDirection));
  $("#section-remove").addEventListener("click", showSectionRemoval);
  $("#section-remove-cancel").addEventListener("click", () => {
    closeSectionRemoval();
    $("#section-remove").focus();
  });
  $("#section-remove-confirm").addEventListener("click", removeSection);
  $("#section-select").addEventListener("change", event => {
    activateSection(state.sections.find(section => section.sectionId === event.target.value));
  });
  for (const button of $("#section-placement").querySelectorAll("[data-direction]")) {
    button.addEventListener("click", () => {
      state.sectionPlacementDirection = button.dataset.direction;
      updateSectionPicker();
    });
  }
  $("#editor-tool").addEventListener("change", event => setTool(event.target.value));
  $("#paint-brush-size").addEventListener("change", event => {
    if (state.pointerMode) {
      setStatus("Finish or cancel the current stroke before changing brush size.", true);
      refreshChrome({ structure: false });
      return;
    }
    const size = Number(event.target.value);
    if (![1, 2, 4, 8].includes(size)) {
      setStatus("Brush size must be 1, 2, 4 or 8 cells.", true);
      refreshChrome({ structure: false });
      return;
    }
    state.paintBrushSize = size;
    refreshChrome({ structure: false });
  });
  for (const [id, key, min, max] of [
    ["paint-density", "paintDensity", 1, 100], ["paint-spacing", "paintSpacing", 0, 2048]
  ]) {
    $(`#${id}`).addEventListener("change", event => {
      const value = Number(event.target.value);
      if (state.pointerMode) setStatus("Finish or cancel the current stroke before changing Paint settings.", true);
      else if (event.target.value === "" || !Number.isInteger(value) || value < min || value > max) {
        setStatus(`${id === "paint-density" ? "Density (%)" : "Minimum spacing (world px)"} must be a whole number from ${min} to ${max}.`, true);
      } else state[key] = value;
      refreshChrome({ structure: false });
    });
  }
  $("#fill-apply").addEventListener("click", applyFill);
  $("#fill-cancel").addEventListener("click", cancelFill);
  $("#fill-diagnostic-copy").addEventListener("click", copyFillDiagnostics);
  $("#fill-actions").addEventListener("pointerdown", event => traceFillPointer(event, "fill-actions"), true);
  $("#fill-actions").addEventListener("click", event => traceFill("fill-actions:click", { target: event.target.id }), true);
  for (const type of ["error", "unhandledrejection"]) {
    window.addEventListener(type, event => {
      if (state.tool === "fill" || fillDiagnostics.applying) {
        traceFill(type, { message: String(event.message ?? event.reason?.message ?? event.reason) });
      }
    });
  }
  $("#boundary-mode").addEventListener("change", event => {
    state.boundaryMode = event.target.value === "polygon" ? "polygon" : "grid";
    refreshChrome({ structure: false });
  });
  $("#boundary-apply").addEventListener("click", applyBoundary);
  $("#boundary-reset").addEventListener("click", resetBoundary);
  $("#boundary-cancel").addEventListener("click", cancelBoundaryPreview);
  for (const id of ["fill-gap-x", "fill-gap-y", "fill-overlap", "fill-border", "fill-border-asset", "fill-collision"]) {
    $(`#${id}`).addEventListener("change", () => {
      state.fillSettings = {
        gapX: $("#fill-gap-x").valueAsNumber, gapY: $("#fill-gap-y").valueAsNumber,
        overlap: $("#fill-overlap").value,
        borderAssetId: $("#fill-border").checked ? $("#fill-border-asset").value : null,
        collision: $("#fill-collision").checked
      };
      updateFillPreview();
      refreshChrome({ structure: false });
    });
  }
  new ResizeObserver(resize).observe(editorView);
  canvas.addEventListener("pointerdown", pointerDown);
  canvas.addEventListener("pointermove", pointerMove);
  canvas.addEventListener("pointerup", pointerUp);
  canvas.addEventListener("pointercancel", cancelPointerGesture);
  canvas.addEventListener("pointerleave", () => {
    if (state.paintCursor) {
      state.paintCursor = null;
      render();
    }
    if (state.tool === "paint" && !state.paletteDrag && state.preview) {
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
    if ((state.fillPreview || state.boundaryDraft ||
        ["brush", "fill", "boundary-grid", "boundary-polygon"].includes(state.pointerMode)) &&
        event.code !== "Escape") {
      if (event.code === "Tab" || (event.target instanceof Element && event.target.closest("#tool-settings") &&
          event.target.closest("button") && ["Enter", "Space"].includes(event.code))) return;
      event.preventDefault();
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
      if (state.boundaryDraft || ["boundary-grid", "boundary-polygon"].includes(state.pointerMode)) {
        cancelBoundaryPreview();
        return;
      }
      if (state.pointerMode === "brush" || state.pointerMode === "fill") {
        cancelPointerGesture();
        return;
      }
      if (state.fillPreview) {
        cancelFill();
        return;
      }
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
    if (!state.document || isPlaying() || state.fillPreview || state.boundaryDraft || state.pointerMode) return;
    const cameraZoom = Number(event.target.value);
    if (cameraZoom === state.document.cameraZoom) return;
    commitDocument(validateFloorDocument({ ...state.document, cameraZoom }));
    setStatus(`Gameplay camera zoom set to ${cameraZoom.toFixed(1)}×. Save the level to keep this setting.`);
  });
  $("#open-game").addEventListener("click", showOpenDialog);
  configureNewGame();
  configureLevels();
  configureAssetImport();
  configureGameExport();
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
  $("#chest-tier").addEventListener("change", event => {
    const object = selectedObject();
    if (object?.assetId !== "item-chest" || isPlaying()) return;
    try {
      commitDocument(replaceObject(state.document, object.id, {
        interaction: { tier: event.target.value }
      }));
      setStatus("Updated chest loot tier in the draft. Save explicitly to persist it.");
    } catch (error) {
      setStatus(`Chest loot tier update failed: ${error.message}`, true);
      refreshAfterOperation();
    }
  });
  for (const id of ["exit-level", "exit-start"]) {
    $(`#${id}`).addEventListener("change", event => {
      const object = selectedObject();
      if (object?.assetId !== "prop-stairs-rune" || isPlaying()) return;
      try {
        const [sectionId, startId] = id === "exit-start" && event.target.value
          ? JSON.parse(event.target.value) : [null, null];
        const exit = id === "exit-level"
          ? { levelId: event.target.value || null, sectionId: null, startId: null }
          : { levelId: object.exit?.levelId ?? null, sectionId, startId };
        commitDocument(replaceObject(state.document, object.id, { exit }));
        setStatus("Exit destination updated in the draft. Save explicitly to persist it.");
      } catch (error) {
        exitInspectorSelection = null;
        setStatus(`Exit destination update failed: ${error.message}`, true);
        refreshAfterOperation();
      }
    });
  }
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
  openMessage("Loading saved games…");
  $("#open-dialog").showModal();
  try {
    const response = await fetch("/api/projects");
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? `Listing failed (${response.status}).`);
    if (!$("#open-dialog").open || requestId !== state.openRequest) return;
    const projects = new Map();
    for (const entry of payload.maps) {
      if (!projects.has(entry.projectId)) {
        projects.set(entry.projectId, { projectId: entry.projectId, project: entry.project, levels: [] });
      }
      projects.get(entry.projectId).levels.push(entry);
    }
    for (const project of projects.values()) {
      const { projectId, levels } = project;
      const starting = levels.find(level => level.starting);
      const activeLevelCount = levels.length;
      const disabledReason = !starting ? "No active starting level is designated."
        : !starting.supported && !starting.canAdopt ? `Unsupported starting level: ${starting.reason}`
          : null;
      const supported = starting?.supported === true;
      const canAdopt = starting?.canAdopt === true;
      const label = document.createElement("label");
      label.className = `open-entry${supported || canAdopt ? "" : " unsupported"}`;
      label.dataset.projectId = projectId;
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "open-project";
      radio.disabled = !supported && !canAdopt;
      const text = document.createElement("span");
      const title = document.createElement("strong");
      title.textContent = project.project?.name ?? projectId;
      const details = document.createElement("small");
      const count = `${activeLevelCount} active ${activeLevelCount === 1 ? "level" : "levels"}`;
      const author = project.project?.author ? ` · ${project.project.author}` : "";
      details.textContent = supported
        ? `${count} · ${starting.model === generic.MODEL ? "Generic Grid v1" : "Astraeum Floor model"}${author}`
        : canAdopt
          ? `${count} · Untyped compatible starting level — explicit Astraeum assignment required${author}`
          : `${count} · ${disabledReason}`;
      text.append(title, details);
      label.append(radio, text);
      radio.addEventListener("change", () => {
        state.openSelection = { projectId, mapId: starting.mapId, canAdopt };
        $("#open-selected").disabled = false;
        openMessage("");
      });
      $("#open-list").append(label);
    }
    openMessage(projects.size ? "Select a supported saved game." : "No saved games yet.");
  } catch (error) {
    if ($("#open-dialog").open && requestId === state.openRequest) {
      openMessage(`Could not list saved games: ${error.message}`, true);
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
      $("#level-menu").open = false;
      state.levelAction = action;
      const deleting = action === "delete";
      $("#level-title").textContent = { add: "Add Level", duplicate: "Duplicate level", rename: "Rename level", delete: "Delete level?" }[action];
      $("#level-description").textContent = deleting
        ? "The saved design stays in SQLite and can be recovered from Deleted levels."
        : action === "add" ? "Creates a separate level in this game with one empty 2048 x 2048 section. No terrain, walls, props, enemies, items, exits or starts are generated or copied. The starting level is unchanged."
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
  $("#level-start").addEventListener("click", () => {
    $("#level-menu").open = false;
    runLevelAction("start");
  });
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
      const { payload, document: design, assets, sectionData } = await fetchDesign(identity);
      applyDesign(identity, payload, design, assets, sectionData);
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
    applyDesign({ projectId: payload.projectId, mapId: payload.mapId }, payload, design, assets, {
      revision: 0, sections: [{ sectionId: `section-${payload.mapId}`, mapId: payload.mapId,
        gridX: 0, gridY: 0, revision: 0, document: design }]
    });
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
  const document = model.validateFloorDocument(payload.document ?? createFloorDocument(), assets.catalog);
  let sectionData;
  if (payload.document) {
    const response = await fetch(`/api/projects/${encodeURIComponent(identity.projectId)}/levels/${encodeURIComponent(identity.mapId)}/sections`);
    const result = await response.json();
    if (response.ok) {
      if (result.projectId !== identity.projectId || result.levelMapId !== identity.mapId ||
          result.model !== modelId || !Array.isArray(result.sections) || !result.sections.length) {
        throw new Error("The loaded level section set did not match the requested project, level, or model.");
      }
      const positions = new Set();
      const ids = new Set();
      for (const section of [...result.sections, ...(result.archivedSections ?? [])]) {
        const key = `${section.gridX},${section.gridY}`;
        if ((result.sections.includes(section) && positions.has(key)) ||
            ids.has(section.sectionId) || section.document?.id !== section.mapId) {
          throw new Error("The loaded level contains duplicate section identities or positions.");
        }
        if (result.sections.includes(section)) positions.add(key);
        ids.add(section.sectionId);
      }
      if (![...result.sections, ...(result.archivedSections ?? [])].some(section => section.mapId === identity.mapId)) {
        throw new Error("The loaded level section set does not include its original map.");
      }
      sectionData = result;
    }
    else if (response.status !== 404) throw new Error(result.error ?? `Level sections failed (${response.status}).`);
  }
  sectionData ??= { revision: 0, sections: [{
    sectionId: `section-${identity.mapId}`, mapId: identity.mapId, gridX: 0, gridY: 0, revision: 0, document
  }] };
  sectionData.sections = sectionData.sections.map(section => ({
    ...section, document: model.validateFloorDocument(section.document, assets.catalog),
    savedJson: JSON.stringify(model.validateFloorDocument(section.document, assets.catalog)), savedArchived: false
  }));
  sectionData.archivedSections = (sectionData.archivedSections ?? []).map(section => ({
    ...section, document: model.validateFloorDocument(section.document, assets.catalog),
    savedJson: JSON.stringify(model.validateFloorDocument(section.document, assets.catalog)), savedArchived: true
  }));
  const root = [...sectionData.sections, ...sectionData.archivedSections].find(section => section.mapId === identity.mapId);
  if (!root) throw new Error("The level boundary owner is missing from its section set.");
  if (root.document.playableBoundary) {
    validatePlayableBoundaryForSections(root.document.playableBoundary, sectionData.sections);
  }
  return { payload, assets, document, sectionData };
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

function applyDesign(identity, payload, design, assets, sectionData) {
  const previous = { ...state, scene: { ...state.scene } };
  try {
    installDesign(identity, payload, design, assets, sectionData);
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

function updateSectionPicker(disabled = false) {
  const select = $("#section-select");
  const keys = state.sections.map(section => section.sectionId).join("|");
  if (select.dataset.sections !== keys) {
    select.replaceChildren(...state.sections.map((section, index) =>
      new Option(`Section ${index + 1}${section.mapId === state.identity.mapId ? " (original)" : ""}`, section.sectionId)));
    select.dataset.sections = keys;
  }
  select.value = state.activeSectionId ?? "";
  const selected = activeSection();
  for (const button of $("#section-placement").querySelectorAll("[data-direction]")) {
    const direction = SECTION_DIRECTIONS[button.dataset.direction];
    let reason = !selected ? "Select an existing section first."
      : state.sections.length >= 16 ? "This level reached the 16-section limit." : "";
    if (selected && !reason) {
      const gridX = selected.gridX + direction.x, gridY = selected.gridY + direction.y;
      if (state.sections.some(section => section.gridX === gridX && section.gridY === gridY)) {
        reason = "Occupied by an existing section.";
      } else {
        try { sectionOrigin(gridX, gridY); }
        catch (error) { reason = error.message; }
      }
    }
    button.disabled = disabled || Boolean(reason);
    if (reason && state.sectionPlacementDirection === button.dataset.direction) state.sectionPlacementDirection = null;
    button.setAttribute("aria-pressed", String(state.sectionPlacementDirection === button.dataset.direction));
    button.title = reason || `Add an empty section to the ${button.dataset.direction}.`;
    button.textContent = `${button.dataset.direction[0].toUpperCase()}${button.dataset.direction.slice(1)}${reason.startsWith("Occupied") ? " (occupied)" : ""}`;
  }
  const direction = SECTION_DIRECTIONS[state.sectionPlacementDirection];
  $("#section-confirm").disabled = disabled || !direction;
  $("#section-placement-preview").textContent = direction && selected
    ? `Add an empty section ${state.sectionPlacementDirection} at (${selected.gridX + direction.x}, ${selected.gridY + direction.y})?`
    : "Select an available side. Nothing is created until you confirm.";
}

function sectionRemovalProblem(section) {
  if (!section || state.sections.length <= 1) return "A level must retain at least one section.";
  if (section.isNew && state.pendingSectionSave?.sections.some(item => item.sectionId === section.sectionId)) {
    return "Retry the pending save before removing this newly added section.";
  }
  if (!section.isNew && state.archivedSections.length >= 16) {
    return "The level has reached its 16-section retained archive limit.";
  }
  if (!levelBoundary()) return "";
  try {
    validatePlayableBoundaryForSections(levelBoundary(),
      state.sections.filter(item => item.sectionId !== section.sectionId));
    return "";
  } catch (error) {
    return `The custom boundary includes this section. Edit or reset the boundary before removal; it will not be reshaped. (${error.message})`;
  }
}

function closeSectionRemoval() {
  state.sectionRemovalId = null;
  $("#section-removal").hidden = true;
}

function showSectionRemoval() {
  const section = activeSection();
  if (!section || state.sections.length <= 1) return;
  state.sectionRemovalId = section.sectionId;
  $("#section-placement").hidden = true;
  state.sectionPlacementDirection = null;
  $("#section-removal").hidden = false;
  updateSectionRemoval();
  refreshChrome({ structure: false });
  (sectionRemovalProblem(section) ? $("#section-remove-cancel") : $("#section-remove-confirm")).focus();
}

function updateSectionRemoval() {
  const section = activeSection();
  if (!section || section.sectionId !== state.sectionRemovalId) {
    closeSectionRemoval();
    return;
  }
  const starts = section.document.objects.filter(object =>
    ["spawn-aries", "generic-player", "generic-player-2"].includes(object.assetId)).length;
  const otherSpawns = section.document.objects.filter(object => object.type === "spawn").length - starts;
  $("#section-removal-details").textContent =
    `Section ${state.sections.indexOf(section) + 1}: ${section.document.name} — position (${section.gridX}, ${section.gridY}), ${section.document.objects.length} object(s).`;
  const problem = sectionRemovalProblem(section);
  $("#section-removal-warning").textContent = [
    starts ? `This section contains ${starts} player start(s); they will not be moved.` : "",
    otherSpawns ? `This section also contains ${otherSpawns} other spawn(s).` : "",
    problem || (levelBoundary() ? "A custom boundary is present and will be preserved unchanged." : ""),
    section.isNew
      ? "Removal is undoable. Save to persist the current draft."
      : "Removal is undoable. Save to persist it; the removed content is retained."
  ].filter(Boolean).join(" ");
}

function removeSection() {
  const section = activeSection();
  if (!section || state.sectionRemovalId !== section.sectionId || state.saving || state.switching ||
      state.creating || state.levelBusy || isPlaying() || state.fillPreview || state.boundaryDraft || state.pointerMode) return;
  const problem = sectionRemovalProblem(section);
  if (problem) {
    $("#section-removal-warning").textContent = problem;
    return;
  }
  const previous = { sections: [...state.sections], archivedSections: [...state.archivedSections],
    undo: [...state.undo], redo: [...state.redo], selection: [...state.selectedIds] };
  const removeNewSection = Boolean(section.isNew);
  state.undo.push({ documents: allSections().map(item => ({ sectionId: item.sectionId, document: item.document })),
    selection: [...state.selectedIds], sectionId: section.sectionId,
    membership: removeNewSection
      ? { kind: "draft-add", sectionId: section.sectionId, present: true, section }
      : { sectionId: section.sectionId, restore: true } });
  if (state.undo.length > HISTORY_LIMIT) state.undo.shift();
  state.redo.length = 0;
  try {
    state.sections = state.sections.filter(item => item !== section);
    if (!removeNewSection) state.archivedSections.push(section);
    state.activeSectionId = state.sections[0].sectionId;
    state.document = activeSection().document;
    setSelection([]);
    state.scene.document = null;
    state.hierarchyKey = "";
    refreshChrome();
    closeSectionRemoval();
    setStatus("Section removed as one undoable edit. Save to persist; its content is retained.");
  } catch (error) {
    state.sections = previous.sections;
    state.archivedSections = previous.archivedSections;
    state.undo = previous.undo;
    state.redo = previous.redo;
    state.activeSectionId = section.sectionId;
    state.document = section.document;
    setSelection(previous.selection);
    state.scene.document = null;
    state.hierarchyKey = "";
    setStatus(`Section removal failed: ${error.message}`, true);
    refreshAfterOperation();
  }
}

function activateSection(section) {
  if (!section || section.sectionId === state.activeSectionId) return;
  if (activeSection()) activeSection().document = state.document;
  state.sectionPlacementDirection = null;
  closeSectionRemoval();
  state.activeSectionId = section.sectionId;
  state.document = section.document;
  state.preview = null;
  setSelection([]);
  state.scene.document = null;
  state.hierarchyKey = "";
  refreshChrome();
}

async function addSection(directionName) {
  if (!state.document || state.saving || state.switching || state.levelBusy || isPlaying()) return;
  const direction = SECTION_DIRECTIONS[directionName];
  try {
    if (state.fillPreview || state.boundaryDraft || state.pointerMode) throw new Error("Finish or cancel the current edit before adding a section.");
    if (state.pendingSectionSave) throw new Error("Retry the pending save before adding another section.");
    if (!direction || !activeSection()) throw new Error("Choose a side of an existing section.");
    const gridX = activeSection().gridX + direction.x, gridY = activeSection().gridY + direction.y;
    sectionOrigin(gridX, gridY);
    if (state.sections.some(section => section.gridX === gridX && section.gridY === gridY)) {
      throw new Error("That side is occupied by an existing section.");
    }
    const mapId = `map-${crypto.randomUUID()}`;
    const sectionId = `section-${crypto.randomUUID()}`;
    const name = `${activeSection().document.name} section`.slice(0, 64);
    const document = state.model === generic.MODEL
      ? generic.createDocument(mapId, name) : towerProject.createBlankDocument(mapId, name);
    document.objects = [];
    const section = { sectionId, mapId, gridX, gridY, revision: 0, document,
      savedJson: "", savedArchived: false, isNew: true };
    state.undo.push({ documents: allSections().map(item => ({ sectionId: item.sectionId, document: item.document })),
      selection: [...state.selectedIds], sectionId: state.activeSectionId,
      membership: { kind: "draft-add", sectionId, present: false, section } });
    if (state.undo.length > HISTORY_LIMIT) state.undo.shift();
    state.redo.length = 0;
    state.sections.push(section);
    state.sections.sort((a, b) => a.gridY - b.gridY || a.gridX - b.gridX);
    state.document = activeSection().document;
    $("#section-placement").hidden = true;
    state.sectionPlacementDirection = null;
    $("#section-status").textContent = `Added an empty section to the ${directionName} as an unsaved draft. Save to persist. Pan and zoom are unchanged.`;
    $("#section-status").classList.remove("error");
  } catch (error) {
    $("#section-status").textContent = error.message;
    $("#section-status").classList.add("error");
  } finally {
    refreshAfterOperation();
  }
}

function installDesign(identity, payload, design, assets, sectionData) {
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
  state.sections = sectionData.sections;
  state.archivedSections = sectionData.archivedSections ?? [];
  state.pendingSectionSave = null;
  state.saveError = null;
  state.fillPreview = null;
  state.sectionPlacementDirection = null;
  closeSectionRemoval();
  state.boundaryDraft = null;
  state.boundaryMode = "grid";
  state.fillSettings = { gapX: 0, gapY: 0, overlap: "skip", borderAssetId: null, collision: false };
  $("#section-placement").hidden = true;
  $("#section-status").textContent = "";
  $("#section-status").classList.remove("error");
  for (const section of state.sections) {
    if (typeof section.savedJson !== "string") section.savedJson = JSON.stringify(section.document);
  }
  state.sectionRevision = sectionData.revision;
  state.activeSectionId = state.sections.find(section => section.mapId === identity.mapId)?.sectionId ??
    state.sections[0]?.sectionId;
  state.document = state.sections.find(section => section.sectionId === state.activeSectionId)?.document ?? design;
  state.sectionBaseline = JSON.stringify(sectionDocuments());
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
  updateSectionPicker();
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
    const { payload, document: design, assets, sectionData } = await fetchDesign(identity);
    applyDesign(identity, payload, design, assets, sectionData);
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
      sections: () => structuredClone(state.sections.map(({ sectionId, mapId, gridX, gridY, revision, document }) =>
        ({ sectionId, mapId, gridX, gridY, revision, document }))),
      boundary: () => structuredClone(levelBoundary()),
      worldToClient(x, y) {
        const rect = canvas.getBoundingClientRect();
        return { x: rect.left + (x - state.cameraX) * state.zoom, y: rect.top + (y - state.cameraY) * state.zoom };
      },
      view: () => ({ zoom: state.zoom, cameraX: state.cameraX, cameraY: state.cameraY }),
      selection: () => ({ sectionId: state.activeSectionId, ids: [...state.selectedIds] }),
      setView(view) {
        Object.assign(state, view);
        render();
      }
    });
  }
  const { payload, document: design, assets, sectionData } = await fetchDesign(state.identity, true);
  applyDesign(state.identity, payload, design, assets, sectionData);
}

openFloor().catch(error => {
  $("#save-state").textContent = "Not loaded";
  $("#save-state").className = "save-state dirty";
  setStatus(`Could not open Floor 1: ${error.message}`, true);
});
