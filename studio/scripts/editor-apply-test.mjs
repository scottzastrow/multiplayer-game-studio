import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import { register } from "node:module";
import { connectedFixture } from "./connected-play-fixtures.mjs";
import * as towerProject from "../../games/astraeum-tower/src/project.js";
import * as generic from "../../games/generic-grid-v1/src/project.js";
import * as towerRender from "../../games/astraeum-tower/src/design-render.js";
import * as boundaries from "../playable-boundaries.js";
import * as terrain from "../world-terrain.js";
import * as fill from "../world-fill.js";
import * as coordinates from "../world-coordinates.js";
import * as identity from "../project-identity.js";

register("./public-runtime-loader.mjs", import.meta.url);
const { createLocalGame } = await import("@multiplayer-game/local-preview");
const { createConnectedPreview, connectedSkin } = await import("../extensions/connected-play.js");

// Execute the entire editor, replacing only browser/platform I/O, not its controllers or renderer.
const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const main = (await readFile(new URL("../src/main.js", import.meta.url), "utf8"))
  .replace(/^import\s[\s\S]*?;\r?$/gm, "")
  .replaceAll("import.meta.env", "({ DEV: false })")
  .replaceAll("import.meta.url", JSON.stringify(new URL("../src/main.js", import.meta.url).href))
  .split("\nopenFloor().catch(")[0];

function drawingContext() {
  const calls = [];
  const stack = [];
  const context = { calls, fillStyle: "", strokeStyle: "",
    save() { stack.push({ fillStyle: this.fillStyle, strokeStyle: this.strokeStyle }); },
    restore() { Object.assign(this, stack.pop()); }
  };
  for (const method of ["setTransform", "fillRect", "strokeRect", "drawImage", "beginPath", "closePath",
    "moveTo", "lineTo", "stroke", "fill", "arc", "fillText", "setLineDash", "translate", "scale"]) {
    context[method] = function (...args) {
      calls.push({ method, args, fillStyle: this.fillStyle, strokeStyle: this.strokeStyle });
    };
  }
  return context;
}

function browserFixture() {
  class Element {
    constructor(tagName = "div") {
      this.tagName = tagName.toLowerCase();
      this.children = [];
      this.dataset = {};
      this.attributes = {};
      this.listeners = new Map();
      this.className = "";
      this.textContent = "";
      this.value = "";
      this.scrollTop = 0;
      for (const property of ["disabled", "hidden", "checked", "open", "inert"]) {
        Object.defineProperty(this, property, {
          set(value) { this[`_${property}`] = Boolean(value); },
          get() { return this[`_${property}`] ?? false; }
        });
      }
      for (const dimension of ["width", "height"]) {
        Object.defineProperty(this, dimension, {
          set(value) { this[`_${dimension}`] = value; if (this.context) this.context.calls.length = 0; },
          get() { return this[`_${dimension}`]; }
        });
      }
      this.classList = {
        contains: name => this.className.split(/\s+/).includes(name),
        toggle: (name, force = !this.classList.contains(name)) => {
          this.className = [...new Set([...this.className.split(/\s+/).filter(item => item && item !== name),
            ...(force ? [name] : [])])].join(" ");
          return force;
        },
        add: name => this.classList.toggle(name, true),
        remove: name => this.classList.toggle(name, false)
      };
    }
    setAttribute(name, value) {
      this.attributes[name] = value;
      if (name === "id") this.id = value;
      else if (name === "class") this.className = value;
      else if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
      else if (["disabled", "hidden", "checked", "open", "inert"].includes(name)) this[name] = true;
      else this[name] = value;
    }
    append(...children) {
      for (const child of children) { child.parentElement = this; this.children.push(child); }
    }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    matches(selector) {
      if (selector.includes(",")) return selector.split(",").some(part => this.matches(part.trim()));
      const attributes = [...selector.matchAll(/\[([\w-]+)(?:=['"]?([^'"\]]*)['"]?)?\]/g)];
      const simple = selector.replace(/\[[^\]]+\]/g, "");
      const tag = simple.match(/^[\w-]+/)?.[0];
      return (!tag || this.tagName === tag) &&
        [...simple.matchAll(/#([\w-]+)/g)].every(([, id]) => this.id === id) &&
        [...simple.matchAll(/\.([\w-]+)/g)].every(([, name]) => this.classList.contains(name)) &&
        attributes.every(([, name, value]) => value === undefined
          ? ["disabled", "hidden", "checked", "open", "inert"].includes(name)
            ? Boolean(this[name]) : Object.hasOwn(this.attributes, name)
          : (name.startsWith("data-")
            ? this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())]
            : this.attributes[name]) === value);
    }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
    querySelectorAll(selector) {
      return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    addEventListener(type, handler) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(handler);
    }
    dispatch(type, data = {}) {
      const event = { target: this, preventDefault() { this.defaultPrevented = true; }, ...data };
      for (const handler of this.listeners.get(type) ?? []) handler(event);
      return event;
    }
    click() {
      assert.ok(!this.disabled && !this.closest("[inert]") && !this.closest("[hidden]"),
        `${this.id} must be enabled, visible and non-inert`);
      this.dispatch("click");
    }
    async clickAsync() {
      assert.ok(!this.disabled && !this.closest("[inert]") && !this.closest("[hidden]"));
      for (const handler of this.listeners.get("click") ?? []) await handler({ target: this });
    }
    focus() { document.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    scrollIntoView() {}
    setPointerCapture(pointerId) { this.capturedPointer = pointerId; }
    hasPointerCapture(pointerId) { return this.capturedPointer === pointerId; }
    getBoundingClientRect() { return { left: 0, top: 0, right: 1200, bottom: 900, width: 1200, height: 900 }; }
    getContext() { return this.context ??= drawingContext(); }
  }
  const document = new Element("document");
  document.createElement = tag => new Element(tag);
  document.createDocumentFragment = () => new Element("fragment");
  const stack = [document];
  for (const [, closing, tag, attributes] of html.matchAll(/<(\/?)([\w-]+)([^>]*)>/g)) {
    if (closing) { stack.pop(); continue; }
    const node = new Element(tag);
    for (const [, name, value, bare] of attributes.matchAll(/([\w-]+)(?:="([^"]*)"|='([^']*)')?/g)) {
      node.setAttribute(name, value ?? bare ?? "");
    }
    stack.at(-1).append(node);
    if (!["meta", "link", "input", "img", "br", "hr"].includes(tag)) stack.push(node);
  }
  document.body = document.querySelector("body");
  return { document, Element, window: new Element("window"),
    Option: function (label, value) {
      const option = new Element("option");
      option.textContent = label;
      option.value = value;
      return option;
    }
  };
}

