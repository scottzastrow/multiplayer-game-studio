# Studio onboarding and development guide

This is the shared development guide for contributors. Keep setup and policy
details in this file rather than copying them into separate agent guides.

## 1. Fresh-machine setup

Use the inner Git repository as the working directory:

```powershell
git clone https://github.com/scottzastrow/multiplayer-game-studio.git
Set-Location .\multiplayer-game-studio
node --version  # Node.js 24.x
npm --version   # npm 11.x
```

The root `package.json` enforces Node `>=24 <25` and npm `>=11 <12`.
`engine\developer-kit.lock.json` pins kit 0.3.0, Engine revision
`dca3ffc4561c14e0e83968afceabf0e85cddc565`, and the archive SHA-256
`afd63a865a23b60183d7be89c15811f68438a0186638caa509fb541bc3492517`.
The kit archive and installed kit are under ignored `engine\archives\` and
`engine\kits\`; neither is present in a fresh clone. No download location is
recorded here, so obtain the pinned ZIP and its adjacent `.zip.sha256` from an
authorized project source rather than guessing a URL or substituting a kit.
Before setup, compare the ZIP hash to `archiveSha256` in the tracked lock file:

```powershell
Get-FileHash .\path\to\multiplayer-game-developer-kit-0.3.0-dca3ffc4561c.zip -Algorithm SHA256
```

Place the verified archive and matching checksum sidecar in
`engine\archives\` (or pass the archive's actual path), then run:

```powershell
npm run setup -- --archive .\engine\archives\multiplayer-game-developer-kit-0.3.0-dca3ffc4561c.zip
node .\engine\kits\0.3.0-dca3ffc4561c\tools\checksums.mjs
```

`tools\setup.mjs` checks the archive against the adjacent sidecar and validates
the kit's distributed files, installs package tarballs into the ignored kit
directories, and links `games\sample\node_modules` to the versioned dependency
directory. It refuses to switch away from the locked kit without the explicit
`--upgrade` option. It also runs `npm ci` for Vite and its pinned tooling;
initial installation therefore needs npm registry access. Do not run `npm ci`
directly in `games\sample\`. This repo has no root dependency install step.

**Fresh-clone limitation:** the archive and sidecar are ignored local files.
The tracked lock file identifies and pins them but cannot recreate their bytes;
without an authorized copy, setup cannot proceed. The reviewed 0.3.0 upgrade
passed the existing setup flow with `--upgrade`, all 46 distributed checksums
and dependency installation in a new versioned directory. The old 0.2.0
distribution remains intact and its 44 checksums still pass. This was an
upgrade, not a fresh-clone trial. An earlier 0.2.0 reinstall encountered Windows
`EPERM` unlinking Rollup while a server was running; do not force-stop unknown
processes or overwrite the old dependency directory to retry installation.

Start Studio from the repository root:

```powershell
npm run studio:dev
```

Open `http://127.0.0.1:4173`. `studio\start.mjs` starts the Vite UI and the
loopback SQLite/API service together; the defaults are web port 4173 and API
port 4179. `STUDIO_WEB_PORT`, `STUDIO_API_PORT`, `STUDIO_DATABASE_PATH`, and
`STUDIO_GAMES_PATH` are supported for isolated runs; disposable storage paths
must remain inside `studio\data\`.

Vite reloads editor HTML, CSS, and browser modules during development. The API
is a separate Node process: restart `npm run studio:dev` after changing
`studio\server.mjs`, server-side helpers, API/database behavior, or relevant
environment variables. Restart after kit/dependency changes too. Do not restart
or stop processes you do not own. If ports are busy, identify the owning process
before changing ports or stopping it. For blank UI/API responses, check both
process logs, the configured ports and the browser console; for setup failures,
check Node/npm versions, the archive plus sidecar, the kit checksum output,
registry access, and whether an owned Vite process is holding native files.

## 2. Building in Web Studio

- **New Game** creates an independent Generic Grid v1 project with author and
  credits, two safe starts, and a fixed 2048 × 2048 world. Existing saved maps
  retain their saved dimensions. **Open Game** lists one entry per saved
  project ID and opens its designated starting level; use **Levels** for other
  levels. The initial Astraeum Floor 1 is a separate existing project; New
  Game does not copy it.
- **Current level** switches levels in the selected project. The compact
  **Level** menu contains **Add Level**, Duplicate, Rename,
  Set as start and Delete. **Add Level** creates a separate level with exactly
  one blank 2048 × 2048 section: no cobblestone, objects or player starts are
  copied. The project's starting level and existing levels stay unchanged.
  Place required starts explicitly before Play; empty drafts can be saved.
  Dirty edits prompt for save, discard or cancel. Recovery stays under
  **Deleted levels (recover)**. Play tests the selected level, not necessarily
  the game's starting level. To expand the current level instead, use
  **Selected section** (or click its canvas area), click **Add Section**
  directly below the section dropdown, then
  click **North**, **East**, **South** or **West** in the cross-shaped placement
  preview and **Confirm Add Section**, or **Cancel** without creating anything.
  Selecting a side only previews its grid coordinates; changing the selected
  section clears that choice. Occupied sides are disabled. New sections have no terrain, walls,
  props, items or starts; previously saved section contents are not cleared.
  Confirm adds only an empty editor draft; it marks the level unsaved and is
  undoable/redone as one action. It does not write SQLite or advance the saved
  level revision. Adding one does not change pan or zoom. Save an initial
  unsaved template before adding sections. Sections are one
  continuous editable level, not independent stages.
- **Remove Section** reviews the selected section's name, grid position and
  object count before Confirm or Cancel. It warns about player starts and
  custom boundaries, never moves starts or reshapes a boundary, and requires
  editing or resetting a custom boundary first if it includes the section
  being removed. At least one section must remain. Removal is one Undo/Redo
  action, including after Save in the same editor session; other sections and
  their unsaved edits retain their positions and contents. Additions, removals,
  archived membership and document edits remain draft-only until Save commits
  the entire level atomically. Reopening retains archived documents but does
  not restore editor history.
  Up to 16 removed sections may be retained per level; removal of a saved
  section is disabled at that limit rather than purging content. Adding a section never evicts
  archived content; if restoring a saved addition would exceed the archive
  limit, Undo is refused with the history entry retained. Add and Remove drafts
  can be combined before Save. If a Save response is lost, retry Save to
  reconcile the same operation; edits made meanwhile remain unsaved. A newly
  added section included in that uncertain save cannot be removed or undone
  until the retry resolves it. The default boundary
  follows the remaining section union. If the original section is removed,
  the remaining section(s) use the existing connected movement-only preview;
  the original document remains the level's boundary owner in the archive.
- Place items from the model-specific palette. **Import Assets** accepts PNG
  images and PixelLab ZIP exports into that project's asset catalog. Imported
  art preserves source bytes and credits and is visual-only: it does not gain
  animation, collision, AI or behavior automatically.
- The **Layers** panel controls design-layer visibility and ordering. The
  checked **Snap** control snaps supported transforms to the 32-pixel grid;
  terrain, spawns and the stairs portal always snap. Inspect the selected
  object's Inspector for its actual transform, layer and collision settings.
  Click selects one object; Shift-click toggles membership; dragging empty
  canvas makes a marquee within the active section. Ctrl+A selects only
  visible, unlocked objects when the canvas has focus. Object identities are
  section-scoped; placement, selection, movement, duplication and deletion use
  the existing tools and Inspector. Objects cannot move across a section seam;
  that limitation is reported. The Inspector reports common and mixed values.
- **Clear Level Contents** previews affected and locked/skipped counts for
  terrain, walls, props, items, collision boxes and spawns before confirmation.
  Locked layers are preserved. Clearing is one undoable edit; a draft without
  required player starts remains saveable, but Play shows an actionable error
  and never creates replacement spawns.
- **Player Settings** currently selects Keyboard Only, Keyboard + Mouse, or
  Game Controller for Astraeum and exposes the level's saved gameplay camera
  zoom. Input mode is local preview behavior; camera zoom is saved with the
  level. Editor pan/zoom is independent.
- **Save** or Ctrl+S writes the complete current level draft, including section
  membership and documents, atomically to SQLite. **Play** previews the
  current selected level, including unsaved edits; **Stop** returns to the
  editor without saving simulated movement. Multi-section levels use kit
  0.3.0's public `createLocalGame({ world })` with every selected-level section,
  signed origins and its authored player start. Connected Play is keyboard
  movement, camera and collision only: no combat, dodge, lighting or generated
  decor. Both models render authored artwork across seams; Astraeum samples
  neighboring Wang occupancy. Root-owned boundaries and holes remain enforced.
  Missing/ambiguous starts or public capacity errors fail explicitly, never
  play only one section. Stop restores pan, zoom, active section and selection.
  Existing single-section game modules/skins and control modes remain on their
  original path. See Section 5 for focused evidence and the blocked browser
  acceptance; no new editor features accompany this milestone.
- The labelled **Tool** dropdown contains **Select**, **Paint** and
  **Rectangle Fill**, and **Boundary**. Boundary supports grid selection or a
  closed polygon lasso, previews playable cells, and uses Apply/Reset/
  Escape-cancel through the existing history. Decorative fill borders remain
  independent. Paint continuously strokes compatible single-cell terrain; for
  other assets it click-places, and palette drag placement remains available.
  The Paint panel shows the explicitly selected asset's thumbnail and name,
  or asks you to choose one. Its **Brush size** selects **1 x 1**, **2 x 2**,
  **4 x 4** or **8 x 8** terrain cells (32, 64, 128 or 256 world pixels per
  side), without scaling artwork. A grid-snapped cursor footprint shows the
  exact stamp; even-sized brushes extend one extra cell east/south of the
  pointer's cell-centered footprint. Green indicates an available footprint;
  red indicates a locked/hidden Terrain layer or missing/out-of-bounds section.
  Fast strokes sweep every intervening cell, including across existing section
  seams. A stroke captures its size on pointer-down and creates one Undo entry
  for all changed sections; retracing/identical tiles do not stack. Rejected
  strokes change nothing, rather than clipping the brush at a seam or bound.
  Continuous Paint supports **Cobblestone floor** in Astraeum and **Plain
  tile** in Generic Grid: non-unique 32 x 32 terrain with compatible pivot/grid
  alignment. Walls/blocks, props (including imported PNG art), items, spawns and
  collision boxes are objects, not replaceable terrain cells; unique assets or
  terrain with incompatible dimensions/pivots also cannot use the continuous
  brush. Their selected asset remains visible with an explanation, the brush
  size is disabled, and existing single-click/palette-drag placement remains.
  Select returns to selection/movement (also Escape). Rectangle Fill keeps its
  mode when choosing a palette asset; palette input selects the fill asset
  without drag-placing a single object. The Fill panel says **Choose a fill
  asset from the palette** until an asset is explicitly selected, then shows
  its thumbnail and name. Switching into Fill preserves the palette selection;
  it never chooses a default asset. Draw the rectangle on the canvas.
  Cancel fill is available before or after a preview and returns to Select
  without changing objects. Only active-tool instructions/settings
  are shown, with Apply/Cancel inside the fill settings rather than the toolbar.
  Save, Undo/Redo and Play remain in the toolbar.
  These tools use the main canvas, palette, hierarchy, Inspector, layers and
  history. Paint needs a compatible single-cell terrain asset for strokes;
  Rectangle Fill also repeats static props (including barrels and imported
  visual props) and walls using their configured world footprint, not image
  resolution or terrain-cell dimensions. Fill settings show that footprint,
  horizontal/vertical gaps in whole world pixels (0-2048), and Skip/Allow
  **same-layer** overlaps. Skip preserves existing objects; Allow keeps both.
  Optional collision can be enabled for new copies; required collision remains
  required. Existing properties/collision are never overwritten by object fill.
  Partial edge footprints are left empty; seam-straddling slots are skipped
  and counted, never split, resized or moved to another owner. Assets with forced
  grid alignment retain that requirement. Spawns, items, unique/required objects
  and the stairs portal do not repeat.
  Intentional **Generate border** is off by default. Its separate asset selector
  accepts 32 x 32 terrain or wall assets and uses a one-cell ring **inside** the
  rectangle, with no internal section-seam border. Corners occur once; the fill
  packs inside that ring using its own footprint and gaps. Enabling a border
  snaps the rectangle to the terrain grid. This does not disable or rewrite
  Astraeum's existing Wang artwork edges (see the investigation below).
  Explicitly unlock and show each targeted layer; the hint explains blocked
  prerequisites. Preview counts placement targets, borders, skipped/allowed
  overlaps and seam slots before Apply. Terrain still replaces cells and
  identical cells remain unchanged. Apply revalidates the complete plan,
  including locks, capacity and stale-preview protection. Pending fills block
  other document edits and Play until Apply/Cancel (or Escape).
  Existing smaller maps can paint/fill inside their saved bounds without
  automatic expansion. Invalid, locked, hidden or missing
  targets reject the whole operation; one Undo/Redo covers all changed
  sections. Brush/fill working sets remain bounded to two sections. Saves
  validate all section revisions and commit the level atomically. Each level
  is limited to 16 sections. Existing World-workspace SQLite records remain
  untouched and are not automatically attached to levels. The standalone
  World workspace is no longer available in the editor, so those records
  cannot currently be opened through the UI.

**Implemented:** project-scoped save/open; level lifecycle and recovery;
model-specific placement, layers, snapping, undo/redo and Play/Stop; PNG and
PixelLab ZIP import; Astraeum's one-player adapted combat encounter; and
Generic Grid v1's simple public-runtime movement preview. Scoped
multi-selection, bulk editing and category-based clearing are implemented;
their segmented direct-CDP verification is recorded in Section 5. The
editor supports the controls described above, not a general-purpose authoring
or publishing pipeline.

**Provisional or planned:** Astraeum's tilemap adapter and lighting are local
game code, not installed Engine packs. Multiplayer, online upload, game export,
PixelLab API integration, physical-controller verification, automatic level
transitions, generation, other area-fill tools, audio and shared libraries are not
established by current Studio Play. A successful local preview does not prove
multiplayer, authoritative-server, or online-upload compatibility.

## 3. Extending through source

Keep changes in the owner that executes them:

| Change | Location |
| --- | --- |
| One game's gameplay, settings, assets and adapters | `games\<game>\` |
| Reusable Studio-side prototypes/extensions | `studio\extensions\` |
| Editor UI, API/service, storage and Studio tests | `studio\` |
| Installed public Engine packages | Read only; never edit `engine\kits\` |

`studio\extensions\` contains reusable Studio integration, including the
connected movement adapter. Do not put editor code into a game
or call a game-local helper an Engine API. Engine source is not checked out
here: inspect the installed package's `API.md` and `dist\*.d.ts` declarations
under the pinned `engine\kits\` tree.

Ownership is split deliberately:

- SQLite at `studio\data\studio.sqlite` owns saved map documents, project/level
  records, level-section membership and transactional saves, starting-level
  references, import catalogs, and migration/backups. Existing World-workspace
  tables remain separately owned and are not migrated or deleted.
  The checked-in `games\astraeum-tower\src\floor1.json` is a template, not the
  live saved map. Generated `project.json` files are identity/credits/model
  metadata and a creation-time map-ID receipt, not the level database.
- Filesystem paths under `games\<project-id>\` own generated project metadata
  and imported asset bytes. `games\astraeum-tower\` and `games\generic-grid-v1\`
  own their source modules and checked-in assets. Keep backups before risky
  storage changes; SQLite backups and migration records remain database-owned.
- Git tracks source and intentionally selected assets/docs. The local database,
  `node_modules`, generated build output, exports, `engine\archives\`, and
  `engine\kits\` are ignored. Generated game directories/assets may contain
  user data: inspect `git status --short --ignored` and stage only explicitly
  authorized files; never assume an untracked project is disposable.

## 4. Claude reuse-first workflow

Before writing custom code, inspect the installed public declarations, the
sample's supported settings, the target game's modules, and existing helpers.
Search actual imports/exports and call sites; do not infer an API from a package
name, a protocol schema, a README example from another kit version, or local
game code.

For this pin, start with:

- `engine\kits\0.3.0-dca3ffc4561c\API.md` and the installed
  `@multiplayer-game\theme-sdk\dist\index.d.ts` and
  `@multiplayer-game\local-preview\dist\*.d.ts`.
- `engine\kits\0.3.0-dca3ffc4561c\sample\src\settings.js`,
  `sample\src\game.js`, `sample\src\skin.js`, and `sample\theme.json`.
  The packaged `sample\src\connected-sections.js` and
  `sample\connected-sections.mjs` demonstrate the public world contract.
- The target game's `src\game.js`, `src\project.js`, `src\runtime.js`,
  `src\skin.js`, catalogs, and focused helper modules. For Studio capabilities,
  inspect `studio\src\main.js`, `studio\server.mjs`, and the relevant
  `studio\scripts\` test.

Useful verified public boundaries include:

- `@multiplayer-game\local-preview` exports `createLocalGame` and
  `mountLocalPreview`.
- `@multiplayer-game\theme-sdk` exports `MovementController`,
  `readStandardGamepad`, `validateMapDefinition`, `MapDefinitionSchema`,
  `drawRadar`, `RadarViewSchema`, and `Countdown`. `MovementController` takes
  `{ facingMovementBlend }`; the sample validates this as 0–1 and defaults it
  to 0.40. `readStandardGamepad(gamepads)` consumes browser Gamepad objects;
  focus, polling and clearing input on blur/disconnect remain the skin's job.
- The installed map contract exports `MAP_CELL_SIZE` (32),
  `MAX_MAP_DIMENSION` (2048), `MAX_MAP_OBJECTS`/`MAX_MAP_COLLISIONS` (4096),
  `MAX_MAP_SPAWNS` (256), and `validateMapDefinition`. Use the validator and
  installed declarations as authority for the complete shape and limits.
- `validateConnectedMapDefinition`, `resolveConnectedMapSpawns` and
  `qualifyConnectedMapReference` compose 1-16 sections, not an oversized map.
  Origins are safe-integer multiples of 2048, including negative values.
  Per-section limits remain unchanged; world totals are 4096 objects, 4096
  collisions and 256 spawns, with a bounding navigation grid of at most
  1,000,000 cells. Zero-start neighbors are valid; the whole world requires
  two distinct walkable player-start positions, even for one actor.
  `ModuleContext.connectedMapSpawns` supplies stable world positions and
  qualified IDs. `maps.prepare/commit` remains replacement-only.
- Sample settings are not universal Engine settings. `moveDistance` is
  greater than zero and at most 32; `controlMode` is one of
  `keyboard-only`, `keyboard-mouse`, or `game-controller`. In Astraeum,
  `towerSettings` and `towerEncounterTuning` are exports from
  `games\astraeum-tower\src\game.js`, not public package settings.

Use this order: (1) configure an existing supported setting; (2) compose
public APIs and existing helpers; (3) add the smallest scoped game module or
Studio extension. State the capability already available and its actual
options before proposing custom code. If public contracts cannot express the
needed behavior, record the missing contract in
`studio\docs\ENHANCEMENTS.md` and propose the Engine change; do not mutate the
installed package, import private internals, or bypass validation.

### Worked example: Astraeum map and collision adaptation

`games\astraeum-tower\src\tilemap-adapter.js` is a local adapter, not an
already-public Engine tilemap package. Its `createTilemapDefinition(grid,
{ id, name, cellSize, wallMarker, playerSpawnMarker, openSpawnMarker })`
converts the string grid to a public map definition and calls
`validateMapDefinition`. Its local `isActorBlocked(..., { halfWidth,
halfHeight, wallFacePx, cellSize, wallMarker })` and
`moveActor(..., { radius, halfWidth, halfHeight, wallFacePx, blockers, cellSize,
wallMarker })` helpers add game-specific feet, wall-face and collision
handling; these are not SDK options. The SDK provides map validation and
runtime geometry, but no first-class Wang/tilemap renderer. Astraeum's art
drawing is in `src\design-render.js`; its exact encounter, movement and input
behavior is in `src\game.js` and `src\skin.js`. The local
`src\lighting\world-lighting.js` also owns its lighting settings and Canvas
renderer; it is not a public Engine lighting pack.

Reuse `MAP_CELL_SIZE` and `validateMapDefinition` rather than cloning their
rules. Keep atlas rendering and the original wall-face behavior inside the
game until a separately reviewed, supported Engine surface exists. If other
games need the capability, track this adapter as an Engine candidate, define
the needed public contract, then migrate only after a versioned kit exposes it
and Astraeum's artwork, collision, and movement checks still pass.

## 5. Verification

For a source change, first use Studio **Play/Stop** for the affected game and
run the narrowest relevant check from the root:

```powershell
npm run studio:boundaries:test
npm run studio:apply:test
npm run studio:connected-play:test
npm run studio:runtime-sections:test
npm run studio:persistence:test
npm run studio:sections:test
npm run studio:sections:smoke
npm run studio:levels:smoke
npm run studio:wall-clear:smoke
node studio\scripts\levels-smoke.mjs --draft-recovery-only
npm run studio:assets:test
npm run studio:smoke
npm run astraeum:combat:test
npm run astraeum:smoke
```

These are separate choices, not a checklist to run after every edit. Read
`package.json` and the selected script before choosing: browser tests use the
actual UI through direct Chrome DevTools Protocol (CDP), and some asset flows
require `STUDIO_GOPHER_ZIP`. Prefer the scripts' disposable database/game
directories and their dedicated Chrome profile; do not aim tests at
`studio\data\studio.sqlite` or a user's game. `studio\scripts\levels-smoke.mjs`
also exposes `npm run studio:map-settings:smoke` and
`npm run studio:levels:smoke -- --dropdown-only` for focused UI flows.
`npm run studio:wall-clear:smoke` starts at the disposable Astraeum floor and
checks wall artwork and Clear Level Contents without replaying draft recovery.
`studio:sections:test` verifies additive level-section storage, atomic rollback,
restart/reopen, project isolation, and preservation of separate World records.
`studio:boundaries:test` covers exposed edges, shared seams, missing-section
holes, default expansion, polygon validation, spawn warnings, single-section
public collision validation/movement, editor cancellation and history, and
disposable persistence/reopen.
`studio:sections:smoke` runs one focused direct-CDP editor flow using only
disposable data and retains its database, process logs, screenshots and
diagnostics under `studio\data\sections-smoke-*`. If Studio startup fails,
retain that evidence and do not repeatedly relaunch the same flow.
The levels smoke preserves its disposable directory, `diagnostics.json`
(page/console errors, failed requests/HTTP errors, and reload readiness), and
per-process logs under `studio\data\levels-smoke-*`. Reload readiness waits
for a new page, the existing development helper, a non-null document, and the
expected project/map and level selection before checking saved content. It
uses the existing 500 attempts at 25 ms and 15-second CDP command limits.

Dated entries below retain the contract and behavior at the time of each run.
Older 0.2.0 multi-section-disabled results are superseded by **Developer Kit
0.3.0 connected Play integration** below; they are not current limitations.
The standalone World workspace UI has also been superseded; its historical
`studio:world:test` browser flow targets controls no longer present in Studio
and is not a current unified-editor acceptance test.

### Open Game project grouping (2026-11-14)

`npm run studio:levels:smoke -- --dropdown-only` passed through direct CDP with
fresh disposable storage in `studio\data\levels-smoke-WF4BCQ\`. It verified one
entry for a two-level project, a separate entry for another project, the
designated starting level opening without changing its metadata, and switching
to the other level through **Levels**. The project entry showed its name and
active-level count without listing level names. Existing level-switch
cancellation and recovery checks also passed. There were no page or console
errors; the only network error was the expected favicon 404. The regular server
and user storage were preserved; no kit rebuild, commit, push or deployment
occurred. T042 remains open.

The 2026-11-14 map-settings evidence is retained, not overwritten:
`studio\data\levels-smoke-i1hNhY\` stopped at a reload guard that mistook the
transient "Not loaded" save label for startup failure. The corrected guard
checks Studio's actual error status. The subsequent
`studio\data\levels-smoke-Gxjl7K\` run passed both dimension-entry orders,
cancel, expansion/undo/redo, object preservation, extended placement,
save/reopen, unchanged original collision geometry and Play movement/collision,
then failed `assert.ok(Math.abs(blocked.playerScreenX - blocked.width / 2)
<= 1, "camera follows at the first viewport size")` at line 443 of that run's
script. The assertion's actual boolean was `false`, expected `true`.

Only that collision/first-camera segment was replayed through direct CDP,
reading the retained SQLite document read-only and seeding fresh disposable
storage. `studio\data\levels-smoke-6jxIq2\camera-evidence.json` records one
render sample at simulation tick 59: player `(1590, 1528)`, camera offset
`(848, 1176.6666666666667)`, zoom `1.5`, viewport CSS size `1800 x 1054`,
and world `2048 x 2048`. Player screen X was `1113`, expected centered X
`900`; absolute error `213`, expected `<= 1`. These numeric values are from
the replay; the original failure did not retain camera/viewport measurements.

For each axis, visible world size is `CSS size / zoom`. If visible size is at
least world size, offset is `(world size - visible size) / 2` (small-world
centering); otherwise offset is
`max(0, min(world size - visible size, player position - visible size / 2))`.
Here the visible world is `1200 x 702.6666666666666`. Unclamped X offset
would be `990`, but its east limit is `848`; Y offset is
`1528 - 1054 / 1.5 / 2 = 1176.6666666666667`. Rendering matches the rules.
The original spawn at X `1520` is already east of the last centered-follow
position `1448`. Holding Right advances it to `1590`, where its 18-pixel-wide
body ends at `1599`, before the wall at X `1600` (Y `1504`, size `32 x 32`).
The wall correctly blocks further eastward motion; that motion cannot reach
the centered-follow region. This is a fixture defect, not a camera defect.

The fixture now uses authored spawn tile X `1280` instead of `1504`, moving
the spawn and derived wall west by `224` within the expanded area. Y,
collision spacing, zoom semantics, assertions and timeout limits are unchanged.
`studio\data\levels-smoke-6ekIAk\` passed the targeted segment: at tick 55,
player `(1366, 1528)`, camera `(766, 1176.6666666666667)`, viewport
`1800 x 1054`, zoom `1.5`, world `2048 x 2048`, screen X `900`, error `0`.
The wall at X `1376` stops the player within the unchanged collision tolerance.
The smoke now retains same-sample camera evidence in its diagnostics.

After that pass, the remaining map-settings segment ran once using fresh
disposable data (`studio\data\levels-smoke-HrKv8S\`): resized viewport
follow/scale/light alignment, Stop restoring editor pan/zoom, saving/reopening
zoom `0.5` and its Play scale, and new Tower level, Generic game and Generic
level `2048 x 2048` defaults all passed. Both successful segments had no
page/console errors; network failures were favicon 404s only. This was segmented
coverage, not a repeat of the full map-settings suite. Original evidence, user
storage, existing edits and the regular server were preserved. No dependencies
were installed, debugger used, kit rebuilt, commit/push or deployment performed.
T042 remains open.

### Multi-selection and bulk-edit milestone verification (2026-11-14)

The initial persistence failure at line 295 was corrected: a newly added
blank Generic level is expected to be `2048 x 2048`, while checks that existing
saved levels remain unchanged and the legacy migration/backup checks remain
intact. New Game now has no dimension inputs, reports the fixed
`2048 x 2048` world size, and the client/service enforce those dimensions.
Custom-size document validation remains available for existing saved maps;
the browser's small-world camera case now uses an explicitly saved `64 x 64`
compatibility fixture. The older `#new-width=2080` smoke assertion was removed
with the obsolete editable-field behavior.

