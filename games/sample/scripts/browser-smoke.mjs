import assert from "node:assert/strict";

const origin = process.env.BROWSER_TEST_ORIGIN ?? "http://127.0.0.1:5174";
const debugUrl = process.env.BROWSER_DEBUG_URL ?? "http://127.0.0.1:9223";
const version = await (await fetch(`${debugUrl}/json/version`)).json();
const socket = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let nextId = 0;
const pending = new Map();
const exceptions = [];
socket.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data);
  if (message.method === "Runtime.exceptionThrown") {
    exceptions.push(message.params.exceptionDetails.exception?.description ?? "Browser exception");
  }
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  clearTimeout(request.timeout);
  if (message.error) request.reject(new Error(message.error.message));
  else request.resolve(message.result);
});

function cdp(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, 10_000);
    pending.set(id, { resolve, reject, timeout });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

async function evaluate(sessionId, expression) {
  const response = await cdp("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  }, sessionId);
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description ?? "Browser evaluation failed.");
  }
  return response.result.value;
}

async function waitFor(sessionId, expression) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await evaluate(sessionId, expression)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("The browser did not reach the expected local-preview state.");
}

function readXExpression() {
  return `Number(document.querySelector('[data-testid="sample-world"]')?.textContent.match(/Position ([\\d.]+)/)?.[1])`;
}