function editor(model) {
  const browser = browserFixture();
  const sandbox = createContext({
    ...browser, towerProject, generic, towerRender, ...boundaries, ...terrain, ...fill, ...coordinates, ...identity,
    RUNTIME_MAP_CELL_SIZE: 32, RUNTIME_MAX_MAP_DIMENSION: 2048,
    ARTWORK_CREDIT: "", structuredClone, TextEncoder, console,
    localStorage: { getItem() { return null; }, setItem() {} },
    ResizeObserver: class { observe() {} }
  });
  runInContext(`${main}
    globalThis.testEditor = { state, configureEvents, configurePalette, refreshChrome, activateAssetCatalog, render, play, stop };
  `, sandbox);
  const api = sandbox.testEditor;
  const { state } = api;
  const design = model === generic ? generic.createDocument("apply-map", "Apply fixture")
    : towerProject.createBlankDocument("apply-map", "Apply fixture");
  design.objects = [];
  state.identity = { projectId: "apply-project", mapId: design.id };
  state.model = model === generic ? generic.MODEL : identity.ASTRAEUM_MODEL;
  state.artwork = Object.fromEntries(Object.keys(towerRender.ARTWORK_URLS)
    .map(id => [id, { id, width: 128, height: 128, naturalWidth: 128, naturalHeight: 128 }]));
  api.activateAssetCatalog(state.model, { catalog: model.ASSET_CATALOG, records: [], images: {} });
  state.sections = [{ sectionId: "root", mapId: design.id, gridX: 0, gridY: 0,
    document: design, savedJson: JSON.stringify(design) }];
  state.activeSectionId = "root";
  state.document = design;
  state.persisted = true;
  state.layers = Object.fromEntries(model.DESIGN_LAYERS.map(layer => [layer.id, { visible: true, locked: false }]));
  Object.assign(state, { cameraX: 0, cameraY: 0, zoom: 1, pixelRatio: 1, viewportWidth: 1200, viewportHeight: 900 });
  state.paletteView = "list";
  api.configurePalette();
  api.configureEvents();
  api.refreshChrome();
  const $ = selector => {
    const node = browser.document.querySelector(selector);
    assert.ok(node, `fixture contains ${selector}`);
    return node;
  };
  const tool = value => $("#editor-tool").dispatch("change", { target: { value } });
  const asset = id => {
    const card = $(`.asset-card[data-asset-id="${id}"]`);
    card.dispatch("pointerdown", { button: 0, clientX: 0, clientY: 0, pointerId: 2 });
    card.dispatch("pointerup", { clientX: 0, clientY: 0, pointerId: 2 });
    assert.equal(state.placeAssetId, id);
    assert.equal(state.tool, "fill", "real palette pointer selection retains Fill mode");
  };
  const drag = (points) => {
    const event = ([clientX, clientY]) => ({ clientX, clientY, button: 0, pointerId: 1 });
    $("#map-canvas").dispatch("pointerdown", event(points[0]));
    for (const point of points.slice(1, -1)) $("#map-canvas").dispatch("pointermove", event(point));
    $("#map-canvas").dispatch("pointerup", event(points.at(-1)));
  };
  const key = (selector, code) => browser.window.dispatch("keydown", { target: $(selector), code });
  const activate = (selector, code) => {
    const event = key(selector, code);
    assert.ok(!event.defaultPrevented, `${code} must reach native button activation for ${selector}`);
    $(selector).click();
  };
  const documents = () => JSON.stringify(state.sections.map(section => section.document));
  const outline = () => $("#map-canvas").getContext().calls
    .filter(call => call.method === "stroke" && call.strokeStyle === "#66d6a1cc").length;
  const resetFrame = () => { $("#map-canvas").getContext().calls.length = 0; };
  return { ...api, $, tool, asset, drag, key, activate, documents, outline, resetFrame, sandbox };
}

for (const model of [generic, towerProject]) {
  const e = editor(model);
  const { state, $ } = e;
  assert.equal($("#level-menu").tagName, "details", "Level uses the native keyboard-accessible disclosure");
  assert.equal($("#level-add").closest("#level-menu"), $("#level-menu"));
  assert.equal($("#section-add").closest("#level-menu"), null);
  assert.equal($("#section-add").parentElement, $("#section-select").parentElement);
  assert.equal($("#section-select").parentElement.children.indexOf($("#section-add")),
    $("#section-select").parentElement.children.indexOf($("#section-select")) + 1,
    "Add Section is directly below the section dropdown");
  const before = e.documents();
  $("#level-menu").open = true;
  $("#level-add").click();
  assert.equal($("#level-menu").open, false);
  assert.equal($("#level-dialog").open, true);
  assert.equal(state.levelAction, "add", "the menu reuses the existing Add Level action");
  assert.equal($("#level-title").textContent, "Add Level");
  assert.match($("#level-description").textContent, /one empty 2048 x 2048 section/);
  assert.equal($("#level-unsaved").hidden, true);
  $("#level-cancel").click();
  assert.equal(e.documents(), before, "cancel Add Level leaves the original level intact");
  const design = structuredClone(state.document);
  design.name = "Unsaved level name";
  state.sections[0].document = state.document = design;
  e.refreshChrome();
  $("#level-menu").open = true;
  $("#level-add").click();
  assert.equal($("#level-unsaved").hidden, false);
  assert.equal($("#level-discard").hidden, false);
  assert.equal($("#level-submit").textContent, "Save and continue");
  $("#level-cancel").click();
  assert.equal(state.document.name, "Unsaved level name");
  assert.equal(state.identity.mapId, "apply-map");
  $("#section-add").click();
  assert.equal($("#level-menu").open, false);
  assert.equal($("#section-placement").hidden, false);
  assert.equal($("#level-dialog").open, false, "Add Section does not create a separate level");
  assert.equal(state.sections.length, 1);
  $("#section-cancel").click();
  assert.equal($("#section-placement").hidden, true);
  state.saving = true;
  e.refreshChrome();
  assert.equal($("#level-add").disabled, true);
  assert.equal($("#section-add").disabled, true);
}
console.log("Level menu: existing Add Level dialog, distinct Add Section flow, cancellation, dirty protection and busy controls passed in both models.");

