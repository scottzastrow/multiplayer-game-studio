# Astraeum Tower — First Floor

Run from the Studio root with `npm run astraeum:dev -- --port 5180 --strictPort`,
then open `http://127.0.0.1:5180`. This uses the already-installed Vite and
public kit package files from the existing dependency installation; it does
not replace or reinstall `games/sample`.

The local preview loads the exact 36 × 22 Floor 1 grid and its original Aries
art. Studio Play offers three control modes, with the selected bindings shown
above the canvas. The standalone preview uses Keyboard + Mouse.

- **Keyboard Only:** WASD: Move · Arrow keys: Dodge · Space: Attack · H:
  use a healing herb. Chests open automatically nearby.
- **Keyboard + Mouse:** arrow keys move, the pointer aims, left click attacks,
  holding right mouse plus a directional arrow dodges, and H uses a healing
  herb. Chests open automatically nearby.
- **Game Controller:** the left stick moves, the right stick aims, right trigger
  attacks, B/Circle plus a left-stick direction dodges, and Y uses a healing
  herb. Chests open automatically nearby. Stick movement keeps its analog
  magnitude through the public standard-gamepad adapter.

Short attack presses are buffered to the next simulation step. Dodge preserves
Anh's 14-frame speed curve (6.2 px/frame at the start, tapering to 45%),
34-point stamina cost from 100, six-frame cooldown, and 0.9 stamina/frame
regeneration after a 30-frame delay. Dodge frames retain the original damage
invulnerability. A dodge press is edge-triggered and cannot repeat while held;
it requires a release/re-arm and sufficient stamina/cooldown.
Blur, disconnect, Stop, and control-mode changes clear queued input. Keyboard
and mouse/gamepad actions are translated to generic movement, aim, attack, and
dodge actions before reaching combat. Physical-controller testing remains
pending; the Studio browser smoke uses simulated standard-gamepad input.
Movement uses the original 2 px per 60 fps frame tuning, four-direction
movement, directional sprite sheets and anchors. The independent tilemap
adapter translates wall runs to public rectangular map collisions and
preserves the original wall-face collision band. Art pixels are rendered
without smoothing. The public map schema
requires two player spawns; a second open floor tile is reserved but unused
because this preview has only Aries.

The reusable world-space lighting renderer is in `src/lighting/world-lighting.js`;
Floor 1's configuration is separate in `src/lighting/tower-lighting.js`.
Ambient brightness, player-light radius, intensity and softness are validated
and adjustable in the screen-space panel; **Fully lit** disables the lighting
layer. The Tower defaults reproduce the original: 80% tinted darkness (`#06040e`),
equivalent to 20% ambient brightness; Aries's 200 px, full-intensity light is
centered 20 px above her feet. Its radial reveal uses stops at radius 0 (1.0),
55% (0.55), and 100% (0). World coordinates remain at the original 1:1 CSS-pixel
scale with 32 px tiles. The original renders through an 800 × 500 viewport,
subtracting its camera offset without scaling world coordinates. The adapted
viewport fills the available page area and follows Aries, clamping at the map
edges; if a viewport exceeds a map axis, the map is centered on that axis with
no scaling. Terrain, Aries, and world lighting share the camera translation.
The canvas backing store scales with device-pixel ratio while CSS coordinates
remain 1:1, and smoothing stays disabled for crisp artwork.

The original corner candles add warm lights with nominal 80 px radius, full
reveal intensity and the same radial falloff. Their radius flickers by
`6 * (1.2*sin(t*0.25 + phase) + 0.8*sin(t*0.61 + phase))`; their small flame
glow has a 10 px base radius. The staircase emits a steady violet 70 px light
at 0.35 intensity. These environment lights and the player light are rendered
in the world canvas only; HUD and controls remain separate screen-space overlays. No
wall-shadow occlusion or enemy detection was added. The public skin API provides a
per-view `cameraAnchor`; each mounted skin uses its own settings and anchor,
which supports independent views and spectator-follow wiring. This single-player
local preview does not verify multiplayer or spectator behavior. Brightness
and intensity accept 0–1, radius 1–1000 world px, and softness 0.01–0.99.

