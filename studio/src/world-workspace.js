import { sectionOrigin, worldToSection } from "../world-coordinates.js";

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
  let space = false;
  let busy = false;
  let pending = null;
  let undo = [];
  let redo = [];
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
    $("#world-zoom-label").textContent = `${Math.round(camera.zoom * 100)}%`;
    $("#world-save").disabled = busy || Boolean(pointer) || (!dirty() && !pending);
    $("#world-undo").disabled = busy || Boolean(pointer) || Boolean(pending) || !undo.length;
    $("#world-redo").disabled = busy || Boolean(pointer) || Boolean(pending) || !redo.length;
    $("#world-close").disabled = busy || Boolean(pointer);
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
      context.strokeStyle = "#ffd166";
      context.lineWidth = 3 / camera.zoom;
      context.strokeRect(origin.x, origin.y, 2048, 2048);
      context.fillStyle = "#20242b";
      context.fillRect(origin.x + 8 / camera.zoom, origin.y + 8 / camera.zoom, 250 / camera.zoom, 32 / camera.zoom);
      context.fillStyle = "#fff";
      context.font = `${16 / camera.zoom}px sans-serif`;
      context.fillText(`Section (${section.gridX}, ${section.gridY})`, origin.x + 16 / camera.zoom, origin.y + 30 / camera.zoom);
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
    if (busy || pointer || pending || !from.length) return;
    to.push(snapshot());
    restore(from.pop());
    status("Workspace history restored.");
  }
  function setZoom(value, x = canvas.clientWidth / 2, y = canvas.clientHeight / 2) {
    const worldX = camera.x + x / camera.zoom;
    const worldY = camera.y + y / camera.zoom;
    camera.zoom = Math.max(0.1, Math.min(4, value));
    camera.x = worldX - x / camera.zoom;
    camera.y = worldY - y / camera.zoom;
    update();
  }
  canvas.addEventListener("pointerdown", event => {
    if (!world || busy || pending || pointer) return;
    canvas.focus();
    if (event.button === 1 || (event.button === 0 && space)) {
      pointer = { mode: "pan", x: event.clientX, y: event.clientY, camera: { ...camera } };
    } else if (event.button === 0) {
      const worldPoint = point(event);
      const local = worldToSection(worldPoint.x, worldPoint.y);
      const section = world.sections.find(item => item.gridX === local.gridX && item.gridY === local.gridY);
      const object = section && editor.hitTest(section.document, { x: local.x, y: local.y });
      selection = object ? { sectionId: section.sectionId, objectId: object.id } : null;
      pointer = object ? { mode: "move", section, object, start: worldPoint, before: snapshot(), invalid: null } : null;
      update();
    }
    if (pointer) {
      canvas.setPointerCapture(event.pointerId);
      event.preventDefault();
      update();
    }
  });
  canvas.addEventListener("pointermove", event => {
    if (!pointer) return;
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
  function finish(cancelled) {
    if (!pointer) return;
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
  canvas.addEventListener("pointerup", () => finish(false));
  canvas.addEventListener("pointercancel", () => finish(true));
  canvas.addEventListener("wheel", event => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    setZoom(camera.zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1), event.clientX - rect.left, event.clientY - rect.top);
  }, { passive: false });
  workspace.addEventListener("keydown", event => {
    if (event.code === "Space" && event.target === canvas) { space = true; event.preventDefault(); }
    if ((event.ctrlKey || event.metaKey) && event.code === "KeyS") { event.preventDefault(); save(); }
    if ((event.ctrlKey || event.metaKey) && event.code === "KeyZ") { event.preventDefault(); applyHistory(event.shiftKey ? redo : undo, event.shiftKey ? undo : redo); }
    if ((event.ctrlKey || event.metaKey) && event.code === "KeyY") { event.preventDefault(); applyHistory(redo, undo); }
  });
  workspace.addEventListener("keyup", event => { if (event.code === "Space") space = false; });
  window.addEventListener("blur", () => { space = false; });
  window.addEventListener("beforeunload", event => { if (dirty() || pending) event.preventDefault(); });
  $("#world-zoom-in").addEventListener("click", () => setZoom(camera.zoom * 1.2));
  $("#world-zoom-out").addEventListener("click", () => setZoom(camera.zoom / 1.2));
  $("#world-undo").addEventListener("click", () => applyHistory(undo, redo));
  $("#world-redo").addEventListener("click", () => applyHistory(redo, undo));
  async function save() {
    if (!world || busy || pointer || (!dirty() && !pending)) return;
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
    if (busy || pointer) return;
    if (pending) { status("Retry the pending save before closing; its outcome is unknown.", true); return; }
    if (dirty() && !window.confirm("Discard unsaved world changes? Cancel keeps the workspace open.")) return;
    workspace.close();
    world = null;
    scenes.clear();
  }
  $("#world-close").addEventListener("click", close);
  workspace.addEventListener("cancel", event => { event.preventDefault(); close(); });
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
}