for (const model of [generic, towerProject]) {
  const e = editor(model);
  const { state, $ } = e;
  const east = structuredClone(state.document);
  east.id = "east-map";
  state.sections.push({ sectionId: "east", mapId: east.id, gridX: 1, gridY: 0,
    document: east, savedJson: JSON.stringify(east) });
  const dirty = structuredClone(east);
  dirty.name = "Keep this unsaved section edit";
  state.sections[1].document = dirty;
  e.refreshChrome();
  $("#section-select").value = "east";
  $("#section-select").dispatch("change");
  assert.equal(state.activeSectionId, "east", "actual dropdown handler selects the placement anchor");
  assert.equal(state.document.name, dirty.name);
  const original = e.documents();
  const positions = JSON.stringify(state.sections.map(s => [s.gridX, s.gridY]));
  const view = [state.cameraX, state.cameraY, state.zoom];
  const requests = [];
  e.sandbox.fetch = async (address, options) => {
    requests.push({ address, ...options });
    const document = model === generic ? generic.createDocument("new-section", "Empty section")
      : towerProject.createBlankDocument("new-section", "Empty section");
    document.objects = [];
    return { ok: true, json: async () => ({ revision: 1, sections: [
      ...state.sections.map(section => ({ ...section, document: JSON.parse(section.savedJson) })),
      { sectionId: "new", mapId: document.id, gridX: 1, gridY: -1, document, revision: 0 }
    ] }) };
  };
  $("#section-add").click();
  const side = direction => $(`[data-direction="${direction}"]`);
  assert.equal(side("west").disabled, true, "occupied origin is unavailable from the east section");
  assert.equal(side("west").attributes["aria-pressed"], "false");
  assert.equal($("#section-confirm").disabled, true);
  side("north").click();
  assert.equal(side("north").attributes["aria-pressed"], "true");
  assert.equal($("#section-confirm").disabled, false);
  assert.match($("#section-placement-preview").textContent, /north at \(1, -1\)/);
  assert.equal(requests.length, 0, "direction selection never creates a section");
  assert.equal(e.documents(), original);
  $("#section-cancel").click();
  assert.equal($("#section-placement").hidden, true);
  assert.equal(state.sectionPlacementDirection, null);
  assert.equal(requests.length, 0);
  assert.equal(e.documents(), original, "Cancel preserves unsaved content");
  $("#section-add").click();
  assert.equal($("#section-confirm").disabled, true, "reopen requires a fresh side choice");
  side("north").click();
  side("south").click();
  assert.equal(side("north").attributes["aria-pressed"], "false");
  assert.equal(side("south").attributes["aria-pressed"], "true");
  $("#section-select").value = "root";
  $("#section-select").dispatch("change");
  assert.equal($("#section-confirm").disabled, true, "changing the anchor clears the pending side");
  assert.equal(side("east").disabled, true);
  $("#section-select").value = "east";
  $("#section-select").dispatch("change");
  side("north").click();
  state.saving = true;
  e.refreshChrome();
  assert.equal($("#section-confirm").disabled, true, "saving blocks confirmation");
  state.saving = false;
  e.refreshChrome();
  await $("#section-confirm").clickAsync();
  assert.equal(requests.length, 1, "Confirm uses the existing section POST exactly once");
  assert.equal(requests[0].address, "/api/projects/apply-project/levels/apply-map/sections");
  assert.equal(requests[0].method, "POST");
  assert.deepEqual(JSON.parse(requests[0].body), { gridX: 1, gridY: -1, revision: 0 });
  assert.equal(JSON.stringify(state.sections.slice(0, 2).map(s => s.document)), original);
  assert.equal(JSON.stringify(state.sections.slice(0, 2).map(s => [s.gridX, s.gridY])), positions);
  assert.equal(state.sections[1].document.name, dirty.name, "response cannot overwrite unsaved content");
  assert.notEqual(state.sections[1].savedJson, JSON.stringify(state.sections[1].document));
  assert.equal(state.sections[2].document.objects.length, 0);
  assert.deepEqual([state.cameraX, state.cameraY, state.zoom], view);
  assert.equal($("#section-placement").hidden, true);
  assert.equal(state.sectionPlacementDirection, null);
  assert.equal(side("north").disabled, true, "the newly occupied side becomes unavailable");
}
console.log("Direct Add Section wiring: selected anchor, disabled occupied sides, direction preview, Cancel, explicit Confirm POST, empty creation and unsaved content preservation passed in both models (browser I/O fixture).");