let targetId;
let sessionId;
try {
  const target = await cdp("Target.createTarget", { url: origin });
  targetId = target.targetId;
  ({ sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true }));
  await cdp("Page.enable", {}, sessionId);
  await cdp("Runtime.enable", {}, sessionId);
  await waitFor(sessionId, `document.querySelector("#preview-status")?.textContent.includes("running")`);
  assert.equal(
    await evaluate(sessionId, `document.querySelector('[role="img"]')?.getAttribute("aria-label") === "One Wall game map"`),
    true,
    "the selected map renders in the sample skin"
  );
  const initialX = await evaluate(sessionId, readXExpression());
  if (process.env.SAMPLE_EXPECTED_STEP) {
    const step = Number(process.env.SAMPLE_EXPECTED_STEP);
    assert.ok(Number.isFinite(step) && step > 0);
    const editedStep = await evaluate(sessionId, `(async () => {
      const { createLocalGame } = await import("/node_modules/@multiplayer-game/local-preview/dist/index.js");
      const { sampleGameModule } = await import("/src/game.js");
      const { sampleMap } = await import("/src/map.js");
      const { sampleSettings } = await import("/src/settings.js");
      const game = await createLocalGame({
        moduleFactory: sampleGameModule, settings: sampleSettings, map: sampleMap,
        seed: 42, roster: [{ accountId: "edited", username: "Edited", joinedOrder: 0 }],
        viewer: { accountId: "edited", role: "player" }
      });
      try {
        const before = game.snapshot.players[0].position.x;
        game.sendInput("edited", { type: "move", x: 1, y: 0 });
        game.step();
        return game.snapshot.players[0].position.x - before;
      } finally { game.dispose(); }
    })()`);
    assert.equal(editedStep, step, "browser-loaded edited module has the exact expected movement");
    console.log(`Browser-loaded source edit: one-step movement ${editedStep}.`);
  }
  await evaluate(sessionId, `[...document.querySelectorAll("button")].find(button => button.textContent === "Move east").click()`);
  await waitFor(sessionId, `${readXExpression()} > ${initialX}`);
  const movedX = await evaluate(sessionId, readXExpression());
  assert.ok(movedX > initialX, `module input moved the rendered player (${initialX} -> ${movedX})`);
  assert.ok(movedX <= 104, `player remains on the west side of the configured wall (${movedX})`);
  assert.ok(await evaluate(sessionId, `document.querySelector('[data-testid="sample-player"]')?.style.left`));
  await evaluate(sessionId, `[...document.querySelectorAll("button")].find(button => button.textContent === "Stop").click()`);
  const stoppedX = await evaluate(sessionId, readXExpression());
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(await evaluate(sessionId, readXExpression()), stoppedX, "stop input ends movement");
  assert.equal(await evaluate(sessionId, `document.querySelector('[data-testid="sample-hud"]')?.textContent.includes("points")`), true);
  const expectedStep = process.env.SAMPLE_EXPECTED_STEP
    ? Number(process.env.SAMPLE_EXPECTED_STEP)
    : null;
  assert.ok(expectedStep === null || (Number.isFinite(expectedStep) && expectedStep > 0));
  const controllerResult = await evaluate(sessionId,
    `(async () => (await import("/scripts/controller-smoke-browser.js")).runControllerSmoke(${JSON.stringify(expectedStep)}))()`);
  assert.ok(Math.abs(controllerResult.angle + 90 * controllerResult.blend) < 1e-9);
  assert.ok(Math.abs(controllerResult.distance - controllerResult.expectedDistance) < 1e-9);
  assert.equal(controllerResult.stationary, true);
  assert.equal(controllerResult.shots, 1);
  await evaluate(sessionId, `(() => {
    window.simulatedPads = [{
      connected: true, mapping: "standard", id: "Browser simulation", axes: [0.575, 0, 0, -1],
      buttons: Array.from({length: 8}, (_, i) => ({pressed: false, value: i === 7 ? 0.5 : 0}))
    }];
    Object.defineProperty(navigator, "getGamepads", { configurable: true, value: () => window.simulatedPads });
    const select = document.querySelector('[aria-label="Control mode"]');
    select.value = "game-controller";
    select.dispatchEvent(new Event("change"));
  })()`);
  const controllerStart = await evaluate(sessionId, readXExpression());
  await waitFor(sessionId, `${readXExpression()} > ${controllerStart} &&
    document.querySelector('[data-testid="controller-status"]').textContent.includes("connected")`);
  await evaluate(sessionId, `window.simulatedPads = []`);
  await waitFor(sessionId, `document.querySelector('[data-testid="controller-status"]').textContent.includes("disconnected")`);
  await new Promise(resolve => setTimeout(resolve, 100));
  const disconnectedX = await evaluate(sessionId, readXExpression());
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(await evaluate(sessionId, readXExpression()), disconnectedX, "disconnect stops controller movement");
  for (const mode of ["keyboard-only", "keyboard-mouse"]) {
    await evaluate(sessionId, `(() => {
      const select = document.querySelector('[aria-label="Control mode"]');
      select.value = ${JSON.stringify(mode)}; select.dispatchEvent(new Event("change"));
    })()`);
    const before = await evaluate(sessionId, readXExpression());
    const code = mode === "keyboard-only" ? "KeyA" : "ArrowLeft";
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", code,
      key: mode === "keyboard-only" ? "a" : code }, sessionId);
    await waitFor(sessionId, `${readXExpression()} < ${before}`);
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", code,
      key: mode === "keyboard-only" ? "a" : code }, sessionId);
    await evaluate(sessionId, `document.querySelector('[aria-label="Control mode"]').focus()`);
    await new Promise(resolve => setTimeout(resolve, 100));
    const blurredX = await evaluate(sessionId, readXExpression());
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(await evaluate(sessionId, readXExpression()), blurredX, "blur clears keyboard movement");
  }
  await evaluate(sessionId, `(() => {
    const arena = document.querySelector('[role="img"]');
    arena.focus();
    const rect = arena.getBoundingClientRect();
    arena.dispatchEvent(new PointerEvent("pointermove", {
      clientX: rect.left + 200, clientY: rect.top + 10
    }));
    arena.dispatchEvent(new PointerEvent("pointerdown", { button: 0 }));
  })()`);
  await waitFor(sessionId, `/shots [1-9]/.test(document.querySelector('[data-testid="sample-hud"]').textContent)`);
  await evaluate(sessionId, `window.dispatchEvent(new PointerEvent("pointerup"))`);
  assert.deepEqual(exceptions, []);
  console.log(`Browser preview passed: rendered movement ${initialX} -> ${movedX}, stop input and HUD output verified.`);
  console.log(`Simulated controller passed: ${controllerResult.angle.toFixed(2)} degrees, ` +
    `${controllerResult.distance} units at half magnitude, stationary aim/fire, disconnect; both keyboard modes, mouse fire and blur passed. Physical hardware unverified.`);
} finally {
  if (targetId) await cdp("Target.closeTarget", { targetId }).catch(() => {});
  socket.close();
}
