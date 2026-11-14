import { validateMapDefinition } from "@multiplayer-game/theme-sdk";
import { ASSET_CATALOG, createFloorMap, drawDesign, MODEL } from "./project.js";

const metadata = Object.freeze({ id: MODEL, version: "1.0.0", stateSchemaVersion: 1 });
export function genericPreview(design, assetCatalog = ASSET_CATALOG) {
  const map = validateMapDefinition(createFloorMap(design, assetCatalog));
  return {
    map, settings: { moveDistance: 4 }, seed: 1,
    roster: [{ accountId: "player", username: "Player", joinedOrder: 0 }],
    viewer: { accountId: "player", role: "player" },
    moduleFactory: {
      metadata,
      validateSettings: settings => settings?.moveDistance === 4,
      create(context, settings, roster) {
        const inputs = new Map();
        let tick = 0;
        return {
          stateSchemaVersion: 1,
          get state() { return { tick }; },
          initialize() {
            roster.forEach((player, index) => context.entities.add({
              id: `player:${player.accountId}`, typeId: "generic-player", radius: 8,
              position: map.spawns[index % map.spawns.length].position,
              state: { accountId: player.accountId }
            }));
          },
          validateInput: input => input?.type === "move" &&
            [input.x, input.y].every(value => Number.isFinite(value) && Math.abs(value) <= 1),
          applyInput(accountId, input) { inputs.set(accountId, { x: input.x, y: input.y }); },
          setPlayerPresence() {},
          step(_dt, nextTick) {
            tick = nextTick;
            for (const player of context.entities.values()) {
              const input = inputs.get(player.state.accountId);
              if (!input) continue;
              const scale = settings.moveDistance / Math.max(1, Math.hypot(input.x, input.y));
              const position = context.geometry.moveCircle(player.position,
                { x: input.x * scale, y: input.y * scale }, player.radius);
              context.entities.update(player.id, current => ({ ...current, position }));
            }
          },
          snapshot() { return { tick, players: context.entities.values().map(player => ({ position: player.position })) }; },
          results() { return { tick }; },
          dispose() { inputs.clear(); }
        };
      }
    }
  };
}
export function genericSkin(design, assetCatalog = ASSET_CATALOG, artwork = null) {
  return {
    metadata: { id: `${MODEL}-skin`, version: "1.0.0", acceptedModuleId: MODEL, acceptedStateSchemaVersions: [1] },
    mount(host) {
      const slot = host.slots.get("world");
      if (!slot) throw new Error("Generic preview requires a world slot.");
      const canvas = document.createElement("canvas");
      canvas.tabIndex = 0;
      canvas.setAttribute("aria-label", "Generic movement preview");
      canvas.dataset.testid = "generic-preview";
      Object.assign(canvas.style, { width: "100%", height: "100%", display: "block", outline: "none" });
      slot.append(canvas);
      const context = canvas.getContext("2d");
      const keys = new Set();
      const listeners = new AbortController();
      const neutral = () => { keys.clear(); host.dispatchInput({ type: "move", x: 0, y: 0 }); };
      const codes = { ArrowLeft: [-1, 0], KeyA: [-1, 0], ArrowRight: [1, 0], KeyD: [1, 0],
        ArrowUp: [0, -1], KeyW: [0, -1], ArrowDown: [0, 1], KeyS: [0, 1] };
      for (const eventName of ["keydown", "keyup"]) canvas.addEventListener(eventName, event => {
        if (!codes[event.code]) return;
        event.preventDefault();
        if (eventName === "keydown") keys.add(event.code);
        else keys.delete(event.code);
      }, { signal: listeners.signal });
      for (const target of [canvas, window]) target.addEventListener("blur", neutral, { signal: listeners.signal });
      canvas.addEventListener("pointerdown", () => canvas.focus(), { signal: listeners.signal });
      document.addEventListener("visibilitychange", () => { if (document.hidden) neutral(); }, { signal: listeners.signal });
      let snapshot;
      return {
        handleSnapshot(value) { snapshot = value; },
        handleEvents() {},
        handleViewport() {},
        render() {
          if (!snapshot) return;
          const movement = [...keys].reduce((sum, code) => ({ x: sum.x + codes[code][0], y: sum.y + codes[code][1] }), { x: 0, y: 0 });
          host.dispatchInput({ type: "move", x: Math.sign(movement.x), y: Math.sign(movement.y) });
          const viewportWidth = Math.max(1, canvas.clientWidth);
          const viewportHeight = Math.max(1, canvas.clientHeight);
          const pixelRatio = window.devicePixelRatio || 1;
          canvas.width = Math.max(1, Math.round(viewportWidth * pixelRatio));
          canvas.height = Math.max(1, Math.round(viewportHeight * pixelRatio));
          const player = snapshot.players[0]?.position;
          const cameraAxis = (position, worldSize, viewportSize) => worldSize <= viewportSize
            ? (worldSize - viewportSize) / 2
            : Math.max(0, Math.min(worldSize - viewportSize, position - viewportSize / 2));
          const cameraX = cameraAxis(player?.x ?? design.bounds.width / 2, design.bounds.width, viewportWidth);
          const cameraY = cameraAxis(player?.y ?? design.bounds.height / 2, design.bounds.height, viewportHeight);
          context.fillStyle = "#22252b";
          context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
          context.fillRect(0, 0, viewportWidth, viewportHeight);
          context.imageSmoothingEnabled = false;
          context.setTransform(pixelRatio, 0, 0, pixelRatio, -cameraX * pixelRatio, -cameraY * pixelRatio);
          drawDesign(context, artwork, design, { mode: "play", assetCatalog });
          canvas.dataset.importedAssetIds = JSON.stringify(design.objects
            .filter(object => assetCatalog[object.assetId].imported).map(object => object.assetId));
          for (const activePlayer of snapshot.players) {
            context.fillStyle = "#087f5b";
            context.beginPath();
            context.arc(activePlayer.position.x, activePlayer.position.y, 8, 0, Math.PI * 2);
            context.fill();
          }
          canvas.dataset.position = JSON.stringify(player);
          canvas.dataset.cameraX = String(cameraX);
          canvas.dataset.cameraY = String(cameraY);
          canvas.dataset.worldScale = String(context.getTransform().a * canvas.getBoundingClientRect().width / canvas.width);
          canvas.dataset.pixelRatio = String(pixelRatio);
          canvas.dataset.tick = String(snapshot.tick);
        },
        dispose() { neutral(); listeners.abort(); canvas.remove(); }
      };
    }
  };
}