for (const model of [generic, towerProject]) {
  for (const size of [1, 2, 4, 8]) {
    const e = editor(model);
    const { state, $ } = e;
    const tile = model === generic ? "generic-tile" : "floor-cobblestone";
    const east = structuredClone(state.document);
    east.id = "east-map";
    state.sections.push({ sectionId: "east", mapId: east.id, gridX: 1, gridY: 0,
      document: east, savedJson: JSON.stringify(east) });
    e.tool("paint");
    assert.equal($("#paint-options").hidden, false);
    assert.equal($("#paint-asset-name").textContent, "Choose a Paint asset from the palette");
    assert.equal($("#paint-brush-size").disabled, true);
    const card = $(`.asset-card[data-asset-id="${tile}"]`);
    card.dispatch("pointerdown", { button: 0, clientX: 0, clientY: 0, pointerId: 2 });
    card.dispatch("pointerup", { clientX: 0, clientY: 0, pointerId: 2 });
    assert.equal($("#paint-asset-name").textContent, model.ASSET_CATALOG[tile].label);
    assert.equal($("#paint-asset-thumbnail").dataset.assetId, tile);
    assert.equal($("#paint-asset-thumbnail").hidden, false);
    assert.ok($("#paint-asset-thumbnail").querySelector("canvas").getContext().calls
      .some(call => ["fillRect", "drawImage"].includes(call.method)), "selected Paint asset has real thumbnail artwork");
    $("#paint-brush-size").dispatch("change", { target: { value: String(size) } });
    const before = e.documents();
    const canvas = $("#map-canvas");
    canvas.dispatch("pointermove", { clientX: 2017, clientY: 337 });
    const footprint = terrain.terrainBrushFootprint({ x: 2017, y: 337 }, size);
    assert.deepEqual(JSON.parse(canvas.dataset.paintFootprint), { ...footprint, problem: null });
    assert.equal(e.documents(), before, "cursor preview never edits documents");
    assert.ok(canvas.getContext().calls.some(call => call.method === "strokeRect" &&
      call.strokeStyle === "#7dffa8" && JSON.stringify(call.args) ===
        JSON.stringify([footprint.x, footprint.y, footprint.width, footprint.height])),
    "canvas draws the exact selected-size cursor footprint");
    e.drag([[2017, 337], [2081, 337]]);
    const after = e.documents();
    const terrainCount = state.sections.reduce((sum, section) => sum +
      section.document.objects.filter(object => object.type === "terrain-tile").length, 0);
    assert.equal(terrainCount, (size + 2) * size);
    assert.ok(state.sections.every(section => section.document.objects.some(object => object.type === "terrain-tile")));
    assert.equal(state.undo.length, 1, "one history entry covers the complete cross-section stroke");
    $("#undo").click();
    assert.equal(e.documents(), before);
    $("#redo").click();
    assert.equal(e.documents(), after);
    e.drag([[2017, 337], [2081, 337]]);
    assert.equal(state.undo.length, 1, "identical large strokes do not add history");
    state.layers.terrain.locked = true;
    canvas.dispatch("pointermove", { clientX: 2017, clientY: 337 });
    assert.match(JSON.parse(canvas.dataset.paintFootprint).problem, /locked/);
    e.drag([[2017, 433], [2081, 433]]);
    assert.equal(e.documents(), after);
    assert.match($("#status").textContent, /locked/);
    state.layers.terrain.locked = false;
    state.layers.terrain.visible = false;
    e.drag([[2017, 433], [2081, 433]]);
    assert.equal(e.documents(), after);
    assert.match($("#status").textContent, /hidden/);
    state.layers.terrain.visible = true;
    e.drag([[64, 433], [-257, 433]]);
    assert.equal(e.documents(), after, "a missing section rejects the entire swept footprint");
    assert.equal(state.undo.length, 1);
    canvas.dispatch("pointerdown", { button: 0, clientX: 2017, clientY: 433, pointerId: 1 });
    assert.equal($("#paint-brush-size").disabled, true);
    $("#paint-brush-size").dispatch("change", { target: { value: size === 1 ? "8" : "1" } });
    assert.equal(state.pointerStart.stroke.brushSize, size, "brush size is latched for the whole stroke");
    canvas.dispatch("pointercancel");
    assert.equal(e.documents(), after);
    assert.equal(state.undo.length, 1);
    canvas.dispatch("pointerleave");
    assert.equal(canvas.dataset.paintFootprint, "");
    $("#paint-brush-size").dispatch("change", { target: { value: "3" } });
    assert.equal(state.paintBrushSize, size);
    assert.match($("#status").textContent, /Brush size/);
    const wall = model === generic ? "generic-block" : "wall-damp-stone";
    const wallCard = $(`.asset-card[data-asset-id="${wall}"]`);
    wallCard.dispatch("pointerdown", { button: 0, clientX: 0, clientY: 0, pointerId: 2 });
    wallCard.dispatch("pointerup", { clientX: 0, clientY: 0, pointerId: 2 });
    assert.equal($("#paint-asset-name").textContent, model.ASSET_CATALOG[wall].label);
    assert.equal($("#paint-brush-size").disabled, true);
    assert.match($("#paint-support").textContent, /not terrain/);
    e.drag([[640, 640], [800, 640]]);
    assert.equal(state.sections.reduce((sum, section) => sum +
      section.document.objects.filter(object => object.type === "wall").length, 0), 1,
    "non-terrain Paint keeps single placement and ignores brush size");
    e.tool("select");
    assert.equal($("#paint-options").hidden, true);
  }
}
console.log("Paint: all four brush sizes, selected thumbnails, cursor footprints, cross-section strokes, locks, hidden/missing rejection and one-action Undo/Redo passed in both models.");

