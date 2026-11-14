/* Theme Credits (generated)
 * Project: Local Preview Sample
 * Author: Scott Zastrow
 * Description: Renders sample movement, map, score and accessible controls.
 * End Theme Credits
 */
import { sampleMap } from "./map.js";
import { sampleSettings } from "./settings.js";
import { readStandardGamepad } from "@multiplayer-game/theme-sdk";

export const sampleSkinFactory = Object.freeze({
  metadata: Object.freeze({
    id: "sample-grid-runner-skin",
    version: "1.0.0",
    acceptedModuleId: "sample-grid-runner",
    acceptedStateSchemaVersions: Object.freeze([1])
  }),

  mount(host) {
    const worldSlot = host.slots.get("world");
    const hudSlot = host.slots.get("hud");
    const controlsSlot = host.slots.get("controls");
    if (!worldSlot || !hudSlot || !controlsSlot) {
      throw new Error("The sample skin requires world, hud and controls slots.");
    }

    const world = document.createElement("section");
    world.dataset.testid = "sample-world";
    const arena = document.createElement("div");
    arena.setAttribute("role", "img");
    arena.setAttribute("aria-label", `${sampleMap.name} game map`);
    arena.tabIndex = 0;
    Object.assign(arena.style, {
      position: "relative",
      width: `${sampleMap.bounds.width * 2}px`,
      height: `${sampleMap.bounds.height * 2}px`,
      overflow: "hidden",
      border: "1px solid #263238",
      background: "#eef4f7"
    });
    const mapObjects = new Map(sampleMap.objects.map(object => [object.id, object]));
    const walls = [];
    for (const collision of sampleMap.collisions) {
      const object = mapObjects.get(collision.objectId);
      if (!object) throw new Error(`Missing sample map object ${collision.objectId}.`);
      const wall = document.createElement("div");
      wall.setAttribute("aria-hidden", "true");
      Object.assign(wall.style, {
        position: "absolute",
        left: `${(object.position.x - collision.shape.width / 2) * 2}px`,
        top: `${(object.position.y - collision.shape.height / 2) * 2}px`,
        width: `${collision.shape.width * 2}px`,
        height: `${collision.shape.height * 2}px`,
        background: "#52616b"
      });
      arena.append(wall);
      walls.push(wall);
    }
    const playerToken = document.createElement("div");
    playerToken.dataset.testid = "sample-player";
    playerToken.setAttribute("aria-hidden", "true");
    Object.assign(playerToken.style, {
      position: "absolute",
      width: "16px",
      height: "16px",
      borderRadius: "50%",
      background: "#087f5b",
      border: "2px solid white",
      boxSizing: "border-box"
    });
    arena.append(playerToken);
    const position = document.createElement("output");
    position.dataset.testid = "sample-position";
    const hud = document.createElement("output");
    hud.dataset.testid = "sample-hud";
    const listeners = new AbortController();
    const mode = document.createElement("select");
    mode.setAttribute("aria-label", "Control mode");
    for (const [value, label] of [
      ["keyboard-only", "Keyboard Only"], ["keyboard-mouse", "Keyboard + Mouse"],
      ["game-controller", "Game Controller"]
    ]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      mode.append(option);
    }
    mode.value = sampleSettings.controlMode ?? "keyboard-mouse";
    const help = document.createElement("p");
    help.textContent = "Focus the map. Keyboard Only: WASD, Left/Right to turn, Space to fire. " +
      "Keyboard + Mouse: arrows, pointer aim, left click to fire. " +
      "Controller: left stick, right stick, right trigger. Stop or blur clears input. " +
      "Shots are a local counter, not combat.";
    const controllerStatus = document.createElement("output");
    controllerStatus.dataset.testid = "controller-status";
    controllerStatus.setAttribute("role", "status");
    controlsSlot.append(mode, help, controllerStatus);
    const keys = new Set();
    let facing = { x: 1, y: 0 };
    let fire = false;
    let pointerAim = false;
    let buttonMovement;
    let lastRenderAt;
    function neutral() {
      keys.clear();
      fire = false;
      buttonMovement = undefined;
      host.dispatchInput({ type: "move", x: 0, y: 0, aim: facing, fire: false });
    }
    function listen(target, event, handler) {
      target.addEventListener(event, handler, { signal: listeners.signal });
    }
    listen(mode, "change", () => { neutral(); arena.focus(); });
    listen(arena, "blur", neutral);
    listen(window, "blur", neutral);
    listen(document, "visibilitychange", () => { if (document.hidden) neutral(); });
    listen(arena, "keydown", event => {
      const codes = mode.value === "keyboard-only"
        ? ["KeyW", "KeyA", "KeyS", "KeyD", "ArrowLeft", "ArrowRight", "Space"]
        : mode.value === "keyboard-mouse"
          ? ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"] : [];
      if (!codes.includes(event.code)) return;
      event.preventDefault();
      buttonMovement = undefined;
      if (!keys.has(event.code)) {
        keys.add(event.code);
        const direction = keyboardMovement();
        if (direction.x || direction.y) { facing = direction; pointerAim = false; }
      }
    });
    listen(arena, "keyup", event => {
      if (keys.delete(event.code)) event.preventDefault();
    });
    listen(arena, "pointermove", event => {
      if (mode.value !== "keyboard-mouse" || !current) return;
      const player = current.players.find(player => player.accountId === current.viewerAccountId);
      const rect = arena.getBoundingClientRect();
      facing = { x: (event.clientX - rect.left) / 2 - player.position.x,
        y: (event.clientY - rect.top) / 2 - player.position.y };
      pointerAim = true;
    });
    listen(arena, "pointerdown", event => {
      arena.focus();
      if (mode.value === "keyboard-mouse" && event.button === 0) fire = true;
    });
    listen(window, "pointerup", () => { fire = false; });
    listen(arena, "pointercancel", () => { fire = false; });
    function keyboardMovement() {
      const keyboardOnly = mode.value === "keyboard-only";
      const x = Number(keys.has(keyboardOnly ? "KeyD" : "ArrowRight")) -
        Number(keys.has(keyboardOnly ? "KeyA" : "ArrowLeft"));
      const y = Number(keys.has(keyboardOnly ? "KeyS" : "ArrowDown")) -
        Number(keys.has(keyboardOnly ? "KeyW" : "ArrowUp"));
      const magnitude = Math.max(1, Math.hypot(x, y));
      return { x: x / magnitude, y: y / magnitude };
    }
    const buttons = [];
    for (const input of [
      { label: "Move west", x: -1, y: 0 },
      { label: "Move east", x: 1, y: 0 },
      { label: "Stop", x: 0, y: 0 }
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = input.label;
      const listener = () => {
        neutral();
        buttonMovement = { x: input.x, y: input.y };
        host.dispatchInput({ type: "move", x: input.x, y: input.y });
      };
      button.addEventListener("click", listener);
      buttons.push({ button, listener });
      controlsSlot.append(button);
    }
    world.append(arena, position);
    worldSlot.append(world);
    hudSlot.append(hud);
    let current;
    let disposed = false;

    return {
      handleSnapshot(snapshot) {
        if (disposed) return;
        current = snapshot;
      },
      handleEvents() {},
      render(time) {
        if (disposed || !current) return;
        const elapsed = lastRenderAt === undefined ? 0 : Math.min(0.1, Math.max(0, (time - lastRenderAt) / 1000));
        lastRenderAt = time;
        if (!buttonMovement && document.activeElement === arena && !document.hidden) {
          let movement = keyboardMovement();
          let firing = fire || (mode.value === "keyboard-only" && keys.has("Space"));
          if (mode.value === "game-controller") {
            const input = readStandardGamepad(navigator.getGamepads?.());
            controllerStatus.textContent = `Controller ${input.status}${input.id ? `: ${input.id}` : ""}`;
            movement = input.movement;
            if (input.aim) facing = input.aim;
            firing = input.fire;
          } else {
            controllerStatus.textContent = "";
            if (mode.value === "keyboard-only" && !pointerAim) {
              const angle = Math.atan2(facing.y, facing.x) +
                (Number(keys.has("ArrowRight")) - Number(keys.has("ArrowLeft"))) * Math.PI * elapsed;
              facing = { x: Math.cos(angle), y: Math.sin(angle) };
            }
          }
          host.dispatchInput({ type: "move", ...movement, aim: facing, fire: firing });
        }
        const player = current.players.find(({ accountId }) =>
          accountId === current.viewerAccountId);
        if (!player) throw new Error("The sample snapshot is missing its viewer.");
        playerToken.style.left = `${player.position.x * 2 - 8}px`;
        playerToken.style.top = `${player.position.y * 2 - 8}px`;
        position.textContent = `Position ${player.position.x}, ${player.position.y}`;
        hud.textContent = `${player.username}: ${player.points} points · tick ${current.tick} · shots ${player.shots}`;
        playerToken.style.transform = `rotate(${Math.atan2(player.facing.y, player.facing.x)}rad)`;
        playerToken.style.borderRightColor = "#f59f00";
      },
      handleViewport() {},
      dispose() {
        if (disposed) return;
        disposed = true;
        neutral();
        listeners.abort();
        for (const { button, listener } of buttons) {
          button.removeEventListener("click", listener);
        }
        for (const wall of walls) wall.remove();
        world.remove();
        hud.remove();
        for (const { button } of buttons) button.remove();
        mode.remove();
        help.remove();
        controllerStatus.remove();
        current = undefined;
      }
    };
  }
});
