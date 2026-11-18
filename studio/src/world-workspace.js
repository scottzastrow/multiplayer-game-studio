import { sectionOrigin, worldToSection } from "../world-coordinates.js";
import { extendTerrainStroke, isTerrainBrushAsset, planTerrainStroke, terrainRectangle,
  terrainRectangleCells, TERRAIN_CELL_SIZE } from "../world-terrain.js";

export function configureWorldWorkspace(getEditor) {
  const $ = selector => document.querySelector(selector);
  const chooser = $("#world-dialog");
  const workspace = $("#world-workspace");
  const canvas = $("#world-canvas");
  const context = canvas.getContext("2d");
  let world = null;
  let baseline = "";
  let editor;
  let camera = { x: 0, y: 0, zoom: 0.25 };
  let selection = null;
  let pointer = null;
  let fillPreview = null;
  let space = false;
  let busy = false;
  let pending = null;
  let undo = [];
  let redo = [];
  let tool = "select";
  const scenes = new Map();
  const url = (projectId, id = "") => `/api/projects/${encodeURIComponent(projectId)}/worlds${id ? `/${encodeURIComponent(id)}` : ""}`;
  const documents = () => world.sections.map(section => section.document);
  const dirty = () => world && JSON.stringify(documents()) !== baseline;
  const status = (message, error = false) => {
    $("#world-status").textContent = message;
    $("#world-status").classList.toggle("error", error);
  };
  async function request(address, method = "GET", body) {
    const response = await fetch(address, { method, ...(body ? {
      headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    } : {}) });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(result.error ?? `Request failed (${response.status}).`);
      error.status = response.status;
      throw error;
    }
    return result;
  }
  function update() {
    const editing = Boolean(pointer || fillPreview);
    $("#world-zoom-label").textContent = `${Math.round(camera.zoom * 100)}%`;
    $("#world-save").disabled = busy || editing || (!dirty() && !pending);
    $("#world-undo").disabled = busy || editing || Boolean(pending) || !undo.length;
    $("#world-redo").disabled = busy || editing || Boolean(pending) || !redo.length;
    $("#world-close").disabled = busy || editing;
    $("#world-fill-apply").disabled = busy || Boolean(pointer) || !fillPreview || Boolean(fillPreview.error);
    $("#world-fill-cancel").disabled = busy || Boolean(pointer) || !fillPreview;
    for (const id of ["world-zoom-in", "world-zoom-out", "world-select-tool", "world-brush-tool", "world-fill-tool", "world-brush-asset",
      "world-terrain-visible", "world-terrain-locked"]) {
      $(`#${id}`).disabled = busy || editing || Boolean(pending);
    }
    $("#world-brush-tool").disabled ||= !$("#world-brush-asset").value;
    $("#world-fill-tool").disabled ||= !$("#world-brush-asset").value;
    $("#world-select-tool").setAttribute("aria-pressed", String(tool === "select"));
    $("#world-brush-tool").setAttribute("aria-pressed", String(tool === "brush"));
    $("#world-fill-tool").setAttribute("aria-pressed", String(tool === "fill"));
    const preview = pointer?.mode === "fill" ? pointer : fillPreview;
    $("#world-fill-preview").textContent = preview?.error ? `Rectangle preview: ${preview.error}` :
      preview?.rectangle ? `Rectangle preview: ${preview.rectangle.cellCount} cell(s), ${preview.rectangle.sectionCount} section(s).` : "";
    draw();
  }
  function draw() {
    if (!world || !workspace.open) return;
    const rect = canvas.getBoundingClientRect();
    const pixelRatio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(rect.width * pixelRatio));
    const height = Math.max(1, Math.round(rect.height * pixelRatio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.fillStyle = "#14161a";
    context.fillRect(0, 0, rect.width, rect.height);
    const scale = pixelRatio * camera.zoom;
    context.setTransform(scale, 0, 0, scale, -camera.x * scale, -camera.y * scale);
    context.imageSmoothingEnabled = false;
    for (const section of world.sections) {
      const origin = sectionOrigin(section.gridX, section.gridY);
      if (origin.x + 2048 < camera.x || origin.y + 2048 < camera.y ||
          origin.x > camera.x + rect.width / camera.zoom || origin.y > camera.y + rect.height / camera.zoom) continue;
      let scene = scenes.get(section.sectionId);
      if (!scene || scene.document !== section.document) {
        const image = document.createElement("canvas");
        image.width = image.height = 2048;
        const ctx = image.getContext("2d");
        ctx.imageSmoothingEnabled = false;
        editor.draw(ctx, section.document);
        scene = { image, document: section.document };
        scenes.set(section.sectionId, scene);
      }
      context.drawImage(scene.image, origin.x, origin.y);
      context.strokeStyle = "#ffffff18";
      context.lineWidth = 1 / camera.zoom;
      context.beginPath();
      for (let offset = 0; offset <= 2048; offset += TERRAIN_CELL_SIZE) {
        context.moveTo(origin.x + offset, origin.y);
        context.lineTo(origin.x + offset, origin.y + 2048);
        context.moveTo(origin.x, origin.y + offset);
        context.lineTo(origin.x + 2048, origin.y + offset);
      }
      context.stroke();
      context.strokeStyle = "#ffd166";
      context.lineWidth = 3 / camera.zoom;
      context.strokeRect(origin.x, origin.y, 2048, 2048);
      context.fillStyle = "#20242b";
      context.fillRect(origin.x + 8 / camera.zoom, origin.y + 8 / camera.zoom, 250 / camera.zoom, 32 / camera.zoom);
      context.fillStyle = "#fff";
      context.font = `${16 / camera.zoom}px sans-serif`;
      context.fillText(`Section (${section.gridX}, ${section.gridY})`, origin.x + 16 / camera.zoom, origin.y + 30 / camera.zoom);
    }
    if (pointer?.mode === "brush") {
      context.fillStyle = pointer.stroke.error ? "#ff667060" : "#66ccff60";
      context.strokeStyle = pointer.stroke.error ? "#ff6670" : "#66ccff";
      context.lineWidth = 1 / camera.zoom;
      for (const cell of pointer.stroke.cells.values()) {
        context.fillRect(cell.x, cell.y, TERRAIN_CELL_SIZE, TERRAIN_CELL_SIZE);
        context.strokeRect(cell.x, cell.y, TERRAIN_CELL_SIZE, TERRAIN_CELL_SIZE);
      }
    }
    const fill = pointer?.mode === "fill" ? pointer : fillPreview;
    if (fill?.rectangle) {
      const { x, y, columns, rows } = fill.rectangle;
      context.fillStyle = fill.error ? "#ff667060" : "#66ccff60";
      context.strokeStyle = fill.error ? "#ff6670" : "#66ccff";
      context.lineWidth = 2 / camera.zoom;
      context.fillRect(x, y, columns * TERRAIN_CELL_SIZE, rows * TERRAIN_CELL_SIZE);
      context.strokeRect(x, y, columns * TERRAIN_CELL_SIZE, rows * TERRAIN_CELL_SIZE);
    }
    if (selection) {
      const section = world.sections.find(item => item.sectionId === selection.sectionId);
      const object = section?.document.objects.find(item => item.id === selection.objectId);
      if (object) {
        const origin = sectionOrigin(section.gridX, section.gridY);
        const bounds = editor.objectBounds(object);
        context.strokeStyle = "#ffcc55";
        context.lineWidth = 3 / camera.zoom;
        context.strokeRect(origin.x + bounds.x, origin.y + bounds.y, bounds.width, bounds.height);
      }
    }
  }
  function point(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: camera.x + (event.clientX - rect.left) / camera.zoom,
      y: camera.y + (event.clientY - rect.top) / camera.zoom };
  }
  function snapshot() {
    return { documents: structuredClone(documents()), selection: structuredClone(selection) };
  }
  function restore(value) {
    world.sections.forEach((section, index) => { section.document = value.documents[index]; });
    selection = value.selection;
    scenes.clear();
    update();
  }
  function applyHistory(from, to) {
    if (busy || pointer || fillPreview || pending || !from.length) return;
    to.push(snapshot());
    restore(from.pop());
    status("Workspace history restored.");
  }
  function setZoom(value, x = canvas.clientWidth / 2, y = canvas.clientHeight / 2) {
    if (pointer || fillPreview || busy || pending) return;
    const worldX = camera.x + x / camera.zoom;
    const worldY = camera.y + y / camera.zoom;
    camera.zoom = Math.max(0.1, Math.min(4, value));
    camera.x = worldX - x / camera.zoom;
    camera.y = worldY - y / camera.zoom;
    update();
  }
  canvas.addEventListener("pointerdown", event => {
    if (!world || busy || pending || pointer || fillPreview) return;
    canvas.focus();
    if (event.button === 1 || (event.button === 0 && space)) {
      pointer = { mode: "pan", x: event.clientX, y: event.clientY, camera: { ...camera } };
    } else if (event.button === 0) {
      const worldPoint = point(event);
      if (tool === "brush") {
        pointer = { mode: "brush", before: snapshot(), assetId: $("#world-brush-asset").value,
          stroke: { cells: new Map(), last: null, error: null } };
        extendTerrainStroke(pointer.stroke, worldPoint);
      } else if (tool === "fill") {
        pointer = { mode: "fill", before: snapshot(), assetId: $("#world-brush-asset").value, start: worldPoint };
        updateRectangle(pointer, worldPoint);
      } else {
        const local = worldToSection(worldPoint.x, worldPoint.y);
        const section = world.sections.find(item => item.gridX === local.gridX && item.gridY === local.gridY);
        const object = section && editor.hitTest(section.document, { x: local.x, y: local.y });
        selection = object ? { sectionId: section.sectionId, objectId: object.id } : null;
        pointer = object ? { mode: "move", section, object, start: worldPoint, before: snapshot(), invalid: null } : null;
        update();
      }
    }
    if (pointer) {
      canvas.setPointerCapture(event.pointerId);
      event.preventDefault();
      update();
    }
  });
  canvas.addEventListener("pointermove", event => {
    if (!pointer) return;
    if (pointer.mode === "fill") {
      updateRectangle(pointer, point(event));
      update();
      return;
    }
    if (pointer.mode === "brush") {
      for (const sample of event.getCoalescedEvents?.() ?? []) extendTerrainStroke(pointer.stroke, point(sample));
      extendTerrainStroke(pointer.stroke, point(event));
      update();
      return;
    }
    if (pointer.mode === "pan") {
      camera.x = pointer.camera.x - (event.clientX - pointer.x) / camera.zoom;
      camera.y = pointer.camera.y - (event.clientY - pointer.y) / camera.zoom;
      draw();
      return;
    }
    const current = point(event);
    const transform = editor.transform(pointer.object, current.x - pointer.start.x, current.y - pointer.start.y);
    const original = pointer.before.documents[world.sections.indexOf(pointer.section)];
    try {
      const next = { ...original, objects: original.objects.map(item => item.id === pointer.object.id ? { ...item, transform } : item) };
      pointer.section.document = editor.validate(next);
      pointer.invalid = null;
    } catch (error) {
      pointer.section.document = original;
      pointer.invalid = error.message;
    }
    update();
  });
  function updateRectangle(fill, end) {
    try {
      fill.rectangle = terrainRectangle(fill.start, end);
      fill.error = null;
    } catch (error) {
      fill.rectangle = null;
      fill.error = error.message;
    }
  }
  function commitTerrain(before, assetId, cells, label) {
    try {
      const updates = planTerrainStroke(world.sections, cells, {
        assetId, assetCatalog: editor.assetCatalog, layerState: editor.terrainLayer(),
        createObject: editor.createObject, validate: editor.validate
      });
      if (updates.length) {
        undo.push(before);
        if (undo.length > 100) undo.shift();
        redo = [];
        for (const update of updates) {
          world.sections.find(section => section.sectionId === update.sectionId).document = update.document;
        }
        status(`${label} applied to ${updates.length} section(s).`);
      } else status(`${label} unchanged (identical cells).`);
    } catch (error) { status(`${label} rejected: ${error.message}`, true); }
  }
  function finish(cancelled) {
    if (!pointer) return;
    if (pointer.mode === "fill") {
      if (cancelled) status("Rectangle fill cancelled; no sections changed.");
      else if (pointer.error) status(`Rectangle fill rejected: ${pointer.error}`, true);
      else {
        fillPreview = pointer;
        status("Review the rectangle, then Apply or Cancel.");
      }
    }
    if (pointer.mode === "brush") {
      if (cancelled) status("Terrain stroke cancelled; no sections changed.");
      else if (pointer.stroke.error) status(`Terrain stroke rejected: ${pointer.stroke.error}`, true);
      else commitTerrain(pointer.before, pointer.assetId, pointer.stroke.cells.values(), "Terrain stroke");
    }
    if (pointer.mode === "move") {
      if (cancelled || pointer.invalid) {
        restore(pointer.before);
        if (pointer.invalid) status(`Move rejected: ${pointer.invalid}`, true);
      } else if (JSON.stringify(pointer.before.documents) !== JSON.stringify(documents())) {
        undo.push(pointer.before);
        if (undo.length > 100) undo.shift();
        redo = [];
        status("Object moved within its section.");
      }
    }
    pointer = null;
    update();
  }
  canvas.addEventListener("pointerup", event => {
    if (pointer?.mode === "brush") extendTerrainStroke(pointer.stroke, point(event));
    if (pointer?.mode === "fill") updateRectangle(pointer, point(event));
    finish(false);
  });
  canvas.addEventListener("pointercancel", () => finish(true));
  canvas.addEventListener("lostpointercapture", () => finish(true));
  canvas.addEventListener("wheel", event => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    setZoom(camera.zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1), event.clientX - rect.left, event.clientY - rect.top);
  }, { passive: false });
  workspace.addEventListener("keydown", event => {
    if (event.code === "Escape" && (pointer?.mode === "brush" || pointer?.mode === "fill" || fillPreview)) {
      event.preventDefault();
      if (pointer) finish(true);
      else cancelFill();
      return;
    }
    if (event.code === "Space" && event.target === canvas) { space = true; event.preventDefault(); }
    if ((event.ctrlKey || event.metaKey) && event.code === "KeyS") { event.preventDefault(); save(); }
    if ((event.ctrlKey || event.metaKey) && event.code === "KeyZ") { event.preventDefault(); applyHistory(event.shiftKey ? redo : undo, event.shiftKey ? undo : redo); }
    if ((event.ctrlKey || event.metaKey) && event.code === "KeyY") { event.preventDefault(); applyHistory(redo, undo); }
  });
  workspace.addEventListener("keyup", event => { if (event.code === "Space") space = false; });
  window.addEventListener("blur", () => { space = false; });
  window.addEventListener("beforeunload", event => { if (dirty() || pending || pointer || fillPreview) event.preventDefault(); });
  $("#world-zoom-in").addEventListener("click", () => setZoom(camera.zoom * 1.2));
  $("#world-zoom-out").addEventListener("click", () => setZoom(camera.zoom / 1.2));
  $("#world-undo").addEventListener("click", () => applyHistory(undo, redo));
  $("#world-redo").addEventListener("click", () => applyHistory(redo, undo));
  $("#world-select-tool").addEventListener("click", () => { tool = "select"; update(); });
  $("#world-brush-tool").addEventListener("click", () => { tool = "brush"; update(); });
  $("#world-fill-tool").addEventListener("click", () => { tool = "fill"; update(); });
  function cancelFill() {
    fillPreview = null;
    status("Rectangle fill cancelled; no sections changed.");
    update();
  }
  $("#world-fill-cancel").addEventListener("click", cancelFill);
  $("#world-fill-apply").addEventListener("click", () => {
    if (!fillPreview || pointer || busy || pending) return;
    const fill = fillPreview;
    fillPreview = null;
    commitTerrain(fill.before, fill.assetId, terrainRectangleCells(fill.rectangle), "Rectangle fill");
    update();
  });
  for (const id of ["world-terrain-visible", "world-terrain-locked"]) {
    $(`#${id}`).addEventListener("change", () => {
      editor.setTerrainLayer({ visible: $("#world-terrain-visible").checked, locked: $("#world-terrain-locked").checked });
      scenes.clear();
      update();
    });
  }
  async function save() {
    if (!world || busy || pointer || fillPreview || (!dirty() && !pending)) return;
    if (!pending) pending = { operationId: `save-${crypto.randomUUID()}`, revision: world.revision,
      sections: world.sections.map(section => ({ sectionId: section.sectionId, revision: section.revision,
        document: structuredClone(section.document) })) };
    busy = true;
    update();
    try {
      const result = await request(url(world.projectId, world.worldId), "PUT", pending);
      world = result;
      baseline = JSON.stringify(documents());
      pending = null;
      scenes.clear();
      status("Both sections saved transactionally.");
    } catch (error) {
      if (error.status >= 400 && error.status < 500) pending = null;
      status(`Save failed: ${error.message}. ${pending ? "Retry to reconcile the same save." : "Your edits remain open."}`, true);
    } finally { busy = false; update(); }
  }
  $("#world-save").addEventListener("click", save);
  function close() {
    if (busy || pointer || fillPreview) return;
    if (pending) { status("Retry the pending save before closing; its outcome is unknown.", true); return; }
    if (dirty() && !window.confirm("Discard unsaved world changes? Cancel keeps the workspace open.")) return;
    workspace.close();
    world = null;
    scenes.clear();
  }
  $("#world-close").addEventListener("click", close);
  workspace.addEventListener("cancel", event => {
    event.preventDefault();
    if (pointer?.mode === "brush" || pointer?.mode === "fill") finish(true);
    else if (fillPreview) cancelFill();
    else close();
  });
  new ResizeObserver(() => draw()).observe(canvas);
  function openWorld(result) {
    if (result.projectId !== editor.projectId || result.model !== editor.model || result.sections.length !== 2) {
      throw new Error("The world identity or model does not match the selected game.");
    }
    for (const section of result.sections) {
      sectionOrigin(section.gridX, section.gridY);
      section.document = editor.validate(section.document);
    }
    world = result;
    baseline = JSON.stringify(documents());
    selection = null;
    undo = [];
    redo = [];
    pending = null;
    fillPreview = null;
    tool = "select";
    $("#world-brush-asset").replaceChildren(...Object.entries(editor.assetCatalog)
      .filter(([, asset]) => isTerrainBrushAsset(asset)).map(([id, asset]) => new Option(asset.label, id)));
    $("#world-terrain-visible").checked = editor.terrainLayer().visible;
    $("#world-terrain-locked").checked = editor.terrainLayer().locked;
    scenes.clear();
    const first = sectionOrigin(world.sections[0].gridX, world.sections[0].gridY);
    camera = { x: first.x, y: first.y, zoom: 0.25 };
    chooser.close();
    $("#world-workspace-title").textContent = world.name;
    workspace.showModal();
    status("World opened. Section coordinates are shown on the canvas.");
    update();
  }
  async function listWorlds() {
    const result = await request(url(editor.projectId));
    $("#world-list").replaceChildren(...result.worlds.filter(item => item.model === editor.model)
      .map(item => new Option(item.name, item.worldId)));
    $("#world-open").disabled = !$("#world-list").value;
  }
  $("#worlds-button").addEventListener("click", async () => {
    editor = getEditor();
    if (!editor) return;
    $("#world-dialog-status").textContent = "Loading worlds…";
    $("#world-open").disabled = true;
    chooser.showModal();
    try { await listWorlds(); $("#world-dialog-status").textContent = ""; }
    catch (error) { $("#world-dialog-status").textContent = error.message; }
  });
  $("#world-dialog-close").addEventListener("click", () => chooser.close());
  $("#world-create").addEventListener("click", async () => {
    $("#world-create").disabled = true;
    try {
      const gridX = Number($("#world-grid-x").value);
      const gridY = Number($("#world-grid-y").value);
      const result = await request(url(editor.projectId), "POST", { name: $("#world-name").value,
        sourceMapId: editor.mapId, positions: [{ gridX, gridY }, { gridX: gridX + 1, gridY }] });
      openWorld(result);
    } catch (error) { $("#world-dialog-status").textContent = error.message; }
    finally { $("#world-create").disabled = false; }
  });
  $("#world-open").addEventListener("click", async () => {
    $("#world-open").disabled = true;
    try { openWorld(await request(url(editor.projectId, $("#world-list").value))); }
    catch (error) { $("#world-dialog-status").textContent = error.message; }
    finally { $("#world-open").disabled = !$("#world-list").value; }
  });
  return Object.freeze({
    inspect: () => world && ({
      world: structuredClone(world), selection: structuredClone(selection), camera: { ...camera },
      dirty: Boolean(dirty()), undoCount: undo.length, redoCount: redo.length, gesture: pointer?.mode ?? null,
      fillPreview: structuredClone(fillPreview?.rectangle ?? null)
    })
  });
}