{
  const e = editor(towerProject);
  const design = towerProject.createFloorDocument();
  e.state.sections[0].mapId = design.id;
  e.state.sections[0].document = e.state.document = design;
  e.state.sections[0].savedJson = JSON.stringify(design);
  e.state.identity.mapId = design.id;
  e.refreshChrome();
  const before = e.documents();
  const trace = [];
  runInContext(`
    globalThis.validationTrace = [];
    globalThis.originalValidate = validateFloorDocument;
    validateFloorDocument = value => {
      try {
        const result = originalValidate(value);
        validationTrace.push("valid");
        return result;
      } catch (error) {
        validationTrace.push(error.message);
        throw error;
      }
    };
  `, e.sandbox);
  const button = e.$("#fill-apply");
  const handlers = button.listeners.get("click");
  assert.equal(handlers.length, 1, "Apply has exactly one registered handler");
  const registered = handlers[0];
  assert.equal(registered.name, "applyFill");
  let executions = 0;
  handlers[0] = event => { executions++; return registered(event); };
  const capture = phase => trace.push({
    assetId: e.state.placeAssetId, settings: { ...e.state.fillSettings },
    phase, preview: Boolean(e.state.fillPreview), disabled: button.disabled,
    placements: e.state.fillPreview?.plan?.count ?? null,
    skipped: e.state.fillPreview?.plan?.skipped ?? null,
    error: e.state.fillPreview?.error ?? null, handlerExecutions: executions,
    status: e.$("#status").textContent,
    validation: [...e.sandbox.validationTrace],
    documentChanged: e.documents() !== before, objects: e.state.document.objects.length,
    canvasObjects: Number(e.$("#map-canvas").dataset.objectCount), undo: e.state.undo.length,
    sceneCurrent: e.state.sections[0].scene.document === e.state.document
  });
  e.tool("fill");
  e.asset("wall-damp-stone");
  capture("asset-selected");
  // Fractional pointer-derived coordinates exercise the non-terrain wall path.
  e.drag([[259.4, 259.7], [300.5, 301.2], [349.6, 350.2]]);
  capture("occupied-area-released");
  assert.equal(e.documents(), before);
  assert.equal(button.disabled, false);
  assert.equal(e.state.fillPreview.plan.count, 0);
  assert.equal(e.state.fillPreview.plan.skipped, 4);
  button.click();
  capture("occupied-area-apply");
  assert.equal(e.documents(), before, "Skip overlaps intentionally leaves the existing walls unchanged");
  assert.equal(e.state.undo.length, 0);
  assert.equal(e.state.fillPreview, null);
  assert.match(e.$("#status").textContent, /unchanged/);
  e.drag([[131.4, 131.7], [180.5, 181.2], [221.6, 222.2]]);
  capture("open-area-released");
  assert.equal(e.documents(), before);
  assert.equal(button.disabled, false);
  assert.equal(e.state.fillPreview.plan.count, 4);
  const expected = JSON.stringify(e.state.fillPreview.plan.updates[0].document);
  button.click();
  capture("apply-clicked");
  assert.equal(JSON.stringify(e.state.document), expected);
  assert.equal(executions, 2);
  assert.equal(e.state.undo.length, 1);
  assert.equal(e.state.fillPreview, null);
  assert.equal(e.state.sections[0].scene.document, e.state.document);
  const applied = e.documents();
  const sceneCalls = () => e.state.sections[0].scene.canvas.getContext().calls
    .filter(call => call.method === "drawImage").length;
  const appliedDraws = sceneCalls();
  e.$("#undo").click();
  assert.equal(e.documents(), before);
  assert.ok(sceneCalls() < appliedDraws, "the actual renderer emits added wall artwork after Apply");
  e.$("#redo").click();
  assert.equal(e.documents(), applied);
  assert.equal(sceneCalls(), appliedDraws);
  e.drag([[400, 259], [445, 304], [490, 350]]);
  e.state.layers.walls.locked = true;
  button.click();
  capture("apply-rejected");
  assert.equal(executions, 3, "the real handler executes and reports revalidation rejection");
  assert.match(e.$("#tool-hint").textContent, /locked/);
  assert.ok(e.$("#status").classList.contains("error"));
  assert.equal(e.documents(), applied);
  assert.equal(e.state.undo.length, 1);
  e.$("#fill-cancel").click();
  assert.equal(e.documents(), applied);
  assert.equal(e.state.tool, "select");
  console.log("Authored Floor 1 / Damp stone wall / default Fill settings (not live user state):");
  console.log(JSON.stringify(trace));
}