`npm run studio:persistence:test` passed, including rejection of custom-size
New Game and blank-level API requests. `npm run studio:map-settings:smoke`
passed through disposable direct CDP: the saved `1152 x 704` map stayed
unchanged until explicit expansion, its undo/save/reopen and collision/Play
checks passed, and both New Game and blank-level defaults were `2048 x 2048`.
Evidence is retained in `studio\data\levels-smoke-pjuGLe\`.

The pending direct-CDP `npm run studio:smoke` ran once and stopped at
`studio\scripts\browser-smoke.mjs:1422` on marquee selection. Actual selected
IDs were `[]`; expected IDs were `["player-start", "player-start-2"]`
(`AssertionError: the marquee excludes hidden and locked objects.`). This is
the new stopping failure; no retry was run. Assertions later in the script for
group geometry, undo/redo, save/reopen, spawn-free Play blocking and runtime
world dimensions remain unverified. Its PID-scoped database, game directory,
Chrome profile and processes were cleaned up. The regular server remained
listening on port 4173; the smoke's 4174, 4181 and 9224 ports were free after
cleanup. No user database or game was used; no commit, push, deployment or kit
rebuild was performed. T042 remains open.

The marquee failure was isolated with fresh disposable data and direct CDP in
`studio\data\selection-segment-DXxmzy\diagnostics.json`. Select was active,
editor zoom was `1`, pan was `(0, 0)`, and all pointer modifiers were false.
The canvas CSS bounds were `(220, 52)` to `(1362, 860)` (`1142 x 808`).
The pointer dragged from client `(224, 56)` to `(620, 452)`. Applying
`world = (client - canvas origin) / zoom + editor pan` gives the original
world rectangle `(4, 4)` to `(400, 400)`. The starts occupied
`(1024, 1024, 32, 32)` and `(992, 1024, 32, 32)`: neither was enclosed
or intersected. Terrain and walls were locked, props were hidden, and spawns
were visible/unlocked. Ctrl+A selected both starts before the drag, while
the drag correctly selected nothing. This is a stale small-world fixture
after the 2048 default change, not a selection defect.

The browser fixture now derives its marquee from all authored object bounds,
fits that rectangle into the actual canvas, and restores the previous editor
view afterward. Hidden/locked objects remain inside the tested rectangle but
excluded from selection. The pending group-bounds rejection fixture was also
stale: its `+1000` offset would put the markers at X `1160` and `1256`, both
valid inside 2048. It now uses the document width as the rejected offset.
No editor/runtime behavior or timeout limits changed.

`studio\data\selection-segment-gtqAx5\diagnostics.json` records the corrected
targeted pass followed by one execution of the pending group-edit segment.
At editor zoom `0.8`, pan `(56, 56)`, the pointer-derived world rectangle was
approximately `(60, 60)` to `(1060, 1060)`, enclosing both complete starts;
exactly `player-start` and `player-start-2` were selected. Shift/Ctrl+A and
hierarchy synchronization, mixed-value Inspector display, shared snapped
`(32, 0)` movement, atomic bounds rejection, `(5, 0)` nudging, unique-ID
duplication/deletion and their undo/redo checks passed. Saving and reopening
after service restart preserved all five objects exactly. Category clear
reported four removed and one locked/skipped, with one-action undo/redo.
The spawn-free draft saved/reopened unchanged and Play remained blocked with
actionable missing-start errors. Restoring authored starts allowed Play:
the runtime received `2048 x 2048` at scale `1`, movement advanced from
`(336, 240)` to `(360, 240)`, editor shortcuts did not mutate the map, and
Stop restored the document and editor view. There were no uncaught browser
exceptions or console errors; HTTP errors were favicon 404s only.

An initial replay-harness extraction mistake (CRLF boundary mismatch) ran the
broader original smoke up to the same marquee failure before isolation was
corrected. Its process logs and disposable database are retained separately
in `studio\data\selection-segment-U6IQZe\`; it is not counted as scoped
verification. The later reproduction and successful segmented check used
only the requested selection/group workflow, not another full smoke run.
All owned processes and temporary Chrome profiles were cleaned up; the
disposable databases, generated games and diagnostic logs were retained.
The regular web/API server PIDs were unchanged and port 4173 still returned
HTTP 200. User data and unrelated edits were preserved; no commit, push,
deployment or kit rebuild was performed. T042 remains open.

### Manual-edit investigation stopping failure (2026-11-14)

Direct CDP with fresh disposable storage reproduced a failure before the
requested unsaved-switch sequence could finish. Evidence is retained in
`studio\data\levels-smoke-Trkxyr\`: `manual-edit-evidence.json` contains complete
before/selected/after documents and control snapshots, three PNGs capture the
actual UI, and `diagnostics.json` plus process logs preserve the exception.
The existing levels harness was reused from a session-only driver; no browser
helper was used to mutate the design. A duplicate switch target was created
through the UI, the original reopened, `aries-start` selected in the hierarchy,
and **Delete object** clicked.

The document changed from 1197 objects (eight spawns) to 1196 (seven spawns),
with the authored player start removed. The canvas became blank and the stale
selected ID remained `aries-start`. One uncaught
`TypeError: Cannot read properties of undefined (reading 'transform')` came
from `games\astraeum-tower\src\project.js:663`, through `sceneCanvas`,
`refreshChrome`, `commitDocument` and `deleteSelected`. Draft validation
allows a missing start, but the editor's `sceneCanvas` unconditionally calls
`createFloorMap`, which dereferences that missing start. The deletion and undo
entry had already been applied before rendering threw; selection cleanup and
the deletion status message did not run.

Static tracing also identifies why switching can lock its own recovery
controls: `switchToSelected` sets `state.switching`, disables every Open dialog
button/input, then calls the same throwing `refreshChrome` **before** its
`try/finally`. Consequently that exception bypasses the cleanup that would
restore the flag and buttons, including Cancel switch. `save` similarly sets
`state.saving` and refreshes before entering its own `try/finally`. These
downstream paths were not exercised after the stopping failure and must not
be described as runtime-verified.

The required fix is to render incomplete Astraeum drafts without constructing
a playable map or inventing starts, retain actionable missing-start checks at
Play, and include all busy-state UI work inside failure-safe cleanup. Review
the existing category Clear Level Contents action rather than adding another:
it already has category/count/lock/confirmation/undo UI, but uses the same
rendering path when starts are removed. Astraeum spawn-free save/reopen, error
recovery and dialog cancellation still require direct-CDP verification.
The wall-movement/artwork comparison was not started. No implementation fix
or subsequent UI scenario was attempted after the first new failure.
Regular web/API processes and user storage were preserved; no commit, push,
deployment or kit rebuild was performed. T042 remains open.

### Missing-start rendering and busy-state recovery (2026-11-14)

The editor no longer constructs a playable map to draw a draft or expand its
bounds. Astraeum's renderer derives the optional entrance decoration from the
authored start; without that start it omits only the entrance, not the rest of
the scene. No deleted objects are recreated. Play retains the actionable
missing/blocked-start checks, and direct playable-map construction now reports
those errors rather than dereferencing a missing start.

Save, Open/switch, level actions and New Game now enter busy state and refresh
inside their protected paths. Cleanup resets flags and dialog controls before
refreshing; a further rendering failure is reported explicitly. Applying a
loaded design is transactional: a failure restores the prior document,
identity, catalog, selection, view and undo/redo history. Recovery invalidates
the scene and hierarchy caches before rebuilding the old view.

The focused `--draft-recovery-only` direct-CDP run retained evidence in
`studio\data\levels-smoke-IEiYdK\`. Using only disposable SQLite/game storage
and real UI input, it passed Aries-start deletion with a populated, selectable
canvas; an actionable Play warning without replacement starts; exact one-step
undo/redo; spawn-free save/reopen; and cancellation preserving an unsaved
Inspector edit. Injected save HTTP, validation and persistent render failures
restored controls and retained edits. Save-before-switch, target HTTP,
target validation, initial-render and target-render failures also recovered;
the original identity/document and subsequent undo/redo were preserved.
The post-run hierarchy-cache invalidation is a defensive rollback correction;
its hierarchy rebuild was not separately exercised after the stopping failure.

The continuation fixed the comparison imports to use Vite's `/@fs/` repository
file URLs and added `npm run studio:wall-clear:smoke`, avoiding replay of the
already-passed recovery scenarios. In
`studio\data\levels-smoke-pUlCXo\`, full-frame comparisons against the original
Wang renderer passed with zero differing channels for an imported wall, that
wall moved off-grid, and newly placed snapped and off-grid walls. The cobblestone
matches the Wang wall-tile artwork with floor occupancy masked at wall cells;
it is not exposed floor and no rendering defect was confirmed.

The direct-CDP run stopped at the first new failure after opening Clear Level
Contents and selecting its categories: the browser-evaluated category-count
assertion had a missing closing parenthesis and raised `SyntaxError`. The
assertion expression is corrected in the harness, but per the stop-on-failure
instruction the run was not repeated. Category counts, cancel/confirm behavior,
locked-object protection, one-step Undo, and saving/reopening the spawn-free
draft therefore remain unverified. The run's diagnostics, screenshots,
disposable database and process logs are retained in `levels-smoke-pUlCXo`.
There were no uncaught page or console errors; one network failure was recorded.
Owned test processes were stopped. The regular server and user data were
preserved; no commit, push, deployment or kit rebuild was performed. T042
remains open.

The pending clear segment then ran in `studio\data\levels-smoke-pyNDxz\`.
It reported 22 affected and 1175 locked/skipped objects, preserved content on
cancel, removed only the unlocked objects on confirm, and restored the original
document with one Undo. The disposable driver then timed out waiting for
`? Saved`: its generated checkmark literal had been corrupted by encoding.
The status said the map had saved. The spawn-free saved-state wait in the
browser harness now uses the existing `saved` CSS class instead of the glyph.

The continuation read the retained SQLite database and compared its saved
document with the previously recorded confirmed-clear document exactly: both
contained 1175 objects and no spawns. It opened an isolated SQLite backup
through the UI and compared the reopened document exactly with that same
expected document. Play was blocked with the Aries missing-start warning and
left the document unchanged. Evidence, including both documents and the
warning screenshot, is retained in `studio\data\clear-reopen-xCtueR\`; the
original evidence and database were not replaced. Earlier clear, Undo, wall
and recovery checks were not repeated. The regular server and user data were
preserved; no commit, push, deployment or kit rebuild was performed. T042
remains open.

An IDE debugger is optional. For manual CDP work, use disposable data, inspect
the test's cleanup and process ownership, and stop only processes you started.
Run the relevant check once; on failure, preserve output and stop rather than
repeating broad gameplay suites. Documentation-only changes do not need a
gameplay run.

### World-workspace opening timeout (2026-11-14)

The retained `studio\data\world-workspace-5EwUA9\diagnostics.json` timed out
waiting for
`document.querySelector("#world-workspace").open && document.querySelector("#world-status").textContent.includes("opened")`.
The original dialog state was `open: false`, with blank workspace/dialog
statuses and no uncaught exceptions; the screenshot showed the world chooser
still open. Direct CDP with a copied disposable database in
`studio\data\world-workspace-KntqIO\` captured the dialog error
`The world identity or model does not match the selected game.` and two HTTP
200 responses from the world-list endpoint, with no browser/console errors.
The detail endpoint was never requested: the harness treated the initially
enabled Open button as proof that the asynchronous list was ready, clicked
while its value was empty, then passed the list response to `openWorld`.
The list populated afterward, which explains the final screenshot but does
not mean the workspace opened.

The Open button is now disabled in the initial markup and while the list is
loading. The harness waits for the expected world ID and enabled button; its
original opening assertion and 500 × 25 ms wait and 15-second CDP limits are
unchanged. A disposable replay in
`studio\data\world-workspace-yzWxps\diagnostics.json` then opened **API world**
with a 200 response from the world-specific endpoint and no browser errors.
Shared-canvas section-edge rendering, both section boundaries, rejection of a
cross-section move without dirtying the workspace, movement within each
section, and the zoom-in control passed. The next run stopped at the first new
failure because its CDP wheel event omitted required `deltaX` and `deltaY`.
The continuation-only direct-CDP run
`studio\data\world-workspace-34H9RT\diagnostics.json` reused a copy of the
retained disposable database and skipped the completed API, opening and
movement assertions. With the corrected wheel event, zoom reached 33%; the
same green marker pixel remained under the pointer. A 60 × 30 CSS-pixel pan
moved both section boundaries together, and the marker retained its exact
section-local coordinates. Stored documents were unchanged during viewport
operations. A small UI drag then made the workspace dirty solely to exercise
Save; reopening through the UI restored both complete documents exactly,
including the expected `player-start-2` transform `(1024, 1024)` in section
`(-1, 0)`. There were no browser exceptions, console errors or failed API
responses. No completed API, opening or movement assertion was rerun. User
data, the regular server and unrelated edits were preserved; no painting,
fill, Play, commit, push, deployment or kit rebuild occurred. T042 remains
open.

### Terrain-brush increment verification (2026-11-14)

Run only the focused logic check first, then one disposable direct-CDP flow
if it passes:

```powershell
node studio\scripts\world-terrain-test.mjs
node studio\scripts\world-workspace-test.mjs --terrain-only
```

The logic check passed. Its retained
`studio\data\world-terrain-logic-ldQV1c\diagnostics.json` covers negative/grid
boundaries, fast connected diagonal and retraced strokes, replacement with
stable IDs/order, identical no-ops, both model validators, unrelated content
preservation, and atomic lock/hidden/missing/invalid-section, capacity and
serialized-size rejection. The console log is
`studio\data\world-terrain-logic-20261114222858.log`.

The first browser attempt stopped before CDP connected: Chrome PID 120716
exited with code 0 and empty stdout/stderr while the harness waited for
`http://127.0.0.1:63526/json/version` (`Error: Process exited`, at
`world-workspace-test.mjs:260`). The executable was
`C:\Program Files\Google\Chrome\Application\chrome.exe` (Chrome
157.0.8103.52), using `--headless=new`, `--disable-gpu`,
`--remote-debugging-port=63526`,
`--user-data-dir=studio\data\world-workspace-28taeI\chrome`,
`--window-size=1600,1000`, and `about:blank`. The launcher's successful exit
preceded the browser process exposing CDP; `ready()` incorrectly treated any
child exit as fatal before checking the endpoint. The harness now permits a
zero-exit Chrome launcher while polling CDP and closes Chrome through the
browser-level CDP command during cleanup.

