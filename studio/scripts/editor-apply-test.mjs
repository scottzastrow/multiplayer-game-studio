import assert from "node:assert/strict";
import { readFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { register } from "node:module";
import { connectedFixture } from "./connected-play-fixtures.mjs";
import { ASSET_CATALOG } from "../../games/astraeum-tower/src/catalog.js";
import * as towerProject from "../../games/astraeum-tower/src/project.js";
import * as generic from "../../games/generic-grid-v1/src/project.js";
import * as towerRender from "../../games/astraeum-tower/src/design-render.js";
import * as boundaries from "../playable-boundaries.js";
import * as terrain from "../world-terrain.js";
import * as paint from "../world-paint.js";
import * as fill from "../world-fill.js";
import * as coordinates from "../world-coordinates.js";
import * as identity from "../project-identity.js";
import { importedAssetDefinition } from "../project-assets.js";

register("./public-runtime-loader.mjs", import.meta.url);
const { createLocalGame } = await import("@multiplayer-game/local-preview");
const { createConnectedPreview, connectedSkin } = await import("../extensions/connected-play.js");
const { createTowerInteractionState, towerEncounterTuning, towerSettings } =
  await import("../../games/astraeum-tower/src/game.js");

// Execute the entire editor, replacing only browser/platform I/O, not its controllers or renderer.
const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const main = (await readFile(new URL("../src/main.js", import.meta.url), "utf8"))
  .replace(/^import\s[\s\S]*?;\r?$/gm, "")
  .replaceAll("import.meta.env", "({ DEV: false })")
  .replaceAll("import.meta.url", JSON.stringify(new URL("../src/main.js", import.meta.url).href))
  .split("\nopenFloor().catch(")[0];
assert.match(html, /id="export-game"/, "Studio offers the Astraeum export action");
assert.match(html, /id="export-dialog"/, "Studio has an export credits dialog");
assert.match(main, /export-credits/, "the export controller loads saved credit suggestions");
assert.match(html, /nearby runes enter automatically/);
assert.match(html, /When all authored slimes are defeated, entering the rune's activation area starts the exit automatically/);
assert.match(html, /Chests open automatically once when you approach within 46 px/);
assert.match(ASSET_CATALOG["prop-stairs-rune"].playNote, /enter the rune's activation area to continue automatically/);
assert.match(ASSET_CATALOG["item-chest"].playNote, /Opens automatically once within 46 px/);

function drawingContext() {
  const calls = [];
  const stack = [];
  const context = { calls, fillStyle: "", strokeStyle: "",
    createRadialGradient() { return { addColorStop() {} }; },
    measureText(text) { return { width: text.length * 8 }; },
    save() { stack.push({ fillStyle: this.fillStyle, strokeStyle: this.strokeStyle }); },
    restore() { Object.assign(this, stack.pop()); }
  };
  for (const method of ["setTransform", "fillRect", "strokeRect", "drawImage", "beginPath", "closePath",
    "moveTo", "lineTo", "stroke", "fill", "arc", "ellipse", "fillText", "setLineDash", "translate", "scale",
    "clearRect", "rotate", "quadraticCurveTo", "rect", "clip"]) {
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
      this.style = {};
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
    addEventListener(type, handler, options) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(handler);
      options?.signal?.addEventListener("abort", () => {
        this.listeners.set(type, this.listeners.get(type).filter(listener => listener !== handler));
      }, { once: true });
    }
    dispatch(type, data = {}) {
      const event = { target: this, preventDefault() { this.defaultPrevented = true; }, ...data };
      for (const handler of this.listeners.get(type) ?? []) handler(event);
      return event;
    }
    dispatchEvent(event) {
      for (const handler of this.listeners.get(event.type) ?? []) handler(event);
      return true;
    }
    setCustomValidity(message) { this.validationMessage = message; }
    reportValidity() {
      return this.querySelectorAll("input").every(input =>
        !input.validationMessage && (!Object.hasOwn(input.attributes, "required") || Boolean(input.value)));
    }
    requestSubmit() {
      if (Object.hasOwn(this.attributes, "novalidate") || this.reportValidity()) this.dispatch("submit");
    }
    click() {
      if (this.tagName === "a") return;
      assert.ok(!this.disabled && !this.closest("[inert]") && !this.closest("[hidden]"),
        `${this.id} must be enabled, visible and non-inert`);
      this.dispatch("click");
    }
    async clickAsync() {
      assert.ok(!this.disabled && !this.closest("[inert]") && !this.closest("[hidden]"));
      for (const handler of this.listeners.get("click") ?? []) await handler({ target: this });
    }
    focus() { document.activeElement = this; }
    remove() {
      if (this.parentElement) this.parentElement.children =
        this.parentElement.children.filter(child => child !== this);
    }
    showModal() { this.open = true; }
    close() { this.open = false; }
    scrollIntoView() {}
    setPointerCapture(pointerId) { this.capturedPointer = pointerId; }
    hasPointerCapture(pointerId) { return this.capturedPointer === pointerId; }
    getBoundingClientRect() { return { left: 0, top: 0, right: 1200, bottom: 900, width: 1200, height: 900 }; }
    getContext() {
      if (!this.context) {
        this.context = drawingContext();
        Object.defineProperty(this.context, "canvas", { value: this });
      }
      return this.context;
    }
  }
  const document = new Element("document");
  document.createElement = tag => new Element(tag);
  document.createTextNode = text => Object.assign(new Element("text"), { textContent: text });
  document.createDocumentFragment = () => new Element("fragment");
  const stack = [document];
  for (const [, text, closing, tag, attributes] of html.matchAll(/([^<]+)|<(\/?)([\w-]+)([^>]*)>/g)) {
    if (text) { stack.at(-1).textContent += text.trim(); continue; }
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
  let fetchHandler = async () => { throw new Error("Unexpected editor fixture request."); };
  const sandbox = createContext({
    ...browser, towerProject, generic, towerRender, towerEncounterTuning, towerSettings,
    ...boundaries, ...terrain, ...paint, ...fill, ...coordinates, ...identity,
    fetch: (...args) => fetchHandler(...args),
    createTowerInteractionState,
    RUNTIME_MAP_CELL_SIZE: 32, RUNTIME_MAX_MAP_DIMENSION: 2048,
    CustomEvent: class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
    ARTWORK_CREDIT: "", structuredClone, TextEncoder, console,
    URL: { createObjectURL: () => "blob:fixture", revokeObjectURL() {} }, setTimeout,
    crypto: { randomUUID: () => "fixture-save-id" },
    localStorage: { getItem() { return null; }, setItem() {} },
    ResizeObserver: class { observe() {} }
  });
  runInContext(`${main}
    globalThis.testEditor = { state, configureEvents, configurePalette, refreshChrome, activateAssetCatalog, render, play, stop, save, transitionExit, updateInspector, fetchDesign, installDesign };
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
  return { ...api, $, tool, asset, drag, key, activate, documents, outline, resetFrame, sandbox,
    setFetch(handler) { fetchHandler = handler; } };
}

{
  const e = editor(towerProject);
  const { $ } = e;
  assert.ok(Object.hasOwn($("#export-form").attributes, "novalidate"));
  let submitted;
  e.setFetch(async (url, options) => {
    assert.match(url, /export-game$/);
    submitted = JSON.parse(options.body);
    return { ok: true, headers: { get: () => "application/zip" }, blob: async () => ({ size: 1 }) };
  });
  $("#export-project").value = "  ";
  $("#export-author").value = "  ";
  $("#export-form").requestSubmit();
  assert.match($("#export-project").validationMessage, /nonblank/);
  assert.match($("#export-author").validationMessage, /nonblank/);
  $("#export-project-suggestion").value = "Project";
  $("#export-author-suggestion").value = "Artist";
  $("#export-project-suggestion").dispatch("change");
  $("#export-author-suggestion").dispatch("change");
  assert.equal($("#export-project").validationMessage, "");
  assert.equal($("#export-author").validationMessage, "");
  $("#export-form").requestSubmit();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(submitted, { project: "Project", author: "Artist", course: "" });
  assert.equal($("#export-dialog").open, false);
}

{
  const e = editor(towerProject);
  const { state, $ } = e;
  const saved = state.sections[0].savedJson;
  const chest = towerProject.createDesignObject("inspector-chest", "item-chest",
    { x: 176, y: 152 }, 0);
  state.document.objects.push(chest);
  state.sections[0].document = state.document;
  state.selectedId = chest.id;
  state.selectedIds = new Set([chest.id]);
  e.refreshChrome();
  assert.equal($("#chest-inspector").hidden, false, "supported chest tiers appear in the Inspector");
  assert.equal($("#chest-tier").value, "normal", "new chests default to the original normal tier");
  assert.match($("#chest-tier-details").textContent, /2-4 items/);
  $("#chest-tier").dispatch("change", { target: { value: "treasure" } });
  assert.equal(state.document.objects.find(object => object.id === chest.id).interaction.tier, "treasure");
  assert.match($("#chest-tier-details").textContent, /4-6 items/);
  assert.equal(state.sections[0].savedJson, saved, "Inspector changes remain an unsaved draft");
  assert.equal($("#save-state").classList.contains("dirty"), true);
}
console.log("Chest Inspector exposes the original normal/treasure loot tiers without changing the saved baseline.");

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
  const source = structuredClone(state.document);
  const sourceJson = JSON.stringify(source);
  const modelId = model === generic ? generic.MODEL : identity.ASTRAEUM_MODEL;
  const mapId = "map-event-level";
  const sectionId = "section-event-level";
  const document = model.createEmptyLevelDocument(mapId, "UI-created empty level");
  const requests = [];
  const response = value => ({ ok: true, status: 200, async json() { return value; } });
  e.setFetch(async (url, options = {}) => {
    requests.push({ url, options });
    if (url === "/api/projects/apply-project/levels" && options.method === "POST") {
      return response({ mapId, startingMapId: "apply-map" });
    }
    if (url === `/api/projects/apply-project/maps/${mapId}`) {
      return response({ projectId: "apply-project", mapId, model: modelId, document });
    }
    if (url === "/api/projects/apply-project/assets") return response({ assets: [] });
    if (url === `/api/projects/apply-project/levels/${mapId}/sections`) {
      return response({ projectId: "apply-project", levelMapId: mapId, model: modelId, revision: 0,
        sections: [{ sectionId, mapId, gridX: 0, gridY: 0, revision: 0, document }],
        archivedSections: [] });
    }
    if (url === "/api/projects/apply-project/levels") {
      return response({ startingMapId: "apply-map", levels: [
        { mapId: "apply-map", name: "Apply fixture", starting: true, supported: true },
        { mapId, name: document.name, supported: true }
      ] });
    }
    throw new Error(`Unexpected Add Level event request: ${url}`);
  });
  $("#level-add").click();
  $("#level-name").value = document.name;
  $("#level-form").dispatch("submit");
  for (let attempt = 0; attempt < 20 && state.levelBusy; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(state.levelBusy, false, `${modelId} Add Level event completes`);
  assert.equal($("#level-dialog").open, false);
  const createRequest = requests.find(request => request.options.method === "POST");
  assert.ok(createRequest, `${modelId} Add Level event sends its request`);
  assert.deepEqual(JSON.parse(createRequest.options.body),
    { action: "add", mapId: "apply-map", name: "UI-created empty level" });
  assert.equal(JSON.stringify(source), sourceJson, "the current source draft remains unchanged");
  assert.equal(state.identity.mapId, mapId);
  assert.equal(state.sections.length, 1);
  assert.deepEqual(state.document.bounds, { width: 2048, height: 2048 });
  assert.deepEqual(state.document.objects, []);
  await e.play();
  assert.equal($("#play-error").hidden, false);
  assert.match($("#play-error-message").textContent, /start/i,
    `${modelId} Play explains that an empty level needs a player start`);
}
console.log("Registered Add Level form events create one empty full-size section for both models; Play reports missing starts.");

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
  const existingSectionIds = state.sections.map(section => section.sectionId);
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
  const newSection = () => state.sections.find(section => section.isNew);
  const addedSectionId = newSection().sectionId;
  const addedSectionMapId = newSection().mapId;
  assert.equal(requests.length, 0, "Confirm changes only the draft; persistence waits for Save");
  assert.equal(state.sections.length, 3);
  assert.equal(state.sectionRevision, 0, "draft addition does not advance the persisted baseline");
  assert.equal(newSection().isNew, true);
  assert.equal($("#save-state").classList.contains("dirty"), true);
  assert.equal(JSON.stringify(state.sections.filter(s => existingSectionIds.includes(s.sectionId)).map(s => s.document)), original);
  assert.equal(JSON.stringify(state.sections.filter(s => existingSectionIds.includes(s.sectionId))
    .map(s => [s.gridX, s.gridY])), positions);
  assert.equal(state.sections.find(section => section.sectionId === "east").document.name, dirty.name,
    "response cannot overwrite unsaved content");
  assert.notEqual(state.sections.find(section => section.sectionId === "east").savedJson,
    JSON.stringify(state.sections.find(section => section.sectionId === "east").document));
  assert.equal(newSection().document.objects.length, 0);
  assert.equal(state.undo.length, 1);
  $("#undo").click();
  assert.equal(state.sections.length, 2, "Undo removes a newly added draft section");
  assert.equal($("#save-state").classList.contains("dirty"), true, "Undo preserves unrelated unsaved edits");
  $("#redo").click();
  assert.equal(state.sections.length, 3, "Redo restores the draft section");
  assert.equal(newSection().document.objects.length, 0);
  assert.deepEqual([state.cameraX, state.cameraY, state.zoom], view);
  assert.equal($("#section-placement").hidden, true);
  assert.equal(state.sectionPlacementDirection, null);
  assert.equal(side("north").disabled, true, "the newly occupied side becomes unavailable");
  e.sandbox.fetch = async (address, options = {}) => {
    if (options.method !== "PUT") return { ok: true, json: async () => ({ levels: [], startingMapId: "apply-map" }) };
    requests.push({ address, ...options });
    const body = JSON.parse(options.body);
    const saved = body.sections.map(item => ({
      ...state.sections.find(section => section.sectionId === item.sectionId),
      ...item, revision: item.revision + 1
    }));
    return { ok: true, json: async () => ({ projectId: "apply-project", levelMapId: "apply-map",
      model: state.model, revision: 1, sections: saved, archivedSections: [] }) };
  };
  assert.equal(await e.save(), true);
  assert.equal(requests.length, 1, "Save sends one atomic section request");
  assert.equal(requests[0].method, "PUT");
  const submitted = JSON.parse(requests[0].body);
  const submittedAddition = submitted.sections.find(section => section.sectionId === addedSectionId);
  assert.deepEqual({ sectionId: submittedAddition.sectionId, mapId: submittedAddition.mapId,
    gridX: submittedAddition.gridX, gridY: submittedAddition.gridY, revision: submittedAddition.revision },
  { sectionId: addedSectionId, mapId: addedSectionMapId, gridX: 1, gridY: -1, revision: 0 });
  assert.equal(submitted.sections.find(section => section.sectionId === "east").document.name, dirty.name,
    "Save includes unrelated unsaved edits");
  assert.equal(state.sections.find(section => section.sectionId === addedSectionId).isNew, false);
  assert.equal($("#save-state").classList.contains("saved"), true);
  $("#undo").click();
  assert.equal(state.archivedSections.at(-1).sectionId, addedSectionId,
    "Undo after Save archives the section instead of deleting persisted content");
  assert.equal($("#save-state").classList.contains("dirty"), true);
  $("#redo").click();
  assert.equal($("#save-state").classList.contains("saved"), true);
}
console.log("Direct Add Section wiring: selected anchor, direction preview, Cancel, draft-only Confirm, empty creation, Undo/Redo, atomic Save and post-save archive history passed in both models (browser I/O fixture).");

for (const model of [generic, towerProject]) {
  const e = editor(model);
  const { state, $ } = e;
  assert.equal($("#section-remove").disabled, true, "the only section cannot be removed");
  const east = structuredClone(state.document);
  east.id = "east-map";
  east.name = "East room";
  east.objects.push(model === generic
    ? generic.createDesignObject("start", "generic-player", { x: 128, y: 128 }, 0)
    : towerProject.createDesignObject("start", "spawn-aries", { x: 144, y: 144 }, 0));
  state.sections.push({ sectionId: "east", mapId: east.id, gridX: 1, gridY: 0,
    document: east, savedJson: JSON.stringify(east), revision: 0 });
  state.sections[0].document = state.document = { ...state.document, name: "Unsaved root" };
  e.refreshChrome();
  $("#section-select").dispatch("change", { target: { value: "east" } });
  const before = e.documents();
  const view = [state.cameraX, state.cameraY, state.zoom];
  $("#section-remove").click();
  assert.match($("#section-removal-details").textContent, /East room.*\(1, 0\).*1 object/);
  assert.match($("#section-removal-warning").textContent, /player start.*not be moved/);
  $("#section-remove-cancel").click();
  assert.equal(e.documents(), before);
  assert.equal(state.undo.length, 0);
  $("#section-remove").click();
  $("#section-remove-confirm").click();
  assert.equal(state.sections.length, 1);
  assert.equal(state.sections[0].document.name, "Unsaved root");
  assert.equal(state.archivedSections[0].document, east);
  assert.deepEqual([state.cameraX, state.cameraY, state.zoom], view);
  assert.equal(state.undo.length, 1);
  assert.equal($("#section-add").disabled, false, "Add Section remains available for an unsaved membership draft");
  runInContext(`globalThis.originalRefreshChrome = refreshChrome;
    globalThis.refreshCount = 0;
    refreshChrome = (...args) => {
      if (++globalThis.refreshCount === 2) throw new Error("Injected history refresh failure");
      return globalThis.originalRefreshChrome(...args);
    };`, e.sandbox);
  $("#undo").click();
  assert.equal(state.sections.length, 1, "failed Undo restores membership");
  assert.equal(state.archivedSections[0].document, east);
  assert.equal(state.undo.length, 1, "failed Undo retains its history entry");
  assert.equal(state.redo.length, 0, "failed Undo does not create Redo");
  runInContext("refreshChrome = globalThis.originalRefreshChrome", e.sandbox);
  $("#undo").click();
  assert.equal(e.documents(), before);
  assert.equal(state.activeSectionId, "east");
  assert.equal(state.archivedSections.length, 0);
  $("#redo").click();
  assert.equal(state.archivedSections[0].document, east);
  $("#undo").click();
  const boundary = boundaries.createGridRectangleBoundary({ x: 64, y: 0 }, { x: 66, y: 2 },
    state.sections).boundary;
  state.sections[0].document = { ...state.sections[0].document, playableBoundary: boundary };
  e.refreshChrome();
  $("#section-remove").click();
  assert.match($("#section-removal-warning").textContent, /custom boundary includes this section/);
  assert.equal($("#section-remove-confirm").disabled, true);
  $("#section-remove-cancel").click();
  const unaffected = boundaries.createGridRectangleBoundary({ x: 1, y: 1 }, { x: 3, y: 3 },
    state.sections).boundary;
  state.sections[0].document = { ...state.sections[0].document, playableBoundary: unaffected };
  e.refreshChrome();
  $("#section-remove").click();
  assert.match($("#section-removal-warning").textContent, /preserved unchanged/);
  $("#section-remove-confirm").click();
  assert.equal(JSON.stringify(state.sections[0].document.playableBoundary), JSON.stringify(unaffected));
  $("#undo").click();
  delete state.sections[0].document.playableBoundary;
  state.archivedSections = Array.from({ length: 16 }, (_, index) => ({
    sectionId: `archived-${index}`, mapId: `archived-map-${index}`, gridX: index + 10, gridY: 0,
    document: structuredClone(east), savedJson: JSON.stringify(east), savedArchived: true
  }));
  e.refreshChrome();
  assert.equal($("#section-remove").disabled, true, "archive capacity prevents destructive removal");
  assert.match($("#section-remove").title, /16-section retained archive limit/);
  state.archivedSections = [];
  $("#section-select").dispatch("change", { target: { value: "root" } });
  e.refreshChrome();
  $("#section-remove").click();
  $("#section-remove-confirm").click();
  assert.equal(state.sections[0].sectionId, "east", "the original section can be removed");
  assert.equal(state.archivedSections[0].sectionId, "root");
  assert.equal(state.archivedSections[0].document.name, "Unsaved root");
  assert.equal($("#play-limitation").hidden, false, "an archived root uses the limited connected preview");
  let previewArgs;
  e.sandbox.createConnectedPreview = (sections, options) => {
    previewArgs = { sections, options };
    throw new Error("Stop after routing assertion");
  };
  await e.play();
  assert.equal(previewArgs.sections.length, 1);
  assert.equal(previewArgs.sections[0].sectionId, "east");
  assert.equal(previewArgs.options.rootDocument, state.archivedSections[0].document);
  $("#undo").click();
  assert.equal(state.activeSectionId, "root");
  assert.equal(state.sections.find(section => section.sectionId === "root").document.name, "Unsaved root");
}
console.log("Remove Section controls: confirmation, starts/boundary warnings, cancellation, both section identities, history and unsaved edits passed in both models (browser I/O fixture).");

for (const model of [generic, towerProject]) {
  const e = editor(model);
  const { state, $ } = e;
  state.sections[0].revision = 0;
  const east = structuredClone(state.document);
  east.id = "east-map";
  east.name = "Unsaved east";
  state.sections.push({ sectionId: "east", mapId: east.id, gridX: 1, gridY: 0,
    document: east, savedJson: JSON.stringify({ ...east, name: "Saved east" }), revision: 0 });
  e.refreshChrome();
  $("#section-remove").click();
  $("#section-remove-confirm").click();
  const before = [...state.sections, ...state.archivedSections];
  e.sandbox.fetch = async (address, options = {}) => {
    if (options.method !== "PUT") return { ok: true, json: async () => ({ levels: [], startingMapId: "apply-map" }) };
    const body = JSON.parse(options.body);
    const stored = items => items.map(item => ({
      ...before.find(section => section.sectionId === item.sectionId),
      document: item.document, revision: item.revision + 1
    }));
    return { ok: true, json: async () => ({ projectId: "apply-project", levelMapId: "apply-map",
      model: state.model, revision: 1, sections: stored(body.sections), archivedSections: stored(body.archivedSections) }) };
  };
  assert.equal(await e.save(), true);
  assert.equal(state.archivedSections[0].document.name, "Apply fixture");
  assert.equal(state.sections[0].document.name, "Unsaved east");
  assert.equal($("#save-state").classList.contains("saved"), true);
  $("#undo").click();
  assert.equal(state.sections.length, 2, "undo after save restores the removed section");
  assert.equal($("#save-state").classList.contains("dirty"), true, "undoing saved removal marks membership dirty");
  $("#redo").click();
  assert.equal(state.sections.length, 1);
  assert.equal($("#save-state").classList.contains("saved"), true, "redo returns to the saved membership");
  assert.equal($("#section-add").disabled, false, "Add Section is available after a saved removal");
  $("#section-add").click();
  $('[data-direction="west"]').click();
  await $("#section-confirm").clickAsync();
  assert.equal(state.sections.length, 2, "Add Section may reuse the saved removal's position");
  assert.equal(state.sections.find(section => section.isNew).gridX, 0);
  assert.equal(state.sections.find(section => section.isNew).gridY, 0);
  $("#undo").click();
  assert.equal(state.sections.length, 1, "Undo removes the unpersisted section draft");
  assert.equal(state.archivedSections[0].sectionId, "root");
  assert.equal($("#save-state").classList.contains("saved"), true,
    "undoing an unsaved addition returns to the persisted removal state");
  $("#redo").click();
  assert.equal(state.sections.length, 2, "Redo restores the unsaved section without evicting the archived root");
  assert.equal(state.archivedSections[0].sectionId, "root");
}
console.log("Remove Section save and Add Section draft Undo/Redo preserve archived content in both models.");

{
  const e = editor(generic);
  const { state, $ } = e;
  state.sections[0].revision = 0;
  const east = { ...structuredClone(state.document), id: "east-map" };
  state.sections.push({ sectionId: "east", mapId: east.id, gridX: 1, gridY: 0,
    document: east, savedJson: JSON.stringify(east), revision: 0 });
  e.refreshChrome();
  $("#section-remove").click();
  $("#section-remove-confirm").click();
  const original = [...state.sections, ...state.archivedSections];
  const requests = [];
  e.sandbox.fetch = async (address, options = {}) => {
    if (options.method !== "PUT") return { ok: true, json: async () => ({ levels: [], startingMapId: "apply-map" }) };
    requests.push(JSON.parse(options.body));
    if (requests.length === 1) throw new Error("lost response");
    const saved = items => items.map(item => ({ ...original.find(section => section.sectionId === item.sectionId),
      document: item.document, revision: item.revision + 1 }));
    return { ok: true, json: async () => ({ projectId: "apply-project", levelMapId: "apply-map",
      model: state.model, revision: 1, sections: saved(requests[1].sections), archivedSections: saved(requests[1].archivedSections) }) };
  };
  assert.equal(await e.save(), false);
  assert.ok(state.pendingSectionSave, "an uncertain save retains its operation for retry");
  assert.equal($("#section-add").disabled, true);
  $("#undo").click();
  assert.equal(state.sections.length, 2);
  assert.equal(await e.save(), false, "confirming the earlier save does not discard the later undo");
  assert.deepEqual(requests[1], requests[0], "the same operation and original payload are retried");
  assert.equal(state.pendingSectionSave, null);
  assert.equal(state.sections.length, 2);
  assert.equal($("#save-state").classList.contains("dirty"), true);
  assert.equal(state.sections.find(section => section.sectionId === "root").savedArchived, true);
}
console.log("Lost-save response retries the same operation and preserves later undo as unsaved membership.");

for (const failure of [
  { status: 400, message: "Object stairs-rune-33-19 has unknown fields: exit." },
  { status: 409, message: "Level sections changed since they were opened." },
  { status: 503, message: "Service unavailable." },
  { message: "Network connection lost." }
]) {
  const e = editor(towerProject);
  const { state, $ } = e;
  state.sectionRevision = 4;
  state.sections[0].revision = 4;
  state.sections[0].document = state.document = { ...state.document, name: "Keep unsaved exit draft" };
  e.refreshChrome();
  const draft = e.documents(), undo = state.undo.length, revision = state.sectionRevision;
  const requests = [];
  e.sandbox.fetch = async (address, options = {}) => {
    requests.push(JSON.parse(options.body));
    if (!failure.status) throw new Error(failure.message);
    return { ok: false, status: failure.status, json: async () => ({ error: failure.message }) };
  };
  await $("#save").clickAsync();
  assert.equal(requests.length, 1);
  assert.equal($("#save-error").hidden, false);
  assert.ok($("#save-error").textContent.includes(failure.message));
  if (failure.status) assert.ok($("#save-error").textContent.includes(`HTTP ${failure.status}`));
  assert.equal($("#save-state").textContent, "Save failed - unsaved");
  assert.equal($("#save-state").classList.contains("error"), true);
  assert.equal(e.documents(), draft);
  assert.equal(state.undo.length, undo);
  assert.equal(state.sectionRevision, revision);
  assert.equal(Boolean(state.pendingSectionSave), !failure.status || failure.status >= 500);
  $("#show-grid").dispatch("change", { target: { checked: false } });
  e.refreshChrome();
  assert.equal($("#save-error").hidden, false, "refresh and unrelated UI events cannot hide the Save error");
  e.sandbox.fetch = async (address, options = {}) => {
    if (options.method !== "PUT") return { ok: true, json: async () => ({ levels: [] }) };
    const body = JSON.parse(options.body);
    if (!failure.status || failure.status >= 500) assert.deepEqual(body, requests[0]);
    return { ok: true, json: async () => ({
      projectId: state.identity.projectId, levelMapId: state.identity.mapId, model: state.model,
      revision: revision + 1, archivedSections: [],
      sections: state.sections.map(section => ({ ...section, revision: section.revision + 1,
        document: body.sections.find(item => item.sectionId === section.sectionId).document }))
    }) };
  };
  assert.equal(await e.save(), true);
  assert.equal($("#save-error").hidden, true);
  assert.equal($("#save-error").textContent, "");
  assert.equal($("#save-state").classList.contains("saved"), true);
}

for (const model of [generic, towerProject]) {
  const e = editor(model);
  const { state, $ } = e;
  state.sections[0].revision = 0;
  $("#section-add").click();
  $('[data-direction="north"]').click();
  await $("#section-confirm").clickAsync();
  const added = state.sections.find(section => section.isNew);
  const requests = [];
  e.sandbox.fetch = async (address, options = {}) => {
    if (options.method !== "PUT") return { ok: true, json: async () => ({ levels: [], startingMapId: "apply-map" }) };
    const body = JSON.parse(options.body);
    requests.push(body);
    if (requests.length === 1) throw new Error("lost response");
    const saved = body.sections.map(item => ({
      ...state.sections.find(section => section.sectionId === item.sectionId),
      document: item.document, revision: item.revision + 1
    }));
    return { ok: true, json: async () => ({ projectId: "apply-project", levelMapId: "apply-map",
      model: state.model, revision: 1, sections: saved, archivedSections: [] }) };
  };
  assert.equal(await e.save(), false);
  $("#undo").click();
  assert.equal(state.sections.length, 2, "uncertain addition cannot disappear before reconciliation");
  assert.equal(state.undo.length, 1, "rejected Undo keeps its history");
  $("#section-select").dispatch("change", { target: { value: added.sectionId } });
  $("#section-remove").click();
  assert.equal($("#section-remove-confirm").disabled, true);
  assert.match($("#section-removal-warning").textContent, /Retry the pending save/);
  $("#section-remove-cancel").click();
  assert.equal(await e.save(), true);
  assert.deepEqual(requests[1], requests[0]);
  $("#undo").click();
  assert.equal(state.archivedSections[0].sectionId, added.sectionId,
    "Undo after reconciliation preserves the saved section in the archive");
}

{
  const e = editor(generic);
  const { state, $ } = e;
  const east = { ...structuredClone(state.document), id: "east-map" };
  state.sections.push({ sectionId: "east", mapId: east.id, gridX: 1, gridY: 0,
    document: east, savedJson: JSON.stringify(east), revision: 0 });
  e.refreshChrome();
  $("#section-remove").click();
  $("#section-remove-confirm").click();
  $("#undo").click();
  state.archivedSections = Array.from({ length: 16 }, (_, index) => ({
    sectionId: `archive-${index}`, mapId: `archive-map-${index}`, gridX: index + 10, gridY: 0,
    document: structuredClone(east), savedJson: JSON.stringify(east), savedArchived: true
  }));
  e.refreshChrome();
  $("#redo").click();
  assert.equal(state.sections.length, 2);
  assert.equal(state.archivedSections.length, 16, "Redo cannot overflow or discard retained archive contents");
  assert.equal(state.redo.length, 1, "rejected Redo retains its history entry");
}

for (const model of [generic, towerProject]) {
  const e = editor(model);
  const { state, $ } = e;
  state.sectionRevision = 7;
  state.sections[0].revision = 2;
  const east = { ...structuredClone(state.document), id: "east-map", name: "Unrelated unsaved edit" };
  state.sections.push({ sectionId: "east", mapId: east.id, gridX: 1, gridY: 0, revision: 3,
    document: east, savedJson: JSON.stringify({ ...east, name: "Saved east" }) });
  e.refreshChrome();
  $("#section-remove").click();
  $("#section-remove-confirm").click();
  assert.equal(state.sectionRevision, 7, "local removal does not advance the server baseline");
  const draft = JSON.stringify({ active: state.sections, archived: state.archivedSections });
  let submitted;
  e.sandbox.fetch = async (address, options = {}) => {
    assert.equal(options.method, "PUT");
    submitted = JSON.parse(options.body);
    return { ok: false, status: 409, json: async () => ({
      error: "Level sections changed since they were opened. Reopen before saving."
    }) };
  };
  assert.equal(await e.save(), false);
  assert.equal(submitted.revision, 7);
  assert.deepEqual(submitted.sections.map(section => section.revision), [3]);
  assert.deepEqual(submitted.archivedSections.map(section => section.revision), [2]);
  assert.equal(JSON.stringify({ active: state.sections, archived: state.archivedSections }), draft,
    "a real conflict retains the complete local draft and membership");
  assert.equal(state.sectionRevision, 7);
  assert.equal($("#save-state").classList.contains("dirty"), true);
  $("#undo").click();
  let undoRequest;
  e.sandbox.fetch = async (address, options = {}) => {
    if (options.method !== "PUT") return { ok: true, json: async () => ({ levels: [], startingMapId: "apply-map" }) };
    undoRequest = JSON.parse(options.body);
    const saved = undoRequest.sections.map(item => ({
      ...state.sections.find(section => section.sectionId === item.sectionId),
      document: item.document, revision: item.revision + 1
    }));
    return { ok: true, json: async () => ({ projectId: "apply-project", levelMapId: "apply-map",
      model: state.model, revision: 8, sections: saved, archivedSections: [] }) };
  };
  assert.equal(await e.save(), true);
  assert.equal(undoRequest.revision, 7);
  assert.equal(undoRequest.sections.length, 2);
  assert.equal(undoRequest.archivedSections.length, 0);
  assert.equal(state.sections.find(section => section.sectionId === "east").document.name, "Unrelated unsaved edit");
}
console.log("Removal baseline, conflict draft preservation and undo-before-save passed in both models.");

for (const model of [generic, towerProject]) {
  const e = editor(model);
  const { state, $ } = e;
  const baselineRevision = state.sectionRevision;
  $("#section-add").click();
  $('[data-direction="north"]').click();
  await $("#section-confirm").clickAsync();
  const draft = JSON.stringify({ sections: state.sections, archivedSections: state.archivedSections });
  const history = [...state.undo];
  e.sandbox.fetch = async (address, options = {}) => options.method === "PUT"
    ? { ok: false, status: 409, json: async () => ({ error: "Concurrent level update." }) }
    : { ok: true, json: async () => ({ levels: [], startingMapId: "apply-map" }) };
  assert.equal(await e.save(), false);
  assert.equal(state.sectionRevision, baselineRevision);
  assert.equal(JSON.stringify({ sections: state.sections, archivedSections: state.archivedSections }), draft,
    "failed Add Save retains every draft document and membership");
  assert.equal(state.undo.length, history.length, "failed Add Save retains history depth");
  assert.equal(state.undo[0], history[0], "failed Add Save retains the original history entry");
  assert.equal($("#save-state").classList.contains("dirty"), true);
  $("#undo").click();
  assert.equal(state.sections.length, 1, "Undo remains available after a failed Save");
  $("#redo").click();
  assert.equal(state.sections.length, 2, "Redo remains available after a failed Save");
  assert.ok(state.sections.some(section => section.isNew), "Redo restores the failed-save addition as a draft");
}
console.log("Failed Add Save retains the draft and Undo/Redo history in both models.");

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
    assert.equal($("#paint-brush-size").disabled, false);
    assert.match($("#paint-support").textContent, /Asset footprint: 32 x 32/);
    e.drag([[640, 640], [800, 640]]);
    assert.equal(state.sections.reduce((sum, section) => sum +
      section.document.objects.filter(object => object.type === "wall").length, 0), (size + 5) * size,
    "explicit static walls repeat at their actual footprint using the selected brush size");
    e.tool("select");
    assert.equal($("#paint-options").hidden, true);
  }
}
console.log("Paint: all four brush sizes, selected thumbnails, cursor footprints, cross-section strokes, locks, hidden/missing rejection and one-action Undo/Redo passed in both models.");

for (const model of [generic, towerProject]) {
  const e = editor(model);
  const { state, $ } = e;
  const id = model === generic ? "generic-marker" : "prop-barrel";
  state.paintSeed = 77;
  const east = structuredClone(state.document);
  east.id = "east-map";
  state.sections.push({ sectionId: "east", mapId: east.id, gridX: 1, gridY: 0,
    document: east, revision: 0, savedJson: JSON.stringify(east) });
  const card = $(`.asset-card[data-asset-id="${id}"]`);
  card.dispatch("pointerdown", { button: 0, clientX: 0, clientY: 0, pointerId: 2 });
  card.dispatch("pointerup", { clientX: 0, clientY: 0, pointerId: 2 });
  assert.equal(state.paintDensity, 100);
  assert.equal(state.paintSpacing, 0);
  $("#paint-brush-size").dispatch("change", { target: { value: "4" } });
  $("#paint-density").dispatch("change", { target: { value: "31" } });
  // Barrel's 22px width + 10px gap divides the seam; generic shapes retain the 32px lattice.
  $("#paint-spacing").dispatch("change", { target: { value: model === generic ? "0" : "10" } });
  const canvas = $("#map-canvas");
  const pointer = (type, x = 2017, y = 337) =>
    canvas.dispatch(type, { button: 0, pointerId: 1, clientX: x, clientY: y });
  const before = e.documents();
  pointer("pointermove");
  const hover = canvas.dataset.paintPlacements;
  pointer("pointerdown");
  assert.equal(canvas.dataset.paintPlacements, hover, "hover and pointer-down use the same seed and placements");
  assert.equal($("#paint-density").disabled, true);
  assert.equal($("#paint-spacing").disabled, true);
  $("#paint-density").dispatch("change", { target: { value: "100" } });
  assert.equal(state.pointerStart.density, 31, "probability is latched for the stroke");
  pointer("pointermove", 2113);
  const visited = canvas.dataset.paintPlacements;
  pointer("pointermove");
  pointer("pointermove", 2113);
  assert.equal(canvas.dataset.paintPlacements, visited, "repeated pointer passes neither reroll nor stack");
  const gesture = state.pointerStart;
  const plan = paint.planPaintStroke(state.sections, gesture.stroke.cells.values(), {
    assetId: id, assetCatalog: model.ASSET_CATALOG, layers: state.layers,
    createObject: model === generic
      ? (id, asset, transform, order) => model.createDesignObject(id, asset, transform, order)
      : model.createDesignObject,
    validate: model.validateFloorDocument, density: gesture.density, spacing: gesture.spacing, seed: gesture.seed
  });
  assert.ok(plan.placements.length > 0);
  assert.equal(plan.updates.length, 2);
  assert.equal(canvas.dataset.paintPlacements, JSON.stringify(plan.placements));
  assert.equal(e.documents(), before, "the entire pointer gesture remains draft-preview only");
  pointer("pointerup", 2113);
  const after = e.documents();
  for (const update of plan.updates) assert.equal(
    JSON.stringify(state.sections.find(section => section.sectionId === update.sectionId).document),
    JSON.stringify(update.document), "committed documents exactly equal the rendered preview's plan");
  assert.equal(state.undo.length, 1);
  assert.equal($("#save-state").classList.contains("dirty"), true);
  $("#undo").click();
  assert.equal(e.documents(), before);
  $("#redo").click();
  assert.equal(e.documents(), after);
  pointer("pointerdown", 2017, 593);
  pointer("pointermove", 2113, 593);
  e.key("#map-canvas", "Escape");
  pointer("pointerup", 2113, 593);
  assert.equal(e.documents(), after);
  assert.equal(state.undo.length, 1, "Escape cancellation never publishes partial documents/history");
  pointer("pointerdown", 2017, 593);
  pointer("pointermove", 2113, 593);
  state.layers.props.locked = true;
  pointer("pointerup", 2113, 593);
  assert.equal(e.documents(), after, "a lock after preview atomically rejects the whole cross-section stroke");
  assert.equal(state.undo.length, 1);
  assert.match($("#status").textContent, /unlock/);
  state.layers.props.locked = false;
  $("#paint-density").dispatch("change", { target: { value: "101" } });
  assert.equal(state.paintDensity, 31);
  assert.match($("#status").textContent, /Density/);
  $("#paint-spacing").dispatch("change", { target: { value: "-1" } });
  assert.match($("#status").textContent, /Minimum spacing/);
  let savedBody = null;
  e.sandbox.fetch = async (address, options = {}) => {
    if (options.method !== "PUT") return { ok: true, json: async () => ({ levels: [], startingMapId: "apply-map" }) };
    savedBody = JSON.parse(options.body);
    return { ok: true, json: async () => ({ projectId: "apply-project", levelMapId: "apply-map",
      model: state.model, revision: 1, archivedSections: [],
      sections: savedBody.sections.map(item => ({
        ...state.sections.find(section => section.sectionId === item.sectionId), ...item, revision: 1
      })) }) };
  };
  assert.equal(await e.save(), true);
  assert.equal(savedBody.sections.length, 2, "Save sends every section together");
  assert.equal($("#save-state").classList.contains("saved"), true);
  assert.equal(e.documents(), after);
  $("#undo").click();
  assert.equal(e.documents(), before, "Undo still restores the whole Paint stroke after Save");
  $("#redo").click();
  assert.equal(e.documents(), after);

  const singleId = model === generic ? "generic-player" : "spawn-slime";
  const single = $(`.asset-card[data-asset-id="${singleId}"]`);
  single.dispatch("pointerdown", { button: 0, clientX: 0, clientY: 0, pointerId: 2 });
  single.dispatch("pointerup", { clientX: 0, clientY: 0, pointerId: 2 });
  assert.equal($("#paint-brush-size").disabled, true);
  assert.equal($("#paint-density").disabled, true);
  assert.equal($("#paint-spacing").disabled, true);
  assert.match($("#paint-support").textContent, /single placement only/);
  const count = state.sections.reduce((sum, section) => sum + section.document.objects.length, 0);
  e.drag([[640, 640], [800, 640], [960, 640]]);
  assert.equal(state.sections.reduce((sum, section) => sum + section.document.objects.length, 0), count + 1,
    "characters/spawns keep single-click placement even at a large brush size");
}
console.log("Paint density/spacing: real UI controls, deterministic pointer previews, exact commit agreement, cross-section retracing, locks, Escape, Save and single-action Undo/Redo passed (event/render fixture; not native browser).");

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
  const connectedSkinModes = [];
  Object.assign(sandbox, {
    createConnectedPreview,
    connectedSkin: (preview, artwork, mode) => {
      if (state.model === identity.ASTRAEUM_MODEL) connectedSkinModes.push(mode);
      return connectedSkin(preview, artwork, mode);
    },
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
      assert.equal(skinFactory.metadata.acceptedModuleId,
        state.model === identity.ASTRAEUM_MODEL ? "astraeum-tower-floor-one" : "studio-connected-movement");
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
  const modes = model === towerProject
    ? ["keyboard-only", "keyboard-mouse", "game-controller"]
    : [null];
  for (const mode of modes) {
    if (mode) {
      const selector = $("#player-control-mode");
      selector.value = mode;
      selector.dispatch("change", { target: selector });
    }
    await $("#play").clickAsync();
    assert.equal(state.play.phase, "playing", $("#play-error-message").textContent);
    const towerMode = state.model === identity.ASTRAEUM_MODEL;
    const position = () => towerMode
      ? { x: runtime.snapshot.player.x, y: runtime.snapshot.player.y }
      : runtime.snapshot.player.position;
    assert.equal(position().x, -48, "active neighbor does not override the authored root start");
    runtime.sendInput(towerMode ? "aries" : "player", { type: "move", x: 1, y: 0 });
    for (let tick = 0; tick < 24; tick++) runtime.step();
    assert.equal(position().x, 48, "main-editor Play crosses the seam in the real connected runtime");
    if (mode) assert.equal(connectedSkinModes.at(-1), mode, `Play forwards ${mode} to connectedSkin`);
    $("#stop").click();
    assert.ok(disposed && stoppedTimer);
    assert.equal(state.play.phase, "idle");
    assert.deepEqual({ cameraX: state.cameraX, cameraY: state.cameraY, zoom: state.zoom,
      sectionId: state.activeSectionId, selection: [...state.selectedIds] }, viewBefore);
    assert.equal(e.documents(), documentsBefore, "Stop preserves unsaved edits in both sections");
    assert.deepEqual(state.sections.map(section => section.savedJson), savedBefore, "Play never saves designs");
    assert.equal(state.undo.length, 0);
  }
  if (model === towerProject) assert.deepEqual(connectedSkinModes, modes,
    "all Player Settings control modes reach the reused Tower skin");
  failMount = true;
  await $("#play").clickAsync();
  assert.equal(state.play.phase, "idle", "a failed mount cleans up the runtime");
  assert.match($("#play-error-message").textContent, /Injected connected mount failure/);
  assert.equal(e.documents(), documentsBefore);
  assert.deepEqual({ cameraX: state.cameraX, cameraY: state.cameraY, zoom: state.zoom,
    sectionId: state.activeSectionId, selection: [...state.selectedIds] }, viewBefore);
}
console.log("Main-editor connected Play/Stop: both models load the complete level, retain unsaved edits, cross the seam, restore pan/zoom/selection and clean up mount failure (real runtime, browser-I/O fixture).");

{
  const e = editor(towerProject);
  const { state, $, sandbox } = e;
  const source = connectedFixture(identity.ASTRAEUM_MODEL);
  const destination = connectedFixture(identity.ASTRAEUM_MODEL);
  destination[0].mapId = destination[0].document.id = "destination-level";
  destination[1].mapId = destination[1].document.id = "destination-neighbor";
  destination[0].gridX = 0;
  destination[1].gridX = 1;
  destination[0].document.cameraZoom = 1.5;
  const portal = towerProject.createDesignObject("authored-exit", "prop-stairs-rune",
    { x: 1968, y: 1040 }, source[0].document.objects.length);
  source[0].document.objects.push(portal);
  state.sections = source.map(section => ({ ...section, savedJson: JSON.stringify(section.document) }));
  state.identity.mapId = source[0].mapId;
  state.activeSectionId = source[0].sectionId;
  state.document = state.sections[0].document;
  state.document.name = "Original unsaved draft";
  state.selectedIds = new Set([portal.id]);
  state.selectedId = portal.id;
  state.levels = [
    { mapId: source[0].mapId, name: "Source", supported: true },
    { mapId: destination[0].mapId, name: "Destination", supported: true },
    { mapId: "deleted-level", name: "Deleted", supported: true, deletedAt: "fixture" }
  ];
  let deleted = false, foreign = false, loading = null, tick;
  let runtimes = [], previews = [], writes = 0;
  const settle = () => new Promise(resolve => setImmediate(resolve));
  sandbox.Event = class { constructor(type) { this.type = type; } };
  sandbox.fetch = async (address, options = {}) => {
    if (options.method && options.method !== "GET") writes++;
    if (loading) await loading;
    if (address.endsWith("/levels")) return {
      ok: true, json: async () => ({ levels: state.levels.map(level =>
        level.mapId === destination[0].mapId && deleted ? { ...level, deletedAt: "now" } : level) })
    };
    assert.ok(address.endsWith("/destination-level/sections"), `only current-game destination requested: ${address}`);
    return { ok: true, json: async () => ({
      projectId: foreign ? "another-game" : state.identity.projectId,
      levelMapId: destination[0].mapId, model: identity.ASTRAEUM_MODEL, sections: destination
    }) };
  };
  Object.assign(sandbox, {
    createConnectedPreview,
    createLocalGame: async options => {
      const runtime = await createLocalGame(options);
      runtimes.push(runtime);
      return runtime;
    },
    connectedSkin: (preview, artwork, mode) => {
      previews.push(preview);
      return connectedSkin(preview, artwork, mode);
    },
    mountLocalPreview: () => {
      const canvas = sandbox.document.createElement("canvas");
      canvas.clientWidth = 800; canvas.clientHeight = 600;
      $("#play-host").append(canvas);
      return { dispose() {} };
    },
    requestAnimationFrame: callback => callback(),
    ResizeObserver: class { observe() {} disconnect() {} }
  });
  sandbox.window.setInterval = callback => { tick = callback; return 1; };
  sandbox.window.clearInterval = () => {};
  Object.assign(state, { cameraX: -117, cameraY: 210, zoom: 0.75 });
  e.refreshChrome();
  assert.equal($("#exit-inspector").hidden, false, "authored rune is selectable and has an exit Inspector");
  assert.equal(portal.exit, undefined, "merely selecting an existing rune never assigns a destination");
  assert.deepEqual($("#exit-level").children.map(option => option.value),
    ["", source[0].mapId, destination[0].mapId], "only available current-game levels are offered");
  $("#exit-level").dispatch("change", { target: { value: destination[0].mapId } });
  await settle();
  assert.equal(state.document.objects.find(object => object.id === portal.id).exit.startId, null,
    "choosing a level does not automatically choose its start");
  assert.equal($("#exit-start").disabled, false);
  const startValue = JSON.stringify([destination[0].sectionId, "authored-primary"]);
  $("#exit-start").dispatch("change", { target: { value: startValue } });
  await settle();
  assert.match($("#exit-message").textContent, /arrival are valid/);
  const draft = e.documents(), saved = state.sections.map(section => section.savedJson);
  const undo = state.undo.length;
  const view = { x: state.cameraX, y: state.cameraY, zoom: state.zoom,
    section: state.activeSectionId, selection: [...state.selectedIds] };
  runtimes = [];
  previews = [];
  await e.play();
  assert.equal(state.play.phase, "playing");
  const interactionState = state.play.interactionState;
  assert.ok(interactionState?.collected instanceof Set, "Play creates run-local interaction state");
  const sourceRuntime = state.play.game;
  sourceRuntime.sendInput("aries", { type: "move", x: 1, y: 0 });
  tick();
  await settle();
  assert.equal(state.play.phase, "playing", $("#status").textContent);
  assert.equal(runtimes.length, 2, "an unlocked rune automatically causes exactly one replacement");
  assert.equal(state.play.interactionState, interactionState,
    "level transitions reuse the same runtime-only interaction ledger");
  assert.equal(previews.at(-1).options.world.id, "destination-level");
  assert.equal(previews.at(-1).options.world.sections.length, 2, "complete destination active section set loads");
  assert.equal(previews.at(-1).requireNeutral, true);
  assert.equal(previews.at(-1).primaryDocument.cameraZoom, 1.5, "destination zoom reaches the mounted Tower skin");
  assert.equal(previews.at(-1).bounds.x, 0, "destination camera bounds replace the source bounds");
  assert.equal(state.play.game.snapshot.player.x, 2000);
  assert.equal(state.play.game.snapshot.player.y, 1048);
  for (let index = 0; index < 10; index++) tick();
  assert.equal(state.play.game.snapshot.player.x, 2000, "held source movement is cleared");
  assert.equal(runtimes.length, 2, "standing at arrival cannot chain transitions");
  await e.transitionExit({ sequence: 1, destination: {
    levelId: source[0].mapId, sectionId: source[0].sectionId, startId: "authored-primary"
  } });
  assert.equal(previews.at(-1).options.world.id, source[0].mapId, "an explicit return uses the original level");
  assert.equal(previews.at(-1).primaryDocument.name, "Original unsaved draft",
    "returning to the original level uses the captured unsaved draft, not its saved map");
  assert.equal(state.play.game.snapshot.player.x, -48);
  for (let index = 0; index < 3; index++) tick();
  assert.equal(runtimes.length, 3, "returning beside an unlocked exit cannot automatically bounce again");
  e.stop();
  assert.equal(state.play.interactionState, null, "Stop discards runtime-only interaction state");
  assert.equal(e.documents(), draft);
  assert.deepEqual(state.sections.map(section => section.savedJson), saved);
  assert.equal(state.undo.length, undo);
  assert.deepEqual({ x: state.cameraX, y: state.cameraY, zoom: state.zoom,
    section: state.activeSectionId, selection: [...state.selectedIds] }, view,
  "Stop restores the exact original unsaved draft and view, not the destination or gameplay state");
  assert.equal(writes, 0, "Play, transition, Inspector validation and Stop never save");

  await e.play();
  const request = { sequence: 1, destination: null };
  await e.transitionExit(request);
  assert.match($("#status").textContent, /no complete destination/);
  assert.equal(state.play.phase, "playing", "invalid exits leave the source running");
  request.sequence++;
  request.destination = { levelId: destination[0].mapId, sectionId: "root", startId: "deleted-start" };
  await e.transitionExit(request);
  assert.match($("#status").textContent, /player start is missing/);
  request.sequence++;
  request.destination.startId = "authored-primary";
  deleted = true;
  await e.transitionExit(request);
  assert.match($("#status").textContent, /missing, deleted or unsupported/);
  deleted = false;
  request.sequence++;
  foreign = true;
  await e.transitionExit(request);
  assert.match($("#status").textContent, /current game/);
  foreign = false;
  request.sequence++;
  let release;
  loading = new Promise(resolve => { release = resolve; });
  const pending = e.transitionExit(request);
  assert.equal(state.play.phase, "transitioning");
  e.stop();
  const count = runtimes.length;
  loading = null;
  release();
  await pending;
  assert.equal(state.play.phase, "idle", "Stop cancels an in-flight transition");
  assert.equal(runtimes.length, count, "late destination responses cannot resurrect Play");
  assert.equal(e.documents(), draft);
  assert.equal(writes, 0);
  state.sections = state.sections.slice(0, 1);
  state.document = state.sections[0].document;
  await e.play();
  assert.equal(state.play.phase, "playing");
  assert.equal(previews.at(-1).options.world.sections.length, 1,
    "a single-section level with an authored stairs exit also uses progression");
  e.stop();
}
console.log("Astraeum editor progression: explicit scoped destination/start authoring, full-level replacement, safe failure/retry, input clearing, one activation, cancelled load and exact Stop restoration passed (disposable real-runtime fixture; no browser).");

{
  const e = editor(towerProject);
  const { state, $, sandbox } = e;
  const sections = connectedFixture(identity.ASTRAEUM_MODEL);
  const add = (section, id, assetId, x) => {
    const object = towerProject.createDesignObject(id, assetId,
      { x, y: 1040 }, section.document.objects.length);
    section.document.objects.push(object);
    return object;
  };
  const portal = add(sections[0], "input-exit", "prop-stairs-rune", 1968);
  portal.exit = { levelId: "input-destination", sectionId: "root", startId: "authored-primary" };
  add(sections[0], "source-slime", "spawn-slime", 1968);
  add(sections[1], "neighbor-slime", "spawn-slime", 48);
  const destination = connectedFixture(identity.ASTRAEUM_MODEL);
  destination[0].mapId = destination[0].document.id = "input-destination";
  destination[1].mapId = destination[1].document.id = "input-destination-neighbor";
  destination[0].gridX = 0;
  destination[1].gridX = 1;
  add(destination[0], "arrival-rune", "prop-stairs-rune", 1968).exit = {
    levelId: sections[0].mapId, sectionId: "root", startId: "authored-primary"
  };
  state.sections = sections.map(section => ({ ...section, savedJson: JSON.stringify(section.document) }));
  state.identity.mapId = sections[0].mapId;
  state.activeSectionId = sections[1].sectionId;
  state.document = state.sections[1].document;
  state.document.name = "Keep this dirty neighbor";
  state.selectedIds = new Set(["floor-0-992"]);
  state.playerControlMode = "keyboard-only";
  state.levels = [
    { mapId: sections[0].mapId, name: "Source", supported: true },
    { mapId: "input-destination", name: "Input Destination", supported: true }
  ];
  Object.assign(state, { cameraX: -117, cameraY: 210, zoom: 0.75 });
  const draft = e.documents(), saved = state.sections.map(section => section.savedJson);
  const history = JSON.stringify({ undo: state.undo, redo: state.redo });
  const view = { x: state.cameraX, y: state.cameraY, zoom: state.zoom,
    section: state.activeSectionId, selection: [...state.selectedIds] };
  let tick, mounted, writes = 0, missingStart = true;
  const requests = [], dispatched = [], prompts = [];
  sandbox.Event = class { constructor(type) { this.type = type; } };
  sandbox.fetch = async (address, options = {}) => {
    if (options.method && options.method !== "GET") writes++;
    requests.push(address);
    if (address.endsWith("/levels")) return { ok: true, json: async () => ({ levels: state.levels }) };
    assert.ok(address.endsWith("/input-destination/sections"));
    const loaded = structuredClone(destination);
    if (missingStart) loaded[0].document.objects.find(object => object.assetId === "spawn-aries").id = "changed";
    return { ok: true, json: async () => ({
      projectId: state.identity.projectId, levelMapId: "input-destination",
      model: identity.ASTRAEUM_MODEL, sections: loaded
    }) };
  };
  const globals = Object.fromEntries(["document", "window", "navigator", "CustomEvent"].map(name =>
    [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: sandbox.document },
    window: { configurable: true, value: sandbox.window },
    navigator: { configurable: true, value: { getGamepads: () => [] } },
    CustomEvent: { configurable: true, value: sandbox.CustomEvent }
  });
  Object.assign(sandbox, {
    createConnectedPreview, connectedSkin, createLocalGame,
    requestAnimationFrame: callback => callback(),
    ResizeObserver: class { observe() {} disconnect() {} },
    // Substitute layout/animation I/O, but mount the real skin and its registered input handlers.
    mountLocalPreview: (host, game, factory) => {
      const slots = new Map(["world", "hud", "controls"].map(name => {
        const element = sandbox.document.createElement("section");
        host.append(element);
        return [name, element];
      }));
      const skin = factory.mount({ slots, dispatchInput(input) {
        dispatched.push(input);
        assert.equal(game.sendInput("aries", input), true);
      } });
      const canvas = slots.get("world").querySelector("canvas");
      canvas.clientWidth = 800; canvas.clientHeight = 600;
      skin.handleViewport(800, 600, 1);
      const render = () => { skin.handleSnapshot(game.snapshot); skin.render(); };
      render();
      const unsubscribe = game.subscribe(render);
      mounted = { skin, canvas, render };
      return { dispose() { unsubscribe(); skin.dispose(); } };
    }
  });
  sandbox.window.setInterval = callback => { tick = callback; return 1; };
  sandbox.window.clearInterval = () => {};
  const key = (type, code, extra = {}) => {
    const target = mounted.canvas;
    if (type === "keydown") target.dispatch(type, { code, ...extra });
    sandbox.window.dispatch(type, { target, code, ...extra });
  };
  const step = count => { for (let n = 0; n < count; n++) tick(); };
  const prompt = () => $("#play-host").querySelector('[data-testid="astraeum-exit-prompt"]')?.textContent;
  const settle = () => new Promise(resolve => setImmediate(resolve));
  try {
    e.refreshChrome();
    await $("#play").clickAsync();
    assert.equal(state.play.phase, "playing", $("#play-error-message").textContent);
    prompts.push(prompt());
    step(1);
    assert.equal(state.play.game.snapshot.exitRequest, null);
    key("keydown", "KeyA"); step(1); key("keyup", "KeyA");
    key("keydown", "Space"); step(38); key("keyup", "Space");
    assert.equal(state.play.game.snapshot.enemies.length, 1, "neighbor-section slime still locks the rune");
    prompts.push(prompt());
    key("keydown", "KeyD"); step(1); key("keyup", "KeyD");
    const source = state.play.game;
    key("keydown", "Space"); step(38); key("keyup", "Space");
    assert.equal(source.snapshot.enemies.length, 0);
    assert.equal(source.snapshot.exitUnlocked, true);
    assert.equal(source.snapshot.exitRequest.exitId, "root:input-exit");
    assert.equal(prompt(), "Loading the exit destination...");
    await settle();
    assert.equal(state.play.game, source, "invalid destination retains the source encounter");
    assert.match($("#status").textContent, /player start is missing/);
    mounted.render();
    prompts.push(prompt());
    const attempts = requests.length;
    step(60);
    await settle();
    assert.equal(requests.length, attempts, "a failed automatic transition never retries every tick");
    assert.equal(source.snapshot.exitRequest.sequence, 1);
    missingStart = false;
    key("keydown", "KeyD"); step(12); key("keyup", "KeyD");
    assert.equal(prompt(), "", "nearby prompt clears outside activation range");
    key("keydown", "KeyA"); step(12); key("keyup", "KeyA");
    await settle();
    assert.notEqual(state.play.game, source, "leaving and re-entering retries the real destination load automatically");
    assert.equal(state.play.game.snapshot.player.x, 2000);
    assert.equal(state.play.game.snapshot.player.y, 1048, "destination uses the exact authored feet position");
    step(60);
    assert.equal(state.play.game.snapshot.exitRequest, null);
    assert.equal(prompt(), "Enter the rune to continue", "arrival on an unlocked return rune cannot bounce");
    assert.ok(!dispatched.some(input => input.type === "activate-exit"), "no Interact input is sent");
    assert.ok(requests.some(address => address.endsWith("/input-destination/sections")));
    $("#stop").click();
    assert.equal(state.play.phase, "idle");
    assert.equal(e.documents(), draft);
    assert.deepEqual(state.sections.map(section => section.savedJson), saved);
    assert.equal(JSON.stringify({ undo: state.undo, redo: state.redo }), history);
    assert.deepEqual({ x: state.cameraX, y: state.cameraY, zoom: state.zoom,
      section: state.activeSectionId, selection: [...state.selectedIds] }, view);
    assert.equal(writes, 0);
    console.log("Registered editor Play -> combat/remote slime -> already-on-rune unlock -> automatic validation/error -> no repeated requests -> re-entry retry -> destination (2000,1048) without arrival bounce -> Stop draft/view restoration passed.");
    assert.equal(prompts[0], "Defeat 2 remaining slimes");
    assert.equal(prompts[1], "Defeat 1 remaining slime");
    assert.match(prompts[2], /player start is missing/);
  } finally {
    if (state.play.phase !== "idle") e.stop();
    for (const [name, descriptor] of Object.entries(globals)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

{
  const e = editor(towerProject);
  const { state, $ } = e;
  const design = structuredClone(towerProject.DEFAULT_FLOOR_DOCUMENT);
  state.identity.mapId = design.id;
  state.sections = [{ sectionId: "root", mapId: design.id, gridX: 0, gridY: 0,
    document: design, savedJson: JSON.stringify(design) }];
  state.document = design;
  e.refreshChrome();
  const before = e.documents();
  const selectAt = point => e.drag([[point.x, point.y], [point.x, point.y]]);
  const rune = design.objects.find(object => object.assetId === "prop-stairs-rune");
  $(".inspector").scrollTop = 800;
  selectAt(rune.transform);
  assert.equal(state.selectedId, rune.id, "real canvas hit-test resolves a legacy placed rune's identity");
  assert.equal($("#object-id").value, rune.id);
  assert.match($("#object-type").textContent, /Prop/);
  assert.equal($("#object-inspector").hidden, false);
  assert.equal($("#exit-inspector").hidden, false);
  assert.match($("#object-heading").textContent, /Stairs rune - level exit/);
  assert.equal($(".inspector").scrollTop, 0, "selection brings the behavior-first Inspector into view");
  assert.equal(Object.hasOwn(rune, "exit"), false, "selecting a legacy rune never assigns a destination");
  const children = $("#object-inspector").children;
  assert.ok(children.indexOf($("#exit-inspector")) < children.indexOf($("#object-id").parentElement),
    "destination controls precede object metadata, transforms and long artwork notes");
  assert.ok($(".inspector").children.indexOf($("#object-inspector")) <
    $(".inspector").children.indexOf($(".map-settings[aria-label='Current map dimensions']")),
  "map dimensions no longer bury selected-object authoring");
  assert.match($("label[for='exit-level']").textContent, /this game/);
  assert.match($("label[for='exit-start']").textContent, /Arrival player start/);
  const aries = design.objects.find(object => object.assetId === "spawn-aries");
  selectAt(aries.transform);
  assert.equal(state.selectedId, aries.id);
  assert.equal($("#exit-inspector").hidden, true);
  assert.equal($("#combat-inspector").hidden, false);
  assert.match($("#object-heading").textContent, /player start/);
  assert.equal($("#combat-values").children[1].textContent, String(towerEncounterTuning.playerHp));
  assert.equal($("#combat-values").querySelectorAll("input").length +
    $("#combat-values").querySelectorAll("select").length, 0,
    "fixed combat tuning is presented as outputs, never ineffective controls");
  assert.match($("#combat-authoring-note").textContent, /not saved per object/);
  const slime = design.objects.find(object => object.assetId === "spawn-slime");
  selectAt(slime.transform);
  assert.equal(state.selectedId, slime.id);
  assert.match($("#object-heading").textContent, /enemy spawn/);
  assert.equal($("#combat-values").children[1].textContent, String(towerEncounterTuning.slime.hp));
  assert.equal($("#combat-values").children[3].textContent, String(towerEncounterTuning.slime.damage));
  assert.match($("#object-behavior").textContent, /keeps stairs exits locked/);

  const { door } = towerRender.fixedDecorations(state.artwork, towerProject.floorDocumentGrid(design), aries.transform);
  assert.ok(door, "original Floor 1 produces a decorative door");
  const bounds = towerRender.doorBounds(state.artwork, door);
  selectAt({ x: bounds.x + bounds.width / 2, y: Math.max(0, bounds.y) + 1 });
  assert.equal(state.selectedId, null, "clicking generated door artwork does not pretend it is a wall or authored object");
  assert.equal($("#decoration-inspector").hidden, false);
  assert.equal($("#object-inspector").hidden, true);
  assert.equal($("#exit-inspector").hidden, true);
  assert.equal($("#combat-inspector").hidden, true);
  assert.equal(e.documents(), before, "selection/door inspection never changes a saved design");
  assert.equal(state.undo.length, 0);

  const group = $(`.tree-group[data-layer="props"]`);
  group.open = true;
  // Real browsers fire toggle after expanding; trigger its registered handler.
  group.isConnected = true;
  group.dispatch("toggle");
  $(`.tree-item[data-object-id="${rune.id}"]`).click();
  assert.equal($("#exit-inspector").hidden, false, "hierarchy selection also renders the exit controls");
  assert.equal($("#decoration-inspector").hidden, true);
  state.layers.props.locked = true;
  e.refreshChrome();
  assert.equal($(`.tree-item[data-object-id="${rune.id}"]`).disabled, true, "locked layers remain protected");
  state.layers.props.locked = false;
  e.refreshChrome();

  const record = { name: "Decorative door rune character", width: 32, height: 32, category: "character" };
  const assetId = `asset-${"a".repeat(64)}`;
  const assets = { ...towerProject.ASSET_CATALOG, [assetId]: importedAssetDefinition(record) };
  state.artwork.imported[assetId] = { naturalWidth: 32, naturalHeight: 32 };
  e.activateAssetCatalog(state.model, { catalog: assets, records: [record], images: state.artwork.imported });
  const artwork = towerProject.createDesignObject("imported-artwork", assetId, { x: 400, y: 200 }, 999, {}, assets);
  state.document = { ...state.document, objects: [...state.document.objects, artwork] };
  state.sections[0].document = state.document;
  e.refreshChrome();
  selectAt({ x: 400, y: 192 });
  assert.equal(state.selectedId, artwork.id);
  assert.match($("#object-heading").textContent, /decorative artwork/);
  assert.match($("#object-behavior").textContent, /not an exit, player or enemy/);
  assert.equal($("#exit-inspector").hidden, true);
  assert.equal($("#combat-inspector").hidden, true);
  assert.equal(Object.hasOwn(artwork, "exit"), false, "similar imported imagery is never converted into gameplay");
}

await mkdir(new URL("../data/", import.meta.url), { recursive: true });
const inspectorDirectory = await mkdtemp(fileURLToPath(new URL("../data/inspector-check-", import.meta.url)));
let inspectorDatabase;
try {
  const databasePath = `${inspectorDirectory}\\selection.sqlite`;
  inspectorDatabase = new DatabaseSync(databasePath);
  inspectorDatabase.exec("CREATE TABLE fixture (id TEXT PRIMARY KEY, payload TEXT NOT NULL)");
  const e = editor(towerProject);
  const { state, $, sandbox } = e;
  state.sections = connectedFixture(identity.ASTRAEUM_MODEL).map(section => ({
    ...section, revision: 0, savedJson: JSON.stringify(section.document)
  }));
  state.identity.mapId = state.sections[0].mapId;
  state.activeSectionId = state.sections[0].sectionId;
  state.document = state.sections[0].document;
  state.sectionRevision = 0;
  Object.assign(state, { cameraX: -160, cameraY: 800, zoom: 1 });
  const destination = connectedFixture(identity.ASTRAEUM_MODEL);
  destination[0].mapId = destination[0].document.id = "inspector-destination";
  destination[1].mapId = destination[1].document.id = "inspector-destination-east";
  destination[0].gridX = 0;
  destination[1].gridX = 1;
  const levels = [
    { mapId: state.identity.mapId, name: "Source", supported: true },
    { mapId: destination[0].mapId, name: "Destination", supported: true }
  ];
  state.levels = levels;
  let writes = 0, tick;
  const response = payload => ({ ok: true, json: async () => structuredClone(payload) });
  const stored = () => JSON.parse(inspectorDatabase.prepare("SELECT payload FROM fixture WHERE id = 'source'").get().payload);
  sandbox.fetch = async (address, options = {}) => {
    if (options.method === "PUT") {
      writes++;
      const request = JSON.parse(options.body);
      assert.equal(request.sections.length, 2, "Inspector Save uses the complete level transaction");
      const sections = request.sections.map(section => {
        const existing = state.sections.find(item => item.sectionId === section.sectionId);
        return { sectionId: section.sectionId, mapId: existing.mapId, gridX: existing.gridX, gridY: existing.gridY,
          document: towerProject.validateFloorDocument(section.document), revision: section.revision + 1 };
      });
      const payload = { projectId: state.identity.projectId, levelMapId: state.identity.mapId,
        model: state.model, revision: 1, sections, archivedSections: [] };
      inspectorDatabase.prepare("INSERT OR REPLACE INTO fixture VALUES ('source', ?)").run(JSON.stringify(payload));
      return response(payload);
    }
    if (address.endsWith("/assets")) return response({ assets: [] });
    if (address.endsWith("/levels")) return response({ levels, startingMapId: state.identity.mapId });
    if (address.endsWith("/inspector-destination/sections")) return response({
      projectId: state.identity.projectId, levelMapId: destination[0].mapId,
      model: state.model, sections: destination, archivedSections: []
    });
    if (address.endsWith("/sections")) return response(stored());
    if (address.endsWith(`/maps/${state.identity.mapId}`)) return response({
      projectId: state.identity.projectId, mapId: state.identity.mapId, model: state.model,
      document: stored().sections[0].document, migrations: []
    });
    throw new Error(`Unexpected Inspector fixture request: ${address}`);
  };
  let sequence = 0;
  sandbox.crypto.randomUUID = () => `inspector-fixture-${++sequence}`;
  sandbox.createConnectedPreview = createConnectedPreview;
  sandbox.createLocalGame = createLocalGame;
  e.refreshChrome();
  const card = $('.asset-card[data-asset-id="prop-stairs-rune"]');
  card.dispatch("keydown", { code: "Enter" });
  e.drag([[80, 248], [80, 248]]);
  const placedId = state.selectedId;
  assert.equal(state.document.objects.find(object => object.id === placedId)?.assetId, "prop-stairs-rune",
    "registered palette and placement events create a new canonical rune");
  assert.equal($("#exit-inspector").hidden, false, "new rune immediately shows destination fields");
  assert.equal(state.document.objects.find(object => object.id === placedId).exit, undefined);
  e.tool("select");
  // Select a different authored object, then click the new rune through real hit-testing.
  $(".inspector").scrollTop = 700;
  e.drag([[112, 248], [112, 248]]);
  e.drag([[80, 248], [80, 248]]);
  assert.equal(state.selectedId, placedId);
  assert.equal($("#exit-inspector").hidden, false);
  $("#exit-level").dispatch("change", { target: { value: destination[0].mapId } });
  await new Promise(resolve => setImmediate(resolve));
  const startValue = JSON.stringify(["root", "authored-primary"]);
  $("#exit-start").dispatch("change", { target: { value: startValue } });
  await new Promise(resolve => setImmediate(resolve));
  assert.match($("#exit-message").textContent, /arrival are valid/);
  $(".inspector").scrollTop = 37;
  e.refreshChrome();
  assert.equal($(".inspector").scrollTop, 37, "same-object refresh does not steal the user's scroll/focus");
  assert.equal(await e.save(), true, $("#status").textContent);
  assert.equal(writes, 1);
  const savedExit = stored().sections[0].document.objects.find(object => object.id === placedId).exit;
  assert.deepEqual(savedExit, { levelId: destination[0].mapId, sectionId: "root", startId: "authored-primary" });
  inspectorDatabase.close();
  inspectorDatabase = new DatabaseSync(databasePath);
  const identityBefore = { ...state.identity };
  const reopened = await e.fetchDesign(identityBefore);
  e.installDesign(identityBefore, reopened.payload, reopened.document, reopened.assets, reopened.sectionData);
  await new Promise(resolve => setImmediate(resolve));
  Object.assign(state, { cameraX: -160, cameraY: 800, zoom: 1 });
  e.drag([[80, 248], [80, 248]]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.selectedId, placedId, "reopen then canvas selection resolves the persisted rune");
  assert.equal($("#exit-inspector").hidden, false);
  assert.equal($("#exit-level").value, savedExit.levelId);
  assert.equal($("#exit-start").value, startValue);
  Object.assign(sandbox, {
    Event: class { constructor(type) { this.type = type; } },
    requestAnimationFrame: callback => callback(),
    connectedSkin,
    ResizeObserver: class { observe() {} disconnect() {} },
    mountLocalPreview: () => {
      const canvas = sandbox.document.createElement("canvas");
      canvas.clientWidth = 800; canvas.clientHeight = 600;
      $("#play-host").append(canvas);
      return { dispose() {} };
    }
  });
  sandbox.window.setInterval = callback => { tick = callback; return 1; };
  sandbox.window.clearInterval = () => {};
  const beforePlay = e.documents();
  await e.play();
  assert.equal(state.play.phase, "playing");
  tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.play.phase, "playing", $("#status").textContent);
  assert.equal(state.play.game.snapshot.player.x, 2000, "Play consumes the reopened destination and selected arrival");
  assert.equal(state.play.game.snapshot.player.y, 1048);
  e.stop();
  assert.equal(e.documents(), beforePlay);
  assert.equal(writes, 1, "selection, reopen, Play, transition and Stop cannot save gameplay");
} finally {
  inspectorDatabase?.close();
  await rm(inspectorDirectory, { recursive: true, force: true });
}
console.log("Inspector selection -> authored identity -> visible behavior-first fields -> change events -> Save -> SQLite close/reopen -> editor reopen/reselect -> real Play consumption passed for old/new runes; fixed combat outputs, generated doors and imported visual-only artwork remain non-converting (substituted I/O, no browser or server launch).");

// Exercise the registered Inspector and Save events against a separately owned disposable API.
{
  const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const directory = await mkdtemp(resolve(root, "studio", "data", "rune-save-"));
  const listener = createServer();
  await new Promise((ok, fail) => listener.once("error", fail).listen(0, "127.0.0.1", ok));
  const port = listener.address().port;
  await new Promise((ok, fail) => listener.close(error => error ? fail(error) : ok()));
  const origin = `http://127.0.0.1:${port}`;
  const projectId = identity.ASTRAEUM_PROJECT_ID;
  const sourceId = "rune-save-source", destinationId = "rune-save-destination";
  const projectPath = `/api/projects/${projectId}`;
  const sourcePath = `${projectPath}/levels/${sourceId}/sections`;
  let output = "";
  const service = spawn(process.execPath, ["--no-warnings", resolve(root, "studio", "server.mjs")], {
    cwd: root,
    env: { ...process.env, STUDIO_API_PORT: String(port),
      STUDIO_DATABASE_PATH: relative(root, resolve(directory, "fixture.sqlite")),
      STUDIO_GAMES_PATH: relative(root, resolve(directory, "games")) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  service.stdout.on("data", chunk => { output += chunk; });
  service.stderr.on("data", chunk => { output += chunk; });
  const request = async (path, method = "GET", body) => {
    const response = await fetch(origin + path, { method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    const payload = await response.json();
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(payload)}`);
    return payload;
  };
  try {
    let ready = false;
    for (let attempt = 0; attempt < 150; attempt++) {
      if (service.exitCode !== null) throw new Error(`Disposable API exited: ${output}`);
      try {
        const response = await fetch(`${origin}${projectPath}/maps/${sourceId}`);
        if (response.ok) { ready = true; break; }
      } catch {}
      await new Promise(ok => setTimeout(ok, 100));
    }
    assert.ok(ready, `Disposable API did not start: ${output}`);
    const source = towerProject.createBlankDocument(sourceId, "Source");
    source.objects = [towerProject.createDesignObject("portal", "prop-stairs-rune", { x: 336, y: 336 }, 0)];
    const destination = towerProject.createBlankDocument(destinationId, "Destination");
    destination.objects = [towerProject.createDesignObject("arrival", "spawn-aries", { x: 336, y: 336 }, 0)];
    for (const document of [source, destination]) {
      await request(`${projectPath}/maps/${document.id}`, "PUT", { projectId, model: identity.ASTRAEUM_MODEL, document });
    }
    const sourceSections = await request(sourcePath);
    await request(sourcePath, "POST", { gridX: 1, gridY: 0, revision: sourceSections.revision });
    const e = editor(towerProject);
    const { state, $, sandbox } = e;
    const traffic = [];
    let sequence = 0;
    sandbox.crypto.randomUUID = () => `rune-save-${++sequence}`;
    sandbox.fetch = async (address, options = {}) => {
      const response = await fetch(origin + address, options);
      if (options.method === "PUT") {
        traffic.push({ address, request: JSON.parse(options.body), status: response.status,
          response: await response.clone().json() });
      }
      return response;
    };
    const loaded = await e.fetchDesign({ projectId, mapId: sourceId });
    e.installDesign({ projectId, mapId: sourceId }, loaded.payload, loaded.document, loaded.assets, loaded.sectionData);
    state.levels = (await request(`${projectPath}/levels`)).levels;
    state.selectedIds = new Set(["portal"]);
    state.selectedId = "portal";
    e.refreshChrome();
    $("#camera-zoom").dispatch("change", { target: { value: "1.5" } });
    const historyAfterZoom = state.undo.length;
    $("#exit-level").dispatch("change", { target: { value: destinationId } });
    await new Promise(ok => setTimeout(ok, 100));
    assert.equal($("#save").disabled, false);
    assert.equal(state.document.objects.find(object => object.id === "portal").exit.levelId, destinationId);
    await $("#save").clickAsync();
    assert.equal(traffic.length, 1, $("#status").textContent);
    assert.equal(traffic[0].status, 200);
    assert.equal($("#save-state").classList.contains("saved"), true, $("#status").textContent);
    assert.equal(traffic[0].request.sections.length, 2);
    assert.equal(traffic[0].request.sections.find(section => section.document.id === sourceId).document.cameraZoom, 1.5);
    assert.equal(state.undo.length, historyAfterZoom + 1, "Save preserves unrelated-edit and destination history");
    const sectionId = (await request(`${projectPath}/levels/${destinationId}/sections`)).sections[0].sectionId;
    $("#exit-start").dispatch("change", { target: { value: JSON.stringify([sectionId, "arrival"]) } });
    await new Promise(ok => setTimeout(ok, 100));
    assert.equal($("#save").disabled, false);
    await $("#save").clickAsync();
    assert.equal(traffic.length, 2, $("#status").textContent);
    assert.equal(traffic[1].status, 200);
    assert.equal($("#save-state").classList.contains("saved"), true, $("#status").textContent);
    const persisted = await request(sourcePath);
    assert.deepEqual(persisted.sections[0].document.objects.find(object => object.id === "portal").exit,
      { levelId: destinationId, sectionId, startId: "arrival" });
    const reopened = await e.fetchDesign({ projectId, mapId: sourceId });
    assert.deepEqual(reopened.sectionData.sections[0].document, persisted.sections[0].document);
    assert.equal(reopened.sectionData.sections[0].document.cameraZoom, 1.5);
    const longDestinationId = "d".repeat(121);
    const longDestination = towerProject.createBlankDocument(longDestinationId, "Long ID destination");
    longDestination.objects = [towerProject.createDesignObject("long-arrival", "spawn-aries", { x: 336, y: 336 }, 0)];
    await request(`${projectPath}/maps/${longDestinationId}`, "PUT",
      { projectId, model: identity.ASTRAEUM_MODEL, document: longDestination });
    state.levels = (await request(`${projectPath}/levels`)).levels;
    $("#exit-level").dispatch("change", { target: { value: longDestinationId } });
    await new Promise(ok => setTimeout(ok, 100));
    const longSectionId = (await request(`${projectPath}/levels/${longDestinationId}/sections`)).sections[0].sectionId;
    assert.ok($("#exit-start").children.some(option =>
      option.value === JSON.stringify([longSectionId, "long-arrival"])));
    $("#exit-start").dispatch("change", { target: { value: JSON.stringify([longSectionId, "long-arrival"]) } });
    assert.equal(state.document.objects.find(object => object.id === "portal").exit.sectionId, longSectionId);
    await $("#save").clickAsync();
    assert.equal(traffic.at(-1).status, 200, $("#status").textContent);
    assert.equal($("#save-state").classList.contains("saved"), true, $("#status").textContent);
    const longReopened = await e.fetchDesign({ projectId, mapId: sourceId });
    assert.equal(longReopened.sectionData.sections.find(section => section.mapId === sourceId)
      .document.objects.find(object => object.id === "portal").exit.sectionId, longSectionId);
    const withSectionId = sectionId => ({
      ...state.document, objects: state.document.objects.map(object => object.id === "portal"
        ? { ...object, exit: { ...object.exit, sectionId } } : object)
    });
    const maximumSectionId = `section-${"a".repeat(128)}`;
    assert.equal(towerProject.validateFloorDocument(withSectionId(maximumSectionId))
      .objects.find(object => object.id === "portal").exit.sectionId, maximumSectionId);
    assert.throws(() => towerProject.validateFloorDocument(withSectionId(`section-${"a".repeat(129)}`)),
      /sectionId must be a valid ID/);
    assert.throws(() => towerProject.validateFloorDocument(withSectionId(`section-${"a".repeat(120)}!`)),
      /sectionId must be a valid ID/);
    const beforeInvalid = e.documents(), historyBeforeInvalid = state.undo.length;
    $("#exit-start").dispatch("change", { target: { value: "not-json" } });
    assert.match($("#status").textContent, /Exit destination update failed:/);
    assert.equal($("#status").classList.contains("error"), true);
    assert.equal(e.documents(), beforeInvalid);
    assert.equal(state.undo.length, historyBeforeInvalid);

    const current = await request(sourcePath);
    const external = await request(sourcePath, "PUT", { operationId: "external-change", revision: current.revision,
      sections: current.sections.map(({ sectionId, revision, document }) => ({
        sectionId, revision, document: document.id === sourceId ? { ...document, name: "External change" } : document
      })), archivedSections: [] });
    $("#exit-level").dispatch("change", { target: { value: destinationId } });
    const conflictDraft = e.documents(), conflictUndo = state.undo.length;
    await $("#save").clickAsync();
    assert.equal(traffic.at(-1).status, 409);
    assert.match($("#status").textContent, /Save failed:.*changed since they were opened/i);
    assert.equal($("#status").classList.contains("error"), true);
    assert.equal($("#save-state").classList.contains("dirty"), true);
    assert.equal(e.documents(), conflictDraft);
    assert.equal(state.undo.length, conflictUndo);
    assert.deepEqual(await request(sourcePath), external, "conflict does not overwrite the concurrent save");
    $("#undo").click();
    assert.equal(state.document.objects.find(object => object.id === "portal").exit.sectionId, longSectionId);
    $("#redo").click();
    assert.equal(e.documents(), conflictDraft);
    console.log("Disposable API editor Save evidence:", JSON.stringify(traffic.map(item => ({
      requestRevision: item.request.revision, status: item.status, responseRevision: item.response.revision,
      exit: item.request.sections.find(section => section.document.id === sourceId).document.objects
        .find(object => object.id === "portal").exit
    }))));
  } finally {
    if (service.exitCode === null && service.signalCode === null) {
      await new Promise((ok, fail) => {
        const timer = setTimeout(() => fail(new Error("Disposable API did not stop.")), 5000);
        service.once("exit", () => { clearTimeout(timer); ok(); });
        service.kill("SIGTERM");
      });
    }
    await rm(directory, { recursive: true, force: true });
  }
}