for (const model of [generic, towerProject]) {
  const input = editor(model);
  const wallId = model === generic ? "generic-block" : "wall-damp-stone";
  const original = input.documents();
  input.tool("fill");
  assert.equal(input.$("#fill-options").hidden, false);
  assert.equal(input.state.placeAssetId, null, "Fill never silently selects an asset");
  assert.equal(input.$("#fill-asset-name").textContent, "Choose a fill asset from the palette");
  assert.equal(input.$("#fill-asset-thumbnail").hidden, true);
  input.drag([[256, 256], [320, 320]]);
  assert.equal(input.state.fillPreview, null, "no asset means no rectangle preview");
  assert.equal(input.$("#status").textContent, "Choose a fill asset from the palette");
  assert.equal(input.documents(), original);
  assert.equal(input.$("#fill-cancel").disabled, false, "Fill can be cancelled without selecting an asset");
  input.$("#fill-cancel").click();
  assert.equal(input.$("#tool-settings").hidden, true);
  assert.equal(input.state.tool, "select");
  assert.equal(input.documents(), original);
  input.tool("paint");
  const terrainId = Object.keys(model.ASSET_CATALOG)
    .find(id => terrain.isTerrainBrushAsset(model.ASSET_CATALOG[id]));
  const terrainCard = input.$(`.asset-card[data-asset-id="${terrainId}"]`);
  terrainCard.dispatch("pointerdown", { button: 0, clientX: -40, clientY: 256, pointerId: 2 });
  terrainCard.dispatch("pointerup", { clientX: -40, clientY: 256, pointerId: 2 });
  assert.equal(input.state.placeAssetId, terrainId, "Paint palette click explicitly selects terrain");
  input.tool("fill");
  assert.equal(input.state.placeAssetId, terrainId, "switching into Fill retains the eligible palette selection");
  assert.equal(input.$("#fill-asset-name").textContent, model.ASSET_CATALOG[terrainId].label);
  assert.equal(input.$("#fill-asset-thumbnail").dataset.assetId, terrainId);
  assert.equal(input.$("#fill-asset-thumbnail").hidden, false);
  const card = input.$(`.asset-card[data-asset-id="${wallId}"]`);
  // Follow capture routing: old palette drags keep events on the card over the canvas.
  card.dispatch("pointerdown", { button: 0, clientX: -40, clientY: 256, pointerId: 2 });
  const dragTarget = card.hasPointerCapture(2) ? card : input.$("#map-canvas");
  dragTarget.dispatch("pointermove", { clientX: 256, clientY: 256, pointerId: 2 });
  dragTarget.dispatch("pointerup", { clientX: 256, clientY: 256, pointerId: 2 });
  assert.equal(input.documents(), original, "dragging the wall palette asset in Fill must not place one wall");
  assert.doesNotMatch(input.$("#status").textContent, /^Placed /);
  assert.equal(input.state.tool, "fill");
  assert.equal(input.state.placeAssetId, wallId);
  assert.equal(input.state.paletteDrag, null, "Fill asset selection cannot start a single-placement palette drag");
  assert.equal(input.$("#fill-apply").disabled, true, "selecting an asset alone is not a rectangle preview");
  assert.equal(input.$("#fill-cancel").disabled, false, "Fill can be cancelled before drawing");
  input.activate("#fill-cancel", "Enter");
  assert.equal(input.state.tool, "select");
  assert.equal(input.$("#tool-settings").hidden, true);
  assert.equal(input.documents(), original);

  input.tool("fill");
  input.asset(wallId);
  assert.equal(input.$("#fill-asset-name").textContent, model.ASSET_CATALOG[wallId].label);
  assert.equal(input.$("#fill-asset-thumbnail").dataset.assetId, wallId);
  const thumbnail = input.$("#fill-asset-thumbnail").querySelector("canvas");
  assert.ok(thumbnail.getContext().calls.some(call => ["drawImage", "fillRect"].includes(call.method)),
    "chosen asset thumbnail uses the real asset renderer");
  input.$("#map-canvas").dispatch("pointerdown", { clientX: 256, clientY: 256, button: 0, pointerId: 1 });
  assert.equal(input.state.pointerMode, "fill", "Fill pointerdown must route to the rectangle gesture");
  assert.equal(input.state.pointerStart.assetId, input.state.placeAssetId,
    "registered palette pointer input updates the same asset state consumed by the Fill pointer handler");
  assert.equal(input.state.pointerStart.assetId, wallId);
  assert.equal(input.documents(), original);
  input.$("#map-canvas").dispatch("pointermove", { clientX: 320, clientY: 320, pointerId: 1 });
  assert.equal(input.documents(), original, "Fill pointermove only draws the rectangle");
  input.$("#map-canvas").dispatch("pointerup", { clientX: 320, clientY: 320, pointerId: 1 });
  assert.equal(input.state.pointerMode, null);
  assert.equal(input.state.fillPreview.assetId, wallId);
  assert.equal(input.documents(), original, "Fill pointerup plans a preview without placing walls");
  assert.equal(input.$("#fill-apply").disabled, false);
  assert.equal(input.$("#fill-cancel").disabled, false);
  assert.match(input.$("#tool-hint").textContent, /placement target/);
  const expectedFill = JSON.stringify(input.state.fillPreview.plan.updates[0].document);
  input.activate("#fill-apply", "Space");
  assert.equal(JSON.stringify(input.state.document), expectedFill);
  assert.equal(input.state.undo.length, 1);
  assert.equal(input.state.fillPreview, null);
  assert.equal(input.$("#fill-cancel").disabled, false, "Fill remains cancellable after Apply");
  const appliedFill = input.documents();
  input.$("#undo").click();
  assert.equal(input.documents(), original);
  input.$("#redo").click();
  assert.equal(input.documents(), appliedFill);
  input.drag([[384, 256], [448, 320]]);
  input.activate("#fill-cancel", "Space");
  assert.equal(input.documents(), appliedFill, "Cancel preserves already-applied objects");
  assert.equal(input.state.undo.length, 1, "Cancel adds no history");
  assert.equal(input.state.fillPreview, null);
  assert.equal(input.state.tool, "select");
  assert.equal(input.$("#editor-tool").value, "select");
  assert.equal(input.$("#tool-settings").hidden, true);
  input.tool("fill");
  input.state.layers.walls.locked = true;
  input.drag([[384, 256], [448, 320]]);
  assert.equal(input.$("#fill-apply").disabled, true);
  assert.equal(input.$("#fill-cancel").disabled, false);
  assert.match(input.$("#tool-hint").textContent, /locked/);
  input.$("#fill-cancel").click();
  assert.equal(input.documents(), appliedFill);
  assert.equal(input.state.tool, "select");
  assert.equal(input.$("#tool-settings").hidden, true);
  input.state.layers.walls.locked = false;
  input.tool("paint");
  card.dispatch("pointerdown", { button: 0, clientX: -40, clientY: 512, pointerId: 3 });
  card.dispatch("pointermove", { clientX: 512, clientY: 512, pointerId: 3 });
  card.dispatch("pointerup", { clientX: 512, clientY: 512, pointerId: 3 });
  assert.equal(input.state.document.objects.length, JSON.parse(expectedFill).objects.length + 1,
    "palette drag placement remains available outside Fill");
  assert.match(input.$("#status").textContent, /^Placed /);

  const e = editor(model);
  const { state, $, tool, drag, documents, activate, resetFrame, outline } = e;
  const baseline = documents();
  tool("boundary");
  drag([[64, 64], [160, 160]]);
  assert.equal(documents(), baseline);
  assert.equal($("#boundary-apply").disabled, false);
  assert.equal($("#undo").disabled, true);
  assert.ok(e.key("#boundary-cancel", "Tab").defaultPrevented !== true);
  assert.equal(e.key("#map-canvas", "KeyZ").defaultPrevented, true);
  activate("#boundary-cancel", "Space");
  assert.equal(documents(), baseline);
  assert.equal(state.undo.length, 0);

  for (const mode of ["grid", "polygon"]) {
    $("#boundary-mode").dispatch("change", { target: { value: mode } });
    drag(mode === "grid" ? [[64, 64], [160, 160]] : [[64, 64], [192, 64], [192, 192], [64, 192], [64, 64]]);
    resetFrame();
    activate("#boundary-apply", "Enter");
    const applied = documents();
    assert.notEqual(applied, baseline);
    assert.equal(state.boundaryDraft, null);
    assert.equal(state.tool, "select");
    assert.equal($("#tool-settings").hidden, true, "Boundary panel closes after Apply");
    assert.ok(outline() > 0, "actual main renderer strokes the applied boundary in Select");
    assert.ok($("#save-state").classList.contains("dirty"));
    assert.equal(state.undo.length, 1);
    resetFrame();
    $("#undo").click();
    assert.equal(documents(), baseline);
    assert.equal(outline(), 0, "Undo removes the custom outline in Select");
    assert.ok($("#save-state").classList.contains("saved"));
    resetFrame();
    $("#redo").click();
    assert.equal(documents(), applied);
    assert.ok(outline() > 0, "Redo redraws the applied outline");
    $("#undo").click();
    tool("boundary");
  }
  $("#boundary-mode").dispatch("change", { target: { value: "grid" } });
  drag([[64, 64], [160, 160]]);
  const draft = state.boundaryDraft;
  state.sections[0].document = state.document = { ...state.document };
  $("#boundary-apply").click();
  assert.equal(state.boundaryDraft, draft);
  assert.match($("#boundary-status").textContent, /changed after this gesture/);
  assert.ok($("#status").classList.contains("error"));
  assert.equal(documents(), baseline);
  assert.equal(state.undo.length, 0);
  $("#boundary-cancel").click();
  $("#boundary-mode").dispatch("change", { target: { value: "polygon" } });
  drag([[64, 64], [192, 192], [64, 192], [192, 64], [64, 64]]);
  assert.equal($("#boundary-apply").disabled, true);
  assert.match($("#boundary-status").textContent, /self-intersects/);
  assert.equal(documents(), baseline);
  $("#boundary-cancel").click();
  $("#boundary-mode").dispatch("change", { target: { value: "grid" } });

  for (const assetId of model === generic ? ["generic-tile", "generic-block", "generic-marker"]
    : ["floor-cobblestone", "wall-damp-stone", "prop-barrel"]) {
    tool("fill");
    e.asset(assetId);
    drag([[256, 256], [320, 320]]);
    assert.equal(documents(), baseline);
    const preview = state.fillPreview;
    assert.ok(preview.plan.placements.length > 0);
    const expected = preview.plan.updates[0].document;
    activate("#fill-apply", "Space");
    assert.equal(state.fillPreview, null);
    assert.equal(JSON.stringify(state.document), JSON.stringify(expected), "Apply commits the previewed objects exactly");
    assert.equal(state.undo.length, 1);
    assert.ok($("#save-state").classList.contains("dirty"));
    assert.equal(Number($("#map-canvas").dataset.objectCount), expected.objects.length);
    assert.equal($("#object-count").textContent, String(expected.objects.length), "Hierarchy refresh sees the committed objects");
    const scene = state.sections[0].scene;
    assert.equal(scene.document, state.document, "actual scene cache contains the published document");
    assert.ok(scene.canvas.getContext().calls.some(call => call.method === "drawImage" ||
      (call.method === "arc" && call.args[0] >= 256) ||
      (call.method === "fillRect" && call.args[0] === 256)),
    "the actual model renderer emits the applied artwork/shapes");
    const applied = documents();
    $("#undo").click();
    assert.equal(documents(), baseline);
    assert.equal($("#map-canvas").dataset.objectCount, "0");
    assert.equal(state.sections[0].scene.canvas.getContext().calls
      .filter(call => ["drawImage", "arc"].includes(call.method)).length, 0,
    "Undo redraws the empty scene rather than reusing the filled image");
    $("#redo").click();
    assert.equal(documents(), applied);
    assert.equal(state.sections[0].scene.document, state.document);
    $("#undo").click();
    drag([[256, 256], [320, 320]]);
    $("#fill-cancel").click();
    assert.equal(documents(), baseline);
    assert.equal(state.undo.length, 0);
  }

  tool("fill");
  drag([[256, 256], [320, 320]]);
  const preview = state.fillPreview;
  const plan = preview.plan;
  state.layers.props.locked = true;
  $("#fill-apply").click();
  assert.equal(state.fillPreview, preview);
  assert.equal(preview.plan, plan, "validation rejection retains the drawn placements");
  assert.match($("#tool-hint").textContent, /locked/);
  assert.ok($("#status").classList.contains("error"));
  assert.equal(documents(), baseline);
  assert.equal(state.undo.length, 0);
  $("#fill-cancel").click();
  state.layers.props.locked = false;
  tool("fill");
  drag([[2000, 256], [2080, 320]]);
  assert.equal($("#fill-apply").disabled, true);
  assert.match($("#tool-hint").textContent, /missing or unloaded/);
  assert.ok($("#status").classList.contains("error"));
  $("#fill-cancel").click();
  assert.equal(documents(), baseline);
  assert.equal(state.undo.length, 0);

  // A failure after publication must not leave a partial edit or consume Redo.
  for (const kind of ["boundary", "fill"]) {
    tool(kind);
    drag([[64, 64], [160, 160]]);
    const pending = kind === "boundary" ? state.boundaryDraft : state.fillPreview;
    const oldRedo = [...state.redo];
    runInContext(`globalThis.originalDraw = drawDesign;
      drawDesign = () => { throw new Error("Injected artwork redraw failure"); };`, e.sandbox);
    $(`#${kind}-apply`).click();
    assert.equal(documents(), baseline);
    assert.equal(kind === "boundary" ? state.boundaryDraft : state.fillPreview, pending);
    assert.equal(state.undo.length, 0);
    assert.deepEqual([...state.redo], oldRedo);
    assert.ok($("#status").classList.contains("error"));
    assert.match($("#status").textContent, /Injected artwork redraw failure/);
    runInContext("drawDesign = globalThis.originalDraw;", e.sandbox);
    $(`#${kind}-cancel`).click();
  }

  const east = structuredClone(state.document);
  east.id = "apply-east";
  state.sections.push({ sectionId: "east", mapId: east.id, gridX: 1, gridY: 0,
    document: east, savedJson: JSON.stringify(east) });
  e.refreshChrome();
  $("#section-select").dispatch("change", { target: { value: "east" } });
  const bothBefore = documents();
  tool("boundary");
  drag([[64, 64], [160, 160]]);
  $("#boundary-apply").click();
  assert.ok(state.sections[0].document.playableBoundary, "boundary edits the root even when another section is active");
  assert.equal(state.document, east, "the active section is not overwritten by the root boundary");
  assert.equal(state.undo.length, 1);
  $("#undo").click();
  assert.equal(documents(), bothBefore);
  $("#redo").click();
  assert.ok(state.sections[0].document.playableBoundary);
  tool("boundary");
  drag([[64, 64], [160, 160]]);
  $("#boundary-apply").click();
  assert.equal(state.tool, "select");
  assert.equal(state.boundaryDraft, null);
  assert.equal(state.undo.length, 1, "an unchanged boundary closes without another history entry");
  $("#undo").click();
  tool("fill");
  e.asset(model === generic ? "generic-tile" : "floor-cobblestone");
  state.cameraX = 1900;
  drag([[116, 256], [180, 288]]);
  const crossPlan = state.fillPreview.plan;
  assert.equal(crossPlan.updates.length, 2);
  $("#fill-apply").click();
  const bothApplied = documents();
  assert.equal(state.undo.length, 1);
  assert.equal($("#map-canvas").dataset.objectCount, "6");
  for (const section of state.sections) assert.equal(section.scene.document, section.document);
  $("#undo").click();
  assert.equal(documents(), bothBefore);
  $("#redo").click();
  assert.equal(documents(), bothApplied);
  drag([[116, 256], [180, 288]]);
  $("#fill-apply").click();
  assert.equal(state.fillPreview, null);
  assert.equal(state.undo.length, 1, "identical terrain is a no-op, not another history entry");
}
console.log("Main-editor event, Apply, validation, chrome, rendering-command and Undo/Redo checks passed (browser I/O fixture; not CDP acceptance).");