The single continuation run passed with a fresh disposable profile in
`studio\data\world-workspace-AvOQBm\` and debug port 64635. It verified locked
and hidden rejection, Escape cancellation, missing-section rejection,
gap-free seam painting, one-command undo/redo, identical repaint as a no-op,
transactional save of both sections, service restart, and exact UI reopening.
There were no browser exceptions or console errors. The evidence directory
retains `diagnostics.json`, process logs, SQLite/game data, and the dedicated
Chrome profile; the browser profile process and debug listener were closed.
The original failed-run evidence and profile remain in
`studio\data\world-workspace-28taeI\`. Only owned test processes were stopped;
the regular server and other user data were preserved. The task checklist is
unchanged and T042 remains open. No kit rebuild, dependency install, commit,
push or deployment occurred.

### Rectangular terrain fill (2026-11-14)

The Studio-only rectangle uses the brush's continuous 32px world grid and
section-local replacement, preflight, history and transactional save. Both
endpoint cells are included, including reversed drags and negative world
coordinates. The preview reports cell and touched-section counts; Apply
validates all targets before changing anything, while Cancel or Escape
discards it. Missing sections are never created. The two-section working-set
and each document's existing limits still apply.

`node studio\scripts\world-terrain-test.mjs` passed; evidence is in
`studio\data\world-terrain-logic-O2vNaM\diagnostics.json`. It covers rectangle
geometry, true replacement with a second compatible test asset, preservation,
locks, missing sections and capacity rejection using both existing validators.
The single requested browser run,
`node studio\scripts\world-workspace-test.mjs --fill-only`, connected to CDP
but timed out before Studio finished opening Floor 1. Its diagnostics and
screenshot are retained in `studio\data\world-workspace-eOtD9W\`; the Chrome
profile is outside the watched tree at
`%TEMP%\studio-world-chrome-vdhleQ`. No browser fill assertion ran. The
browser fixture uses the one built-in Generic terrain asset, so its existing
tile checks exercise identical replacement/no stacking, not replacement by a
different asset; that behavior is covered by the logic fixture only.
No browser retry was made. T042 remains open.

### Interrupted startup continuation (2026-11-14)

The newest retained startup evidence is
`studio\data\levels-smoke-0Yb2hw\diagnostics.json`: the page remained
interactive with "Opening Floor 1...", no development readiness helper,
and no recorded map API request. Those response headers do not establish
completed image decoding or identify the exact blocking operation.

The continuation stopped at its first new failure, before launching Studio
or Chrome. The session-only direct-CDP driver's read-only fixture query used
`SELECT document_json FROM maps WHERE id = ?`; the retained database rejected
it with `Error: no such column: id` at driver line 16. Evidence is retained in
`studio\data\startup-levels-oCi2Ct\diagnostics.json`. No startup trace, response
bodies or browser-responsiveness measurements were captured, and no product
cause was demonstrated or fixed. The three focused Levels checks were not
run. Prior evidence, user data and existing edits were preserved; no suite,
kit rebuild, commit, push or deployment occurred. T042 remains open.

### Unified level sections (2026-11-14)

`npm run studio:sections:test` passed against disposable SQLite storage. It
verified existing map preservation, adjacent section creation and position
rejection, section maps excluded from the Levels list, cross-project isolation,
transaction rollback when the child-map update fails, idempotent retry,
service-restart reopening, and unchanged legacy World records.
`node studio\scripts\world-terrain-test.mjs` also passed its focused continuous
cell/seam/fill checks.

The one requested direct-CDP attempt stopped during web-server startup:
Windows returned `spawn EFTYPE` because the harness tried to launch Vite's
`.js` file as an executable. Evidence and disposable fixtures are retained in
`studio\data\sections-smoke-R7KfGt\diagnostics.json`. No browser assertions,
including editor interaction or single-section Play, ran. The harness now
invokes Vite through Node, but the browser flow was not relaunched to honor the
one-flow stopping rule. The regular server and user database were not used;
only the test-owned Vite process was stopped. T042 remains open.

The authorized continuation ran `npm run studio:sections:smoke` once with
fresh disposable storage in `studio\data\sections-smoke-yzGCrN\`.
The Vite launch matches `studio:dev`: executable
`C:\Program Files\nodejs\node.exe`, Vite's `bin\vite.js` as the first argument,
then `--config studio/vite.config.js`, with the repository as cwd and no shell.
The harness adds only its isolated `--port` and `--strictPort` arguments and
API-port environment override. Vite reported ready in 246 ms, confirming
the existing Node-launch correction resolves the retained Windows EFTYPE.
Launch metadata is now retained in diagnostics. The pending browser coverage
also includes main-editor placement/selection, hierarchy/Inspector sync and
an unchanged sibling-level fixture; existing assertions and limits remain.

The run stopped at the first new failure: the initial readiness guard timed
out at "Opening Floor 1..." before any editor interaction assertions ran.
`diagnostics.json` records no browser exceptions, console errors or API
responses, and `failure.png` captures the stopping screen. Add Section,
selection/placement, brush/fill, cross-section history, transactional
save/reopen, isolation and single-section Play remain browser-unverified.
No retry, product change, persistence/terrain/build rerun, commit, push,
deployment or kit rebuild followed. The user database's SHA-256 was unchanged;
legacy World records, unrelated edits and regular-server processes were not
touched. All owned test listeners/processes were confirmed stopped; the
disposable evidence and Chrome profile remain retained. `cleanup.json`
records the post-run checks. T042 remains open.

### Unified-editor manual-feedback repair (2026-11-14)

The dirty worktree was inspected first and retained. The repair replaces section
coordinate selection with an existing-section picker and a visual directional
preview, and the painting/fill button row with the three-mode Tool dropdown.
Section creation now clears only the **new document's** starter object array,
not any existing document. The shared scene cache now keys each cached image
to its own document; an entirely empty section draws without procedural
decorations. No migration or cleanup rewrites saved maps or legacy Worlds.

Static inspection confirmed that the earlier section path called populated
starter factories (Generic starts; Astraeum cobblestone and an Aries start).
It also confirmed that terrain preflight required exactly 2048 x 2048,
rejecting the existing 1152 x 704 Astraeum map even after unlocking Terrain.
Preflight now accepts supported saved dimensions and rejects any cell outside
the saved bounds atomically. The initial unsaved template's Save path again
uses the existing single-map creation endpoint before section transactions are
available. Play startup refresh is inside its protected cleanup path. Pending
fills block Play; multi-section levels have both a disabled Play button and
a visible Studio integration limitation. No section-transition implementation
is claimed.

The single requested direct-CDP reproduction attempt used disposable storage
in `studio\data\sections-smoke-NtD8CR\`. Chrome connected, but the main editor
stayed at **Opening Floor 1...** without the development helper or an API
response. The captured controls showed disabled Save and Play; there were no
recorded browser exceptions, console errors or failed network events.
`diagnostics.json` retains resource timings, disabled states, launch metadata
and process output; `stopping-controls.png` and `failure.png` retain the UI.
This occurred before the repair and before action event/validation checks:
Paint/Fill event handling and single-section Play were **not reproduced or
verified through the UI**. Resource completion is not proof of image decoding,
and no startup root cause is asserted. No further browser launch was attempted.

Focused terrain logic and disposable persistence checks passed, including
paint/fill on both models' smaller saved maps, bounds rejection, empty new
sections in both models, exact preservation of existing section content after
another addition/restart, and unchanged legacy World records. Terrain evidence
is in `studio\data\world-terrain-logic-m9WfBg\`. The Studio-only production
bundle built in a unique disposable directory (not a kit rebuild). Independent
installed-public-runtime adapter checks created and stepped Generic and
Astraeum single maps, moving their players from `(1040,1040)` to `(1040,1072)`
and `(144,152)` to `(144,184)` over eight ticks. These are **not UI Play
acceptance**. An auxiliary empty-map assertion initially expected the word
"start"; the runtime instead reported its two-player-"spawns" validation.
The isolated continuation passed with that corrected expectation and also
confirmed the editor's actionable missing-start messages.

The browser harness now offers focused `--sections-only`, `--tools-only` and
`--play-only` segments via `npm run studio:sections:smoke -- <flag>`; these
updated segments remain browser-unrun because startup was blocked. They use
native control input and capture event/validation/control snapshots. Existing
Levels smoke selectors follow the new dropdown. All changes remain local and
uncommitted; user databases, projects, assets, credits and unrelated edits were
not modified. No push, deployment or kit rebuild occurred. T042 remains open.

### Footprint fill, borders and Play investigation (2026-11-14)

The apparent automatic border was traced before editing the renderer.
`games\astraeum-tower\src\design-render.js` selects dual-grid Wang artwork
from four floor-occupancy corner bits. An isolated terrain cell draws tiles
13, 0, 8 and 15, with no wall object or object collision created. This is
artwork edge selection, not intentional border geometry. Separately,
`floorDocumentGrid` treats absent floor in the original Floor 1 area as
blocked; that pre-existing movement rule must not be confused with a newly
generated border. The renderer, artwork bytes, credits and original collision
adaptation were not changed. The new border option creates only explicitly
requested normal terrain/wall objects, using the chosen asset's existing
properties and collision defaults.

`studio\world-fill.js` composes the existing terrain planner and design-object
factories. It preflights cloned section documents, returns one document set,
and does not mutate live data. The main editor publishes that set through its
existing cross-section history. Object filling does not change snapping,
artwork, storage schemas or runtime APIs. The 8192-candidate preview bound,
two-section working set, per-section 4000-object and 2 MB limits still apply.
No-op fills do not add history. Border/overlap/spacing options are transient
tool settings; created normal objects use the existing Save path.

Focused checks:

```powershell
node studio\scripts\fill-test.mjs
node studio\scripts\world-terrain-test.mjs
```

Both passed. `studio\data\fill-logic-kikMVr\diagnostics.json` covers 22 x 30
barrels, spacing, configured footprint versus source region, default/optional
collision, exact existing-object preservation, same-layer Skip/Allow, optional
separate borders, negative coordinates, ownership, missing/hidden/locked and
capacity/serialized-size rejection, and terrain no-ops in both models. It also
executes the actual main editor's Apply/Undo/Redo/preflight functions in an
isolated Node context: one history entry restores both sections, Apply
revalidates locks, and stale previews cannot overwrite intervening edits.
This is controller/logic coverage, not browser acceptance. Existing terrain
checks passed in `studio\data\world-terrain-logic-AnZpqL\`.
The Studio-only production bundle built in the unique disposable
`studio\data\workflow-build-fb14fc1e8ed44dd1b7f4f199153114a3\` directory;
this was not a kit rebuild.

The single disposable main-editor direct-CDP reproduction attempt,
`node studio\scripts\sections-smoke.mjs --play-only`, stopped at the initial
readiness guard with **Opening Floor 1...**, before Play or fill interaction.
Evidence is retained in `studio\data\sections-smoke-rwTtq5\`: diagnostics,
screenshots, disposable database/games and process logs. The harness now
attaches/enables diagnostics before navigation and records each created
image's completion and natural dimensions. Six images had loaded; the
remaining eleven had `complete: false`, width/height zero. There was no map
API request, browser exception or console error. This bounds the observed
blocker to startup while awaiting artwork, but does **not** establish why
those image requests stalled or reproduce the user's Play-time failure.
No further browser launch was attempted. Main-editor single-section Play,
new fill controls and visual acceptance therefore remain browser-unverified.

Installed-public-runtime adapter checks created and stepped single maps in
both models: eight accepted Down ticks moved Generic `(1040,1040)` to
`(1040,1072)` and Astraeum `(144,152)` to `(144,184)`, leaving design documents
unchanged. These are not a substitute for clicking main-editor Play. No
single-map runtime failure was found by these checks, so no speculative
runtime repair is claimed. `LocalGameOptions` accepts one initial
`MapDefinition`, while public `ModuleContext.maps` supports module-driven
`prepare(MapGeometry)`/`commit(token, entities)` transitions. Studio does not
pass or load a level's section documents into that service, and the game
adapters do not implement section transitions; multi-section Play remains
disabled and unavailable in this Studio integration. This is an integration
gap, not a claim that the public runtime lacks all geometry-transition support.

Only disposable fixtures were written. Test-owned API/web/debug listeners
were confirmed stopped; existing editor processes and user storage were not
targeted. Current edits, projects, artwork and credits were preserved. All
changes remain local and uncommitted; no push, deployment, dependency install
or kit rebuild occurred. T042 remains open.

### Authoritative playable boundaries (2026-11-14)

The level document now optionally stores a validated, version-1 playable
boundary. Its default is the union of saved section areas, not their bounding
rectangle; shared seams stay open and missing-section holes remain blocked.
Grid masks and validated closed polygons are previewed in the existing Tool
dropdown. Apply and Reset each create one history entry; Escape cancels the
preview. Custom boundaries are owned by the root section document and are not
rewritten when another section is added. No decorative border objects are
generated, and player starts are never moved.

Both Generic and Astraeum adapters rasterize playable cells into hidden
rectangle collisions accepted by the installed public map contract. Polygon
collision shapes are not public; the lasso is rasterized to 32 px cells.
`MapDefinition` is limited to 2048 px per dimension, rectangle collisions, and
4096 objects/collisions. Out-of-bound player starts produce a Play warning.
This enforces supported single-section boundaries in runtime geometry; it
does not claim cross-section enforcement. Although the installed runtime has
module-driven geometry transitions, Studio does not supply or stream section
documents through them, so multi-section Play and traversal remain explicitly
unavailable in this Studio integration.

`npm run studio:boundaries:test` passed geometry (including exposed edges,
shared seams, holes, expansion and invalid outlines), preview cancellation,
Apply/Reset Undo/Redo, both model adapters and spawn warnings, public
single-section collision/movement checks, and disposable persistence/reopen.
`npm run studio:persistence:test`, JavaScript syntax checks, and
`git diff --check` passed. A disposable Studio-only Vite production build
passed; no kit rebuild was performed.

The one requested direct-CDP attempt,
`node studio\scripts\sections-smoke.mjs --boundary-only`, stopped at its
initial readiness guard: `window.__studioTest` and enabled Open Game never
became available while the page remained at **Opening Floor 1...**. No boundary
UI or Play assertions ran. Evidence is retained in
`studio\data\sections-smoke-ikbHnz\` (diagnostics, screenshots, disposable
database/game data and process logs); all three harness-owned processes were
confirmed stopped. No retry was made. Main-editor single-section Play and
boundary interactions therefore remain browser-unverified.

All work remains local and uncommitted. Existing maps, artwork, assets, credits,
backups, legacy records and unrelated edits were preserved; no push, deployment
or kit rebuild occurred. T042 remains open.

### Main-editor Boundary and Fill Apply repair (2026-11-15)

The real main-editor path is Tool/palette selection, canvas pointer
down/move/up, boundary rasterization or fill planning, pending preview, the
registered Apply click handler, model/section validation, document-set history,
`refreshChrome`, and the per-document scene cache plus canvas overlays.
Inspection and the focused event fixture confirmed these defects:
Boundary Apply cleared its draft but left Boundary active and its settings
panel open; the outline renderer returned early outside Boundary mode.
The shared pending-gesture keyboard guard prevented native Enter/Space button
activation (including Apply/Cancel) and Tab navigation. Fill discarded its
placement plan on Apply rejection. Boundary caught refresh failures after
publishing the document/history and incorrectly said nothing changed; Fill
could keep a published edit while reporting an editor-refresh failure.
These are confirmed source/event-fixture causes, not a claim that the user's
pointer-click symptom was reproduced in Chrome.

Boundary success now returns to Select, hides its settings, keeps the applied
outline visible and marks the level dirty. Both Apply handlers publish through
one transactional document-set/history/refresh path: validation failure keeps
the draft/placements and visible specific error; refresh failure restores the
documents, Undo/Redo and pending preview before reporting rejection. Boundary
previews also protect against stale documents and block competing document
edits like Fill. Cancel never publishes a document. No-op Apply closes the
pending preview without adding history.

`npm run studio:apply:test` executes the complete main module and its actual
registered events, palette and section selection, pointer gestures,
validation, chrome, hierarchy, scene caching and both model renderers using
an isolated browser-I/O fixture. It covers grid/lasso Apply, native-key
default prevention, Apply/Cancel, specific rejection, refresh-failure rollback,
root ownership while another section is active, two-section fills, no-ops,
dirty state and one-step Undo/Redo. Renderer assertions inspect emitted drawing
commands and cache/document identities; they are not browser pixel acceptance.
The focused fill and playable-boundary regression checks also passed.

The single disposable direct-CDP attempt,
`node studio\scripts\sections-smoke.mjs --apply-only`, stopped before editor
readiness at **Opening Floor 1...**. No Apply, pixel or Undo/Redo browser
assertions ran. Diagnostics, screenshot, process logs and disposable storage
are retained in `studio\data\sections-smoke-mCrEo5\`; no retry was launched.
The focused segment is ready to check native Apply/Cancel activation, actual
outline/object pixels, validation and Undo/Redo once startup can complete.
All owned processes stopped and their listeners closed. The regular web/API
listener PIDs remained 24392/4960, and the regular web endpoint returned HTTP
200. A read-only hash attempt on the regular SQLite file was denied by its
existing process lock; no hash comparison is claimed. User storage was not
targeted by any test. Existing edits remain local and uncommitted; no push,
deployment, dependency install or kit rebuild occurred. T042 remains open.

### Rectangle Fill palette-input repair (2026-11-15)

The reported `Placed Damp stone wall ...` status comes from
`placeFromPreview`, not the rectangle handler. Canvas pointerdown in Fill
already starts a fill gesture; pointermove updates its rectangle and pointerup
creates the pending plan without changing objects. The separate palette route
captured the pointer on its card, then `paletteUp` called single-object
placement after a drag onto the canvas without checking the active tool.
Fill stayed active, so its panel remained open with no rectangle preview
and disabled Apply/Cancel.

The main-editor event fixture reproduced this single-wall edit before the fix.
In Fill, palette pointerdown now only arms the asset; it does not start the
single-placement drag route. Painting and palette drag placement outside Fill
are unchanged. Cancel is enabled throughout active Fill, including before an
asset/rectangle exists and after Apply or rejection; it clears transient
previews, closes Fill controls and returns to Select without document/history
changes.

`npm run studio:apply:test` covers the tool dropdown, palette capture routing,
canvas pointerdown/move/up, valid-preview Apply, one-step Undo/Redo, invalid
locked-layer explanation, and Cancel before selection, before drawing, after
Apply, with a pending preview and after rejection in both models. It also
checks that palette drag placement still works in Paint. The retained CDP
segment reselects Fill after Cancel to match the exit-to-Select behavior.
No browser startup was attempted again; this is full-module event/render
fixture coverage, not new browser acceptance. User data and the regular server
were not targeted. Changes remain local and uncommitted; no push, deployment
or kit rebuild occurred. T042 remains open.

### Rectangle Fill Apply-only trace (2026-11-15)

The follow-up did not reproduce a broken Apply handler. The user's live
transient asset/settings, preview and status were unavailable; the requested
capture could not be supplied while the user was away. No browser was
launched and no production behavior was changed on an assumed cause.

The full-main-module event fixture now also loads the complete authored
Floor 1 (1197 objects), chooses Fill and Damp stone wall through the registered
UI events, and records preview existence, Apply disabled state, placement and
skip counts, validator results, registered-handler execution, document/canvas
counts, status and history. It uses default settings: gaps 0/0, Skip overlaps,
no border and optional collision off. These are fixture settings, not a
capture of the user's live settings.

For world drag `(259.4,259.7)` to `(349.6,350.2)`, the preview is valid and Apply
enabled, but all four wall slots overlap existing walls: zero placements,
four skipped. The handler executes, revalidation passes, the preview clears,
and the visible status explicitly reports unchanged. No document/history
change occurs. For `(131.4,131.7)` to `(221.6,222.2)`, four slots are available:
Apply runs, revalidation passes, the complete document exactly matches the
previewed update, objects and canvas count increase from 1197 to 1201, and
exactly one Undo entry is added. The real scene renderer emits additional wall
draw commands; one Undo restores the original document/draw count and Redo
restores the applied result. A subsequent lock before Apply produces the
specific visible locked-layer rejection, keeps the preview, and preserves
objects/history. Cancel still returns to Select without changing objects.

`npm run studio:apply:test` passes with this trace and the prior event/render
coverage. The fixture's missing `fillText` Canvas stub was added to support
the template's existing placeholder objects; that was a test-harness gap,
not an editor error. This establishes successful main-module Apply and
distinguishes a valid overlap-skipped no-op from rejection or a missing
handler. It does not identify which case the live user encountered or prove
browser pixel acceptance. Further diagnosis needs the actual panel/status
capture, not another speculative product repair. Existing edits and user data
remain untouched; the regular server was not restarted. No commit, push,
deployment or kit rebuild occurred. T042 remains open.

### Temporary live Fill diagnostics (2026-11-15)

The existing main-editor Fill panel now shows **Temporary Fill diagnostics**
with served-code marker `fill-live-2026-11-15-r1`, module URL and load time.
Use the normal browser and reproduce the actual failure, then **Copy report**.
If clipboard access fails, the report is selected for Ctrl+C. The read-only
report can also be selected manually; it pauses updates while focused.
Missing or different served-code markers indicate an old/loading editor, not
evidence that the new handlers ran.

The bounded, memory-only report retains the last 32 timestamped events plus
the current tool, selected/gesture asset, settings, target layer, pointer mode,
world rectangle, preview/skip/update counts, actual Apply disabled/inert state,
validation and status. Events cover canvas/palette pointer down/up, pointer
cancellation, Apply-area pointer/click delivery, Apply handler entry/guards,
preview and Apply validation, document identity/object counts before and after
publication or rollback, history counts, and completed/skipped/failed redraws.
Redraw evidence includes scene rebuild counts, cache identities and camera/
viewport information; it records Canvas execution, not browser pixel acceptance.
Fill-time uncaught errors/rejections are recorded without suppressing them.

These are observers of the existing workflow, not a new Fill implementation.
No automatic Apply, Save, data writes, browser launch, server restart, speculative
scenario test or kit rebuild is part of this diagnostic change. Cancel retains
its existing exit-to-Select behavior and never publishes a document. Reports
are not persisted or sent anywhere; copy before reloading. Existing edits stay
local and uncommitted. T042 remains open pending the user's live reproduction.

### Fill asset visibility and selection-state checks (2026-11-15)

The Fill panel now explicitly says **Choose a fill asset from the palette**
when `placeAssetId` is empty, and displays the selected asset's thumbnail and
name otherwise. It reuses the palette renderer and the same `placeAssetId`
read by canvas pointerdown; no default asset is chosen. Switching into Fill
already retained that state and continues to do so. Missing-asset canvas
gestures now report the same actionable instruction. Cancel is unchanged.

`npm run studio:apply:test` passed with both models: registered palette
pointer events update the displayed selection, Paint-to-Fill retains an
eligible asset, and the Fill pointer handler captures that exact asset into
the rectangle preview. It also checks missing-asset rejection, thumbnail
render commands, Apply, Cancel preserving existing edits, and Undo/Redo.
This is full-module browser-I/O fixture coverage, not native browser-click
acceptance. The fixture now substitutes `import.meta.url` for the existing
live diagnostic report when executing the module in its VM.

One disposable direct-CDP `--apply-only` attempt stopped at **Opening Floor
1...** before any palette assertions ran. Six artwork images completed;
the remaining image requests had not completed at timeout. Evidence is
retained in `studio\data\sections-smoke-PJ42Gz\`; the underlying startup
cause is not established, and the browser flow was not relaunched. The CDP
segment includes selection/thumbnail, pointer-state and Cancel regression
assertions for a future successful startup. User storage and existing edits
were not targeted; changes remain local and uncommitted.

### Generic single-section editing-to-Play acceptance (2026-11-16)

The normal `npm run studio:dev` path ran against disposable storage under
`studio\data\acceptance-aadb7eb3d4cc478e8f389248bebaef87\`; the web page and
map API returned HTTP 200. Firefox 160 reached the editor and completed the
UI acceptance without Chrome or the IDE debugger.

In the disposable Generic project
`generic-acceptance-probe-4b3e8e72-4134-4bc4-b80a-ee8304826b03`
(`map-51a56f81-1bc8-4474-802b-ae4c43f3d774`), palette placement produced a
floor tile at (704,704), collision box at (1088,1024), and a second valid
player start at (800,800), alongside the default start at (1024,1024). After
Save and UI reopen, the full API design matched exactly and each object's
Inspector ID, transform, and collision setting matched the saved values.

The real Play button started the preview. ArrowRight moved the player from
X=1040 to X=1080 and the collision stopped further movement at the blocker.
Stop returned to the editor with four objects and a saved state; the API
design remained byte-for-byte equivalent as a parsed document to the saved
design. A separate two-section fixture showed Play disabled with the explicit
single-section-only explanation.

`npm run studio:persistence:test`, `npm run studio:apply:test`, and
`npm run studio:boundaries:test` passed. The boundaries test required its
isolated VM fixture to provide `fillDiagnostics: { applying: false }`; this
fixture correction was not a production workflow defect. Unlocking the
Terrain layer in Layers was required before placing the floor, as indicated
by the editor; no product defect was demonstrated.

**Acceptance result: pass.** The requested single-section edit, Save/reopen,
Play movement/collision, Stop preservation, and multi-section Play limitation
are verified. Multi-section Play remains explicitly unavailable; no runtime
streaming, AI, tools, or panels were added. Evidence screenshots and detailed
Firefox diagnostics are in the disposable acceptance directory above.
Changes remain local and uncommitted; user data and unrelated work were
preserved. No deployment or kit rebuild occurred, and T042 remains open.

### Paint asset feedback and sized brushes (2026-11-17)

Paint now displays the chosen palette asset and offers 1 x 1, 2 x 2, 4 x 4
and 8 x 8 terrain brushes with a grid-cell cursor footprint. It composes the
existing terrain-stroke rasterizer, atomic preflight and section Undo path;
the separate World workspace retains its default one-cell brush. Fill,
Boundary, section storage and Play behavior were not changed.

`node studio\scripts\world-terrain-test.mjs` passed, retaining evidence in
`studio\data\world-terrain-logic-2jN6oe\`. Geometry checks cover all sizes,
negative coordinates, fast and retraced strokes, footprint/cell agreement,
invalid sizes and the existing working-set limit. `npm run studio:apply:test`
passed full-main-module pointer/control/renderer checks in both models:
selected thumbnails, all four cursor/stamp sizes, exact cross-section cell
counts, single Undo/Redo, identical no-ops, locked/hidden/missing-section
rejection, cancellation, size capture and non-terrain single placement.
These are browser-I/O fixture checks, not native-browser pixel acceptance.

The one disposable native-editor attempt,
`node studio\scripts\sections-smoke.mjs --paint-only`, stopped at the initial
readiness guard with **Opening Floor 1...**, before any Paint UI assertion
could run. No browser exceptions, console errors or API responses were
recorded by the page diagnostics. Evidence, stopping screenshots, disposable
SQLite/games and owned-process logs remain in
`studio\data\sections-smoke-msTcMJ\`. No startup retry or alternate browser
launch followed. Actual browser Paint interaction/visual acceptance remains
blocked and is not claimed as passed. The focused segment is retained for a
future authorized attempt; it exercises Paint only, not Fill/Boundary/Play.

The existing external rollback backup at
`C:\code\studio-rb\20261116-234226` was not modified. Pre-Paint versions of
touched files were additionally preserved outside the repository. User data,
other source edits and regular-server processes were not targeted. No
dependencies were installed, schema changed, commit/push/deployment or kit
rebuild performed. All changes remain uncommitted and T042 remains open.

### Accessible Add Level and distinct Add Section (2026-11-17)

The keyboard-accessible native **Level** disclosure reuses the existing
Add Level dialog/API and directional Add Section flow. Only Add Level's
new document has its starter objects cleared; model factories, New Game,
duplicates, existing saved levels, section storage and Play are unchanged.
Paint, Fill and Boundary behavior were not expanded or changed.

`node studio\scripts\persistence-test.mjs` passed on disposable databases.
Both models create one empty 2048 x 2048 origin section without inheriting
terrain, starts, objects, boundaries or other sections. Checks compare all
existing map rows (including timestamps), section memberships and project
starting metadata before/after creation. Explicit edits to the new levels
survive save and service restart/reopen; original multi-section levels, the
other project and existing World records stay unchanged.
`node studio\scripts\editor-apply-test.mjs` passed the full-main-module
menu/event fixture checks: existing Add Level dialog, distinct Add Section
placement panel, cancellation, dirty Save/Discard/Cancel controls and busy
states in both models. Syntax and whitespace checks passed.

The single disposable native-editor attempt,
`node studio\scripts\sections-smoke.mjs --levels-only`, timed out at
**Opening Floor 1...** before creation/switching assertions could run.
Page diagnostics recorded no exceptions or failed network responses; the
asset images had not completed. Logs, stopping screenshots, diagnostics and
disposable data remain in `studio\data\sections-smoke-ICyb19\`.
No repeated startup or alternate browser launch followed, and all owned test
processes exited. Actual browser interaction acceptance remains blocked and
is not claimed as passed. The focused lifecycle segment is retained.

Pre-slice source copies remain outside the repository alongside the
unchanged external rollback backup at
`C:\code\studio-rb\20261116-234226`. Existing user data and unrelated edits
were preserved. No dependencies were installed, live data migrated, commit,
push, deployment or kit rebuild performed. Changes remain uncommitted and
T042 remains open.

### Direct Add Section button and explicit confirmation (2026-11-17)

**Add Section** is directly below **Selected section**, outside the compact
Level menu; **Add Level** remains in that menu. This supersedes Add Section's
menu location recorded in the previous slice. The same directional placement
and section API are reused, with a selected-side/coordinate preview and
explicit **Confirm Add Section** or **Cancel**. Occupied positions stay
disabled. Switching the selected section clears a pending side choice.
Confirmation retains the existing revision checks and local unsaved-document
merge; no server/storage behavior, Paint, Fill, Boundary or Play was changed.
Remove Section was not started.

`node studio\scripts\editor-apply-test.mjs` passed in both models. It executes
the actual main-module button/dropdown/direction/confirmation handlers using
disposable in-memory designs and substituted browser/network I/O. Checks
cover the button's position, selected-section anchor, occupied sides, no POST
on side choice or cancellation, fresh selection after reopening/changing
anchor, saving guard, exactly one confirmation POST with the intended
coordinates/revision, empty response integration and preservation of existing
coordinates, unsaved content, pan and zoom. Existing Paint/Fill event and
renderer checks also passed. `node studio\scripts\persistence-test.mjs`
passed disposable SQLite checks for empty section creation in both models,
occupied-position rejection, existing content/coordinate preservation,
atomic save/restart/reopen and project isolation. Syntax checks passed.

The single native-editor attempt,
`node studio\scripts\sections-smoke.mjs --section-add-only`, stopped at the
initial **Opening Floor 1...** readiness guard, before button assertions.
Evidence remains in `studio\data\sections-smoke-G4yoQC\` (diagnostics,
screenshots, owned-process logs and disposable data). It was not retried.
Native-browser button/direction/cancel/create acceptance is therefore
**blocked**, not passed. The focused segment is retained for a future
authorized run.

Pre-slice copies remain outside the repository. The external rollback backup,
unrelated source edits and user data were preserved. All changes remain
uncommitted, with no push, deployment or kit rebuild; T042 remains open.

### Historical 0.2.0 connected-section Play contract gate (2026-11-17)

Connected-section Play is the next focused milestone: movement, camera and
collision only; no editor features were added. The installed public
`API.md`, map/SDK/local-preview declarations, sample settings/module and both
Studio/game adapter paths were inspected first. The exact contract inventory,
rejected workarounds, proposed Engine-owned world schema/geometry semantics,
package deliverables and subsequent Studio adoption gates are recorded in
`ENHANCEMENTS.md` under **Connected-section Play**.

The current public map validator limits each map to 2048 px per axis. The
optional `ModuleContext.maps` service replaces one zero-origin geometry and
its supplied entity set; it does not itself compose section origins into a
connected world. Its lower-level `MapGeometry` type does not declare the map
schema's dimension maximum: this investigation does not assert that oversized
`prepare` calls fail. No such bypass was attempted. Bounded geometry replacement
is real; position-rebasing/window-streaming would need additional explicit
world-coordinate conventions, not an assumption that swapping maps opens a seam.
The existing multi-section disabled button and programmatic guard remain,
with no fallback to one section and no changes to single-section runtime code.

`npm run studio:runtime-sections:test` verifies both X/Y map-size rejection,
authored initialization, exterior circle clamping at 2040 for radius 8,
rejected adjacent world-coordinate entity commits, unchanged state after a
failed commit, and supported same-position/local-position replacements.
It also runs the actual Generic and Astraeum modules for eight Down and eight
Up ticks, checking authored starts (including Astraeum's existing feet offset),
movement speed, return position and unchanged source designs after disposal.
`npm run studio:boundaries:test` passed the existing union/seam/hole geometry,
both map adapters, public single-section collision, history and disposable
persistence checks. These are focused contract/regression checks, not seamless
multi-section acceptance.

The single browser attempt was
`node studio\scripts\sections-smoke.mjs --connected-play-only`. That segment
opens the live database **read-only**, takes a SQLite online backup (including
committed WAL contents), and copies project assets/metadata into its own
`studio\data\sections-smoke-*` directory before launching isolated services.
It never copies or writes to an external backup, saves a user design, or
attaches to the existing editor. The saved-storage snapshot cannot capture
unsaved edits held in another browser; those edits were not touched.

This run stopped at the initial **Opening Floor 1...** readiness guard.
`window.__studioTest`/enabled Open Game did not become ready; no connected or
single-section browser Play assertion ran. Evidence is retained in
`studio\data\sections-smoke-YurAdG\`: `diagnostics.json`, two stopping
screenshots, three owned-process logs, the copied SQLite database and copied
project assets/metadata. The page recorded no exceptions, console errors or
API responses before stopping; no startup root cause is asserted. No retry or
alternate browser was launched. API, web and Chrome test processes exited;
their PIDs had no remaining processes or listeners.

The snapshot contains every saved level, but its automatic authored-floor-pair
candidate was an older four-section level with no player start, **not a
verified identification of the user's currently edited two-section level**.
No replacement start or floor was authored. Future actual traversal acceptance
must explicitly identify that selected level and include its current authored
start/unsaved section snapshot; the blocked startup did not reach selection.
The copied original `maps` rows, including exact JSON and timestamps, retained
the same SHA-256 digest after shutdown (`savedMapsUnchanged: true`).

Unverified: selected-level section/start loading, bidirectional crossing without
position reset/artificial seam wall, floor/camera continuity, collision on both
sides plus the outer boundary, and connected Play/Stop pan/zoom/selection
restoration. Saved-data nonmutation was checked on the copy, not claimed as a
successful connected gameplay run. All existing edits and the external backup
were preserved. Changes remain uncommitted; no push, deployment, dependency
install or kit rebuild/upgrade occurred. T042 remains open.

### Developer Kit 0.3.0 connected Play integration

**User's manual confirmation:** movement, camera and collision work across sections.
This is separate from the focused automated checks and the blocked browser
acceptance attempt below; it does not confirm combat, multiplayer or full
browser acceptance.

The archive and adjacent SHA-256 sidecar were located in the sibling Engine
checkout's `var\developer-kit\`, verified against the pin in Section 1, then
copied into ignored `engine\archives\`. Manifest version/revision, committed
source state and all 43 source-input hashes were checked against commit
`dca3ffc4561c14e0e83968afceabf0e85cddc565`; the recorded Windows build inputs
use CRLF, so committed LF Git blobs were converted to CRLF for that comparison.
The existing setup `--upgrade` flow selected the new versioned kit/dependencies.
Editable sample source, earlier kits, user storage and the external backup were
preserved. Both Vite configs now resolve the receipted dependency selection.
No bundled files or Engine source were edited or imported.

`studio\extensions\connected-play.js` snapshots all documents of the selected
level, validates global authored starts and uses the public `world` option.
It preserves simulation identity/ticks and world coordinates through crossings;
it never swaps maps, rebases entities or exceeds local map limits. Generic
requires its two authored starts; Astraeum requires one authored Aries start.
The latter retains its existing **unused runtime compatibility slot** because
the public schema requires two distinct starts. Unlike the single-map legacy
adapter's fixed `(80,80)`, the connected slot is selected from already walkable
cells inside the existing boundary, excluding Aries and authored collisions.
It creates no second actor, saved object or floor and never replaces/moves
Aries. A world with fewer than two suitable cells fails explicitly. This is
necessary for sparse authored floors, including the preserved two-section level.
Exact small Astraeum object colliders supplement public cell-compatible geometry;
the existing game helper and neighbor-aware Wang renderer are reused.

Focused checks passed:

- `npm run studio:connected-play:test`: both models on X/Y negative-origin
  seams, exact four-pixel crossings both ways, continuous camera, authored
  blockers on both sides, outer/custom boundaries, sparse-floor compatibility
  starts, matching Wang floor halves, input neutralization and source immutability.
- `npm run studio:apply:test`: actual main-editor Play/Stop with the real
  runtime and substituted browser I/O; complete level despite another active
  section, unsaved edits, exact pan/zoom/active-section/selection restoration,
  unchanged history/saved baselines and cleanup after injected mount failure.
- `npm run studio:runtime-sections:test` and `npm run studio:boundaries:test`:
  bounded replacement and both existing single-section adapters, collision,
  boundary/history/persistence regressions. The packaged connected consumer
  also passed west/east and east/west traversal.
- Both kit inventories passed again (46 new, 44 retained). A Studio-only Vite
  production build passed into
  `studio\data\connected-play-build-756221349f7f41feab97454cad0942c9\`;
  this was not a kit rebuild.

**One browser attempt, blocked; not acceptance passed.**
`node studio\scripts\sections-smoke.mjs --connected-play-only` made a read-only
SQLite online backup and copied project assets/metadata. Both-model connected
fixtures and a Tower single-section fixture were added only to that copy.
Startup stopped at **Opening Floor 1...** before `window.__studioTest`/enabled
Open Game became ready. No browser gameplay assertion ran. Evidence remains
in `studio\data\sections-smoke-JF6A63\`: diagnostics, stopping screenshots,
three process logs, copied SQLite/assets and retained Chrome profile location.
No page/console errors or API responses were recorded; no root cause is claimed.
There was no retry. Owned API, Vite and Chrome PIDs exited and ports
50325/50326/50327 had no listeners. The copied original map rows, JSON and
timestamps retained digest
`935cc48c44b61da113f168e8656fcd0225606dc66d2e144546796f0610516a41`.

A separate **headless public-runtime** check opened that copy read-only and
identified the existing two-section, 12/13-floor-tile level (no fixture edits).
It initialized at authored `(1488,592)`, moved to corridor Y=1008, crossed east
to `(2128,1008)` at tick 264 and returned west to `(1488,1008)` at tick 424.
Every movement step was four pixels and camera increments stayed continuous
at X=2048. Documents and database rows were unchanged; detailed measurements
and before/after hashes are in `copied-level-runtime.json` beside diagnostics.
This also caught and fixed the fixed reserved-start problem on sparse floors.
It does not establish native-browser rendering or control behavior.

**Browser-unverified:** selected-level/start loading through actual UI; both-way
crossings, visual floor/camera continuity, collision and outer boundaries;
Stop pan/zoom/selection; saved-design nonmutation during a successful browser
Play; and both single-section browser regressions. Focused runtime/controller
evidence above is separate. All changes remain uncommitted; no push, deployment,
further kit rebuild or external-backup access occurred. T042 remains open.

### Review-time verification deviation (2026-11-17)

Despite the instruction to use recorded checks and not repeat the blocked
browser launch, review agents reran checks without a review-required code
change. `studio:connected-play:test`, `studio:runtime-sections:test`,
`studio:boundaries:test`, `studio:apply:test` and `studio:sections:test`
passed; `npm run verify` and the sample Vite build also passed. These are
separate from the user's manual confirmation above.

The review also launched four unauthorized browser flows. `studio:sections:smoke`,
`studio:levels:smoke` and `studio:world:test` stopped at **Opening Floor 1...**
before their editor assertions. Their retained evidence is respectively
`studio\data\sections-smoke-aBOB9J\`, `studio\data\levels-smoke-eHMapM\`
and `studio\data\world-workspace-GR1Wbi\`. `studio:smoke` timed out at a
page reload/readiness condition; no retained evidence directory was reported.
These failures do not constitute browser acceptance. The recorded section and
World test process IDs had exited and their recorded ports had no listeners;
cleanup of the other attempts was not independently confirmed.

### Remove Section (2026-11-17)

**User's manual confirmation:** the Add/Remove Section explicit-Save workflow
works. This is separate from the automated fixture coverage below.

The user also observed that empty sections cannot be traversed until floor is
painted. Adapter inspection confirms a narrower Astraeum rule: connected Play
converts `floorDocumentGrid` blocked cells into collisions. Within each
section's original Floor 1 footprint, cells without floor are blocked; cells
outside that footprint are open unless otherwise blocked. Generic connected
Play does not apply this floor grid. This describes existing adapter behavior,
not a change to gameplay.

Focused disposable persistence checks cover both models, original and other
section removal, exact retained documents and positions, Save/restart/reopen,
undo-compatible restoration, idempotent retry, stale revisions, injected
rollback, custom-boundary rejection, occupied-position conflicts and legacy
World isolation. The main-editor browser-I/O fixture checks the actual
confirmation controls, player-start and boundary warnings, Cancel, one-step
Undo/Redo including after Save, preserved unsaved changes and lost-response
reconciliation. Connected runtime and existing single-map contract checks
cover the archived-root routing and existing behavior; boundary checks cover
the default union and custom boundary. No native browser was launched, so
these do not establish browser UI acceptance. T042 remains open.

Review fixed uncertain-save reconciliation for an undone new section and
rejects history operations that would overflow the archive. Direct single-map
writes and level renames now advance the section revision, so stale section
saves cannot overwrite them. A combined Save also permits a new section to
remain when its saved anchor is removed. After these review changes,
`npm run studio:apply:test` and `npm run studio:persistence:test` passed.

The running API can still be the pre-removal version after Vite updates the
editor: it does not return `archivedSections` and rejects a removal save by
comparing only active-section counts. A disposable reproduction used equal
baseline and submitted revisions (1), with two persisted sections versus
one active and one archived in the request; the old service returned 409.
The current service accepts the active/archive union while still rejecting
genuine stale revisions. A live dirty draft must not be reloaded or discarded
to resolve this mismatch; restarting the Studio launcher also stops Vite.
Coordinate draft preservation and an API restart before retrying.

## 6. Enhancement tracking and Git

Record reusable capabilities and API gaps in
`studio\docs\ENHANCEMENTS.md`. Keep game-specific implementations and proposed
Engine promotions separately reviewable (separate paths/commits; do not mix
gameplay, reusable extensions, and kit changes into one change). Each entry
records feature, API gap, implementation path, focused tests, kit dependency,
status, and relevant Studio/Engine commits.

Use only these statuses:

- **game-specific** — intentionally owned by one game.
- **Engine candidate** — reusable prototype exists locally; not a public Engine API.
- **promoted** — a reusable API has been reviewed and shipped in a versioned kit.
- **migrated** — an affected game has explicitly adopted the promoted API and
  its prototype was retired after behavior checks.

Before committing or pushing, review tracked and ignored user data and both
staged and unstaged diffs:

```powershell
git status --short --ignored
git diff --stat
git diff --cached --stat
git diff --cached
```

After an authorized fetch, compare local commits with the intended upstream
branch (for this repository, commonly `origin/main`) to identify outgoing
history before pushing:

```powershell
git fetch origin
git log --oneline origin/main..HEAD
```

Do not stage broadly, discard unrelated changes, amend history, commit, or push
without authorization. Distinguish **uncommitted** work in the working tree,
**committed locally** history, and **pushed** commits present on the remote.

## 7. Promotion into Engine

Follow this explicit cycle:

1. Prototype the capability in `studio\extensions\` or the owning game and
   record the API gap and evidence in `studio\docs\ENHANCEMENTS.md`.
2. Review whether it is genuinely reusable, define a public API and supported
   options, and implement/test it in the Engine repository—not in this
   checkout's installed package.
3. Build and verify a new versioned kit in the Engine workflow; record its
   version and Engine commit. Do not edit or rebuild the installed kit as a
   substitute.
4. Explicitly upgrade Studio to that kit, then explicitly migrate each affected
   game. A kit upgrade does not overwrite or replace custom game code.
5. Compare saved settings, artwork, collision and gameplay behavior before
   retiring the prototype; mark the record migrated only after focused tests.

This repository contains the packaged kit and its pin, not the Engine source
checkout. A required Engine change must be tracked and implemented in that
separate owner; do not claim that a Studio-local module has been promoted.