Aries's original collision body is an 18 × 8 px rectangle anchored at her feet,
with a 12 px wall-face band. The public entity circle is centered 4 px above
the feet with a 4 px radius (8 × 8 px), fully inside that body; the tilemap
adapter remains authoritative for the exact rectangular footprint. This
replaces the former 8 px radius circle (16 × 16 px), which was centered at the
feet for entity updates and could reject a clear step at tight wall corners.
The preview runs at 30 Hz and applies two 2 px movement substeps per tick, so
direction changes are sampled at 30 Hz even though movement speed is preserved.

The selected PNGs are byte-for-byte extractions of the embedded art in
`reference/astraeum-tower-original/dungeon/index.html`. Their source locations,
SHA-256 hashes, and Anh Nguyen's artwork credit are recorded in
`assets/provenance.json`. The reference folder is not used as a runtime
dependency and is left unchanged.

The first-floor encounter implements the original green slime's 36 HP,
230 px aggro range, 1 px/frame base speed with 2.3x hops, and 12 contact
damage, with 50 frames of player invulnerability after a hit. Aries's Halberd preserves
its 20 base damage, 50 px reach, 2.3 rad sweep, and 34-frame cooldown. Its
original 9-frame thrust is followed after 8 frames by a 13-frame sweep; the
original hit windows deal 10 then 20 damage. Both phases use the original
procedural bright thrust and sweeping crescent visuals, not invented sprite
frames. Damage numbers, hit sparks, knockback, and death particles are
procedural; the slime is drawn as a static Canvas shape, without invented
sprite or attack frames. The preview has this one-player encounter only;
player death/respawn, spells and other enemies remain pending. Collectible
herbs, glowcaps and gems auto-collect once; herbs enter inventory and H restores
up to 30 HP without consuming one at full health. Chests open once when Aries
approaches within 46 world pixels; no Interact input is required. Normal chests
spill 2-4 weighted original items and 10-16 Floor 1 baseline
gold; Treasure tier spills 4-6 items from the original rare pool and 24-39
gold. Drops magnetize and auto-collect after their original delay. The Inspector
authors Normal or Treasure tier; new chests default to Normal. Inventory and
opened/collected state persist across level transitions/revisits within one
Play run and are discarded on Stop/new Play; saved designs are never mutated.
Barrels, crates and pots remain decorative: the original defines no attack,
durability or drop behavior for them. Studio Play supports explicitly authored
stairs exits with an all-active-slimes lock and automatic entry (no Interact).
An unlock while standing on a rune activates it; arrival runes and failed
attempts require leaving and re-entering before another transition.
The standalone encounter has no level
catalog and reports that routing requires Studio. See
`studio/docs/DEVELOPMENT.md`, "Astraeum authored level progression", for the
read-only original-game finding, Inspector workflow, state policy and focused
checks. Input and health
state are keyed by account ID as groundwork only; multiplayer is not supported
or verified.

This project uses only installed public kit exports and browser Canvas APIs;
it does not import private engine internals. The tilemap adapter is a reusable
candidate, separate from Tower-specific gameplay. The public API has no
first-class Wang/tilemap renderer, so the skin renders Anh's terrain atlas on
Canvas. The map API only accepts
collision rectangles whose dimensions are multiples of 32 px, so the original
smaller barrel/crate/pot collision shapes are not modeled in this slice.

With the game running and a local Chrome DevTools endpoint at port 9223, run
`npm run astraeum:smoke` to verify map size, player-following camera scrolling
in a smaller viewport, map centering without stretch, device-pixel scaling,
lighting alignment, traversal through the doorway and narrow corridors, turns,
directional-key priority, wall sliding and blocking, sprite animation and crisp
rendering, original and fully lit settings, control validation, and resizing
in a browser. The Studio Play encounter and control modes are covered by its
disposable browser smoke. That smoke sends real CDP keyboard/mouse events and
standard-gamepad adapter input, verifies attack and dodge actions separately
from visible thrust/sweep Canvas captures in all four facings, and checks
movement-only input, short taps, dodge re-arming, stamina/cooldown rejection,
neutral-stick behavior, disconnect, blur, UI focus, Play focus, and shortcut
isolation. Set `STUDIO_ATTACK_EVIDENCE_DIR` to save the four-direction weapon
captures. `npm run astraeum:interactions:test` exercises interactions with a
disposable public runtime, including both connected seam axes and revisits; it
does not establish native-browser acceptance. Physical-controller hardware
remains unverified.