for (const model of [generic, towerProject]) {
  const e = editor(model);
  const { state, $, sandbox } = e;
  state.sections = connectedFixture(state.model).map(section => ({
    ...section, savedJson: JSON.stringify(section.document)
  }));
  state.identity.mapId = state.sections[0].mapId;
  state.activeSectionId = state.sections[1].sectionId;
  state.document = structuredClone(state.sections[1].document);
  state.document.name = "Unsaved adjacent-section change";
  state.sections[1].document = state.document;
  state.selectedIds = new Set([state.document.objects[0].id, state.document.objects[1].id]);
  Object.assign(state, { cameraX: -117, cameraY: 210, zoom: 0.75 });
  const documentsBefore = e.documents();
  const savedBefore = state.sections.map(section => section.savedJson);
  const viewBefore = { cameraX: state.cameraX, cameraY: state.cameraY, zoom: state.zoom,
    sectionId: state.activeSectionId, selection: [...state.selectedIds] };
  let runtime, disposed = false, failMount = false, stoppedTimer = false;
  Object.assign(sandbox, {
    createConnectedPreview, connectedSkin,
    requestAnimationFrame: callback => callback(),
    createLocalGame: async options => {
      assert.equal(options.map, undefined);
      assert.equal(options.world.id, state.identity.mapId);
      assert.equal(options.world.sections.length, 2, "Play includes every selected-level section, not just active");
      runtime = await createLocalGame(options);
      return runtime;
    },
    mountLocalPreview: (_host, game, skinFactory) => {
      assert.equal(game, runtime);
      assert.equal(skinFactory.metadata.acceptedModuleId, "studio-connected-movement");
      if (failMount) throw new Error("Injected connected mount failure");
      const playCanvas = sandbox.document.createElement("canvas");
      playCanvas.clientWidth = 800; playCanvas.clientHeight = 600;
      $("#play-host").append(playCanvas);
      return { dispose() { disposed = true; } };
    }
  });
  sandbox.window.setInterval = () => 1;
  sandbox.window.clearInterval = () => { stoppedTimer = true; };
  sandbox.ResizeObserver = class { observe() {} disconnect() {} };
  e.refreshChrome();
  assert.equal($("#play").disabled, false, "valid connected Play is enabled");
  await $("#play").clickAsync();
  assert.equal(state.play.phase, "playing", $("#play-error-message").textContent);
  assert.equal(runtime.snapshot.player.position.x, -48, "active neighbor does not override the authored root start");
  runtime.sendInput("player", { type: "move", x: 1, y: 0 });
  for (let tick = 0; tick < 24; tick++) runtime.step();
  assert.equal(runtime.snapshot.player.position.x, 48, "main-editor Play is wired to the real connected runtime");
  $("#stop").click();
  assert.ok(disposed && stoppedTimer);
  assert.equal(state.play.phase, "idle");
  assert.deepEqual({ cameraX: state.cameraX, cameraY: state.cameraY, zoom: state.zoom,
    sectionId: state.activeSectionId, selection: [...state.selectedIds] }, viewBefore);
  assert.equal(e.documents(), documentsBefore, "Stop preserves unsaved edits in both sections");
  assert.deepEqual(state.sections.map(section => section.savedJson), savedBefore, "Play never saves designs");
  assert.equal(state.undo.length, 0);
  failMount = true;
  await $("#play").clickAsync();
  assert.equal(state.play.phase, "idle", "a failed mount cleans up the runtime");
  assert.match($("#play-error-message").textContent, /Injected connected mount failure/);
  assert.equal(e.documents(), documentsBefore);
  assert.deepEqual({ cameraX: state.cameraX, cameraY: state.cameraY, zoom: state.zoom,
    sectionId: state.activeSectionId, selection: [...state.selectedIds] }, viewBefore);
}
console.log("Main-editor connected Play/Stop: both models load the complete level, retain unsaved edits, cross the seam, restore pan/zoom/selection and clean up mount failure (real runtime, browser-I/O fixture).");
