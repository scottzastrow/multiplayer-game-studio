# Studio developer and assistant guide

Help Anh both **use Studio** and **develop her game**. This is the technical
source of truth for setup, ownership, reuse-first assistant behavior, adaptation,
verification and Engine handoff. Keep assistant entry files short and link here
instead of maintaining separate Claude/agent policies.

## Reading map and authority

| Need | Read |
| --- | --- |
| First start or stop | [Root README](../../README.md), then [setup](#1-fresh-machine-setup) |
| "How do I...?" / actual editor workflow | [Studio user guide](../README.md#how-do-i) |
| Change source or storage | [Ownership](#3-extending-through-source), [API reuse](#4-claude-reuse-first-workflow) |
| Bring in an existing source game | [Adaptation process](#source-game-import-and-adaptation) |
| Decide what is actually verified | [Evidence rules and command selection](#5-verification) |
| Propose a shared capability | [Enhancement register](ENHANCEMENTS.md), [promotion](#7-promotion-into-engine) |
| Complete Studio game ZIP / Engine import | [Inspected contract blockers and Engine handoff](GAME-EXPORT-HANDOFF.md) |
| Prepare Wednesday's demo/handoff | [Delivery checklist](#wednesday-delivery-checklist) |

The user guide owns operating instructions; Section 2 below records detailed
implementation invariants. Section 5's dated investigations preserve earlier
states and failures, not current commands to replay against user data. Current
source plus the pinned public API/declarations decide capability; if a guide,
static UI string or historical task checkbox disagrees, state the discrepancy
and correct the relevant documentation without inventing behavior. In
particular, the former "E / controller X" static rune help in
`studio\index.html` was stale; it was corrected during this handoff to describe
automatic rune entry and nearby chest opening.

**Documentation audit, 2026-11-17:** read root/Studio/assistant guides, current
UI/controllers, server/launcher/setup, game modules, public kit `API.md`,
package declarations/settings and prior evidence. Commands below were checked
against their script/configuration, not newly executed in this documentation
pass. No services/browser suites were started and no kit was rebuilt.
Do not treat this audit as a new acceptance pass.

**Earlier handoff scope, 2026-11-18:** the
[developer handoff](DEVELOPER-HANDOFF-2026-11-18.md) records scoped commits,
downloadable repository artifacts, the consistent live-data comparison,
committed 0.4.0 fresh-checkout verification and remaining limitations, not
acceptance of the later 0.5.0 export work. Historical
investigations remain dated evidence, not new acceptance claims.

## 1. Fresh-machine setup

Use the inner Git repository as the working directory:

```powershell
git clone https://github.com/scottzastrow/multiplayer-game-studio.git
Set-Location .\multiplayer-game-studio
node --version  # Node.js 24.x
npm --version   # npm 11.x
```

The root `package.json` declares Node `>=24 <25` and npm `>=11 <12`;
use those versions rather than relying on npm to enforce its engines field.
`engine\developer-kit.lock.json` pins kit 0.5.0, Engine revision
`d0f46931f56b90298b3209010581a0ffd7f79561`, and archive SHA-256
`e8ce6ecea7da50db34610ee4c54e7a56480c57a1b2ac505dc5c73afb9370d2d1`.
The repository artifact is
`engine\artifacts\multiplayer-game-developer-kit-0.5.0-d0f46931f56b.zip`
with its adjacent sidecar; it is not a published Engine release. The installed
kit's 63 distributed file checksums passed. For an authorized kit selection,
verify and run setup from the Git root:

```powershell
Get-FileHash .\engine\artifacts\multiplayer-game-developer-kit-0.5.0-d0f46931f56b.zip -Algorithm SHA256
npm run setup -- --archive .\engine\artifacts\multiplayer-game-developer-kit-0.5.0-d0f46931f56b.zip
node .\engine\kits\0.5.0-d0f46931f56b\tools\checksums.mjs
```

Use `--upgrade` only when intentionally replacing a different selected kit,
after preserving drafts and local data. `tools\bootstrap.mjs` first runs
`tools\setup.mjs`, which verifies the adjacent
sidecar and distributed kit checksums, installs the pinned package tarballs,
and links `games\sample\node_modules` to the versioned dependency directory.
It then restores the supplied Astraeum database. Setup refuses a different kit
selection without explicit `--upgrade`; it also runs `npm ci` for Vite and its
pinned tooling, so a fresh install needs npm registry access. Do not run
`npm ci` directly in `games\sample\`; there is no root dependency install step.
The supplied starter manifest pins the shared 0.4.0 kit rather than the
0.5.0 kit in `developer-kit.lock.json`; `bootstrap` therefore cannot
complete its restore. Do not run bootstrap or restore until those pins match.

### Astraeum starter data and safe restore

`starter-data\astraeum\` is the curated local editor-data snapshot, generated
with SQLite `VACUUM INTO` from a read-only connection to the working database,
then filtered and compacted in the copied database. It contains the saved
starting-level metadata, 3 active levels, 5 active sections and their documents.
The project asset-import/catalog tables are retained; this captured database
has 0 imported assets, so no additional imported artwork bytes are required.
The built-in catalog and artwork remain in `games\astraeum-tower\` and are not
re-imported. The source SQLite had no Astraeum row in `projects`, so no saved
project name/author record was fabricated; project ID, model, start selection
and level document metadata are retained. The manifest includes the metadata
row count, per-file hashes, kit pin and source provenance;
`starter-data.sha256` is the canonical payload checksum:
`a4f53230f2c871818b938c7423f633745a0209b8a0b99fc67546af649620bf89`.

The supplied starter manifest names kit 0.4.0, archive SHA-256
`62b4b582eee4913277ac9729349f6620e316539ce9056a73bfb98f48aa0cb233` and
Engine revision `6cd1d52906da084a8c3bc92ca006cf1e6288b326`, not the selected
0.5.0 kit. Restore validation checks all three values and rejects this mismatch.
The different 0.5.0 snapshot described in the root README is not this payload.

On Studio base `544e204`, a read-only probe in a disposable checkout validated
all five captured section documents and initialized and stepped each of the
three captured levels with kit 0.5.0 at revision
`d0f46931f56b90298b3209010581a0ffd7f79561`. The starter SQLite bytes remained
unchanged. This is focused runtime evidence, not full editor, export or
server compatibility. The manifest's 0.4.0 pin records its actual capture;
the probe does not justify rewriting that provenance or bypassing restore's
pin check.

The package excludes other projects, soft-deleted levels, removed-section
archives, migration backup/diagnostic rows, the obsolete World workspace,
save receipts and unrelated recovery/diagnostic files. `VACUUM` runs after
filtering so deleted rows and their free pages are not carried into the
artifact. The source commit is
`83d9c92efe235d0ecc9d17761212f4401a83359a`; the capture records that its
working tree had uncommitted changes. This is data provenance, not a claim that
the current changes are committed or pushed.

For a fresh checkout, use kit-only `npm run setup -- --archive <pinned-zip>`
with the repository artifact. Do not run `bootstrap` or
`starter:restore` until the starter package matches the selected kit and has
been verified. Once compatible data is available, start Studio and choose
**Open Game > Astraeum Tower**; do not create a replacement game or re-import
the source game. `npm run starter:restore` restores data only; it is not the
Engine complete-game package importer or a server deployment. These are
separate workflows and owners.

Restore refuses an existing `studio\data\studio.sqlite`, its WAL/SHM sidecars,
or colliding imported asset files. Save, stop Studio, then pass the explicit
`--replace-existing` choice to `bootstrap` or `starter:restore` only when
replacement is intended. Before touching targets, the restore creates a
consistent SQLite backup with `VACUUM INTO` and copies colliding assets to
ignored `studio\data\starter-restore-backups\<timestamp>\`. Stop the service:
replacing a database while Studio is using it is not supported. Never delete
or merge these backups automatically.

Start Studio from the repository root:

```powershell
npm run studio:dev
```

Open `http://127.0.0.1:4173`. `studio\start.mjs` starts the Vite UI and the
loopback SQLite/API service together; the defaults are web port 4173 and API
port 4179. `STUDIO_WEB_PORT`, `STUDIO_API_PORT`, `STUDIO_DATABASE_PATH`, and
`STUDIO_GAMES_PATH` are supported for isolated runs; disposable storage paths
must remain inside `studio\data\`.

**Safe stop:** Save and confirm Saved, or preserve and verify the exact dirty
draft first, then Ctrl+C in the terminal that owns `npm run studio:dev`.
The launcher's SIGINT/SIGTERM handlers terminate its API and Vite children.
The toolbar Stop only disposes Play, not Studio. There is no separate npm
stop script. Do not start a second launcher on occupied ports or kill by
process name. Check ownership before terminating a specific PID.

Vite reloads editor HTML, CSS, and browser modules during development. The API
is a separate Node process: an authorized restart is needed after changing
`studio\server.mjs`, server-side helpers, API/database behavior, or relevant
environment variables, or kit/dependencies. **Before editing served files,
reloading a tab or restarting, preserve dirty drafts**; Vite reloads can also
lose them. The editor has a before-unload warning, not a durable autosave or
general draft-export UI. If Save fails, preserve the complete level payload,
identity, revisions and active/archive documents separately and verify it;
capture the visible error and coordinate a consistent SQLite backup. Do not
silently replay historical recovery requests or bypass revision checks.
Do not restart or stop processes you do not own. If ports are busy, identify the owning process
before changing ports or stopping it. For blank UI/API responses, check both
process logs, the configured ports and the browser console; for setup failures,
check Node/npm versions, the archive plus sidecar, the kit checksum output,
registry access, and whether an owned Vite process is holding native files.

## 2. Building in Web Studio

Use the [Studio user guide](../README.md) for click-by-click instructions and
the quick "How do I...?" index. The following retains detailed editor/storage
invariants and limitations for developers; update both surfaces coherently
when a behavior changes, rather than copying old milestone prose into new help.

- **New Game** creates an independent Generic Grid v1 project with author and
  credits, two safe starts, and a fixed 2048 × 2048 world. Existing saved maps
  retain their saved dimensions. **Open Game** lists one entry per saved
  project ID and opens its designated starting level; use **Levels** for other
  levels. The initial Astraeum Floor 1 is a separate existing project; New
  Game does not copy it.
- **Current level** switches levels in the selected project. The compact
  **Level** menu contains **Add Level**, Duplicate, Rename,
  Set as start and Delete. **Add Level** creates a separate level with exactly
  one blank 2048 × 2048 section through a model-specific empty-document factory:
  no cobblestone, objects or player starts are generated or copied. The
  project's starting level and existing levels stay unchanged. Duplicate
  remains a copy of the saved source design. Place the Aries start (Astraeum)
  or both player starts (Generic Grid) explicitly before Play; empty drafts can
  be saved and Play reports missing starts.
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
  follows the remaining section union.   If the original section is removed, the remaining section(s) use connected
  Play; Generic remains movement-only and Astraeum retains its combat and
  lighting. The original document remains the level's boundary owner in the archive.
- Place items from the model-specific palette. **Import Assets** accepts PNG
  images and PixelLab ZIP exports into that project's asset catalog. Imported
  art preserves source bytes and credits and is visual-only: it does not gain
  animation, collision, AI or behavior automatically.
- The **Layers** panel controls design-layer visibility and locks; model/type
  draw ordering is fixed. The
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
  signed origins and its authored player start. Generic connected Play is
  movement, camera and collision only. Astraeum reuses its Tower combat, dodge,
  lighting, controls and generated decor. Both models render authored artwork
  across seams; Astraeum samples neighboring Wang occupancy. Authored stairs
  exits unlock after all active-section slimes are defeated (immediately with
  zero slimes); entering its activation area (strictly within 40 pixels)
  continues automatically, including when the last slime dies while on it.
  Arrival runes stay suppressed until the player leaves and re-enters.
  Configure its destination level and player start in the Inspector; no
  destination is assigned automatically. Doors remain decorative.
  Root-owned boundaries and holes remain enforced.
  Missing/ambiguous starts or public capacity errors fail explicitly, never
  play only one section. Stop restores pan, zoom, active section and selection.
  Existing single-section game modules/skins and control modes remain on their
  original path. See Section 5 for focused evidence and the blocked browser
  acceptance; no new editor features accompany this milestone.
- The labelled **Tool** dropdown contains **Select**, **Paint** and
  **Rectangle Fill**, and **Boundary**. Boundary supports grid selection or a
  closed polygon lasso, previews playable cells, and uses Apply/Reset/
  Escape-cancel through the existing history. Decorative fill borders remain
  independent. Paint continuously strokes explicitly brush-capable terrain,
  walls and static props; other assets remain click-place, and palette drag
  placement remains available.
  The Paint panel shows the explicitly selected asset's thumbnail and name,
  or asks you to choose one. Its **Brush size** selects **1 x 1**, **2 x 2**,
  **4 x 4** or **8 x 8** terrain cells (32, 64, 128 or 256 world pixels per
  side), without scaling artwork. **Density (%)** accepts whole percentages
  from **1–100**, default **100**; it controls candidate placement probability,
  never image size. **Minimum spacing** is a whole-world-pixel gap between
  **same-layer object footprints**, from **0–2048**, default **0**. Objects on
  other layers are unaffected, so floors do not prevent placing props.
  A grid-snapped cursor outline shows the brush's influence area;
  actual proposed placements show their artwork and full footprint.
  World-grid footprint anchors inside the influence area are candidates;
  large artwork can extend beyond the brush outline. Even-sized brushes
  extend one extra cell east/south of the pointer's cell-centered footprint.
  Green indicates a valid plan; red rejects the complete stroke for a
  locked/hidden target layer, missing section, invalid footprint or capacity.
  Fast strokes sweep every intervening cell, including across existing section
  seams. A stroke captures its size, density, spacing and stable seed on
  pointer-down and creates one Undo entry for all changed sections.
  Candidates use a fixed world-space lattice based on the configured asset
  footprint plus the gap (rounded up for forced 32px alignment). Revisited
  candidates never reroll or stack. Existing same-layer objects, including
  neighbors across seams, enforce the gap. Rejected
  strokes change nothing, rather than clipping the brush at a seam or bound.
  At 100% density and zero spacing, **Cobblestone floor** in Astraeum and
  **Plain tile** in Generic Grid use the original continuous-floor replacement
  path, including identical-cell no-ops and preserved replacement order.
  Catalogs explicitly opt assets into `paint: "terrain"` or `paint: "static"`;
  Fill's repeatable-asset eligibility still guards these capabilities.
  Built-in walls/blocks and static props opt in; imported assets opt in only
  when their category is **prop**, not **character** or **item**. Static copies
  retain dimensions, pivot, layer and collision defaults and append order as
  in Rectangle Fill. No artwork is scaled or resized. Unique/required objects,
  stairs portals, characters, spawns, items and collision boxes stay
  single-place even if a brush capability is incorrectly assigned.
  Unsupported assets remain visible with an explanation and disabled brush,
  density and spacing controls; single-click/palette-drag placement remains.
  A static slot whose footprint crosses a section seam or saved bounds is
  omitted and counted, like Rectangle Fill; objects never change
  owners, split or resize. The brush area itself must remain within existing
  saved bounds: missing/out-of-bounds brush cells reject the complete stroke,
  even at low density.
  Escape cancels without edits. Preview and commit use the same pure planner;
  publication uses the existing transactional multi-section history path.
  Paint remains an unsaved draft until Save.
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
  history. Rectangle Fill repeats static props (including barrels and imported
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

**Ownership, not missing gameplay:** Astraeum's tilemap adapter and lighting
are local game code, not installed Engine packs. Authored automatic stairs
transitions, Paint/Fill and boundaries are implemented; they are not a general
campaign/rules/import/publishing framework.

**Unfinished:** saved-campaign export acceptance, server upload/deployment, multiplayer,
collaborative editing, configurable match-rule authoring, PixelLab API
integration, physical-controller verification, procedural generation, audio
authoring and shared gameplay libraries. The sample's manifest/media exporter
is not a runnable-game/SQLite export. Protocol settings and Engine theme
installation contracts do not prove the Tower module consumes those settings
or is registered on a server. A successful local preview does not prove
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

### Source map

| Path | Responsibility / first reads |
| --- | --- |
| `studio\index.html`, `src\main.js`, `src\styles.css` | Actual controls, registered events, editor state, Save, Inspector and Play orchestration |
| `studio\server.mjs`, `project-*.js` | Loopback API, transactional SQLite/project/level/catalog ownership; validators dispatch by model |
| `studio\world-paint.js`, `world-fill.js`, `world-terrain.js`, `world-coordinates.js`, `playable-boundaries.js` | Shared editing planners, coordinates and boundary contracts; reuse rather than clone |
| `studio\extensions\connected-play.js` | Reusable experimental Studio integration of public connected worlds; composes Generic movement or Tower gameplay/skin, not installed Engine code |
| `studio\scripts\` | Focused runtime/planner/event/API tests and separately gated CDP browser harnesses |
| `studio\specs\001-map-editor\` | Milestone plans/tasks/history; dated evidence and current code outrank obsolete future-work wording |
| `games\astraeum-tower\src\` | Tower combat (`game.js`), UI/input (`skin.js`), design schema/factories (`project.js`), catalog, Wang renderer, tilemap adapter and lighting |
| `games\generic-grid-v1\src\` | Generic model/schema and movement-only adapter (`runtime.js`) |
| `games\sample\` | Editable public-kit consumer example; settings, module, map, skin and theme manifest; verify/build target this sample, not all Studio |
| `games\<project-id>\` | Generated identity/credits/adapter metadata and imported assets; never assume untracked directories are disposable |
| `reference\astraeum-tower-original\` | Supplied, untouched original source for comparison; currently local/untracked, not guaranteed in a fresh clone |
| `engine\developer-kit.lock.json`, `engine\README.md` | Tracked pin/provenance and installation boundary |
| `engine\kits\`, `engine\archives\` | Ignored immutable distributions, dependency installs, retained earlier kits and source archives; not source-edit targets |
| `tools\setup.mjs` | Checked kit extraction/checksums/dependency-junction setup/explicit upgrade |
| `tools\bootstrap.mjs`, `restore-astraeum-starter.mjs`, `package-astraeum-starter.mjs` | Explicit developer-data bootstrap, validated safe restore and curated snapshot packaging; not Engine game import |
| `exports\` | Ignored output location, not evidence of a successful campaign export |

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

### Storage and API contracts

The default server binds to loopback only. Read `studio\server.mjs` before API
work; browser controllers, API validators and model adapters must agree.
Projects use stable IDs; section identity and document identity are separate.

| Endpoint family | Use / invariant |
| --- | --- |
| `GET /api/projects`, `POST /api/projects` | List saved projects/maps; create an independent Generic game with credits, fixed dimensions and exclusive filesystem allocation |
| `/api/projects/{projectId}/levels` | List active/deleted levels and `startingMapId`; POST lifecycle actions (`add`, `duplicate`, `rename`, `start`, `delete`, `recover`) are transactional and project-scoped |
| `/api/projects/{projectId}/levels/{levelId}/sections` | Read/atomically PUT complete active/archive membership and documents, with level/section revisions and operation identity |
| `/api/projects/{projectId}/maps/{mapId}` | Legacy/single-map GET/PUT, including initial template Save; not a substitute for complete multi-section Save |

Saved format 2 documents reference catalog assets in an ordered flat object
array; artwork, pivots, collision defaults and behavior are catalog/model-owned.
Astraeum's optional `exit: { levelId, sectionId, startId }` is valid only on
canonical stairs objects. Do not create a second map authority in filesystem
JSON or rewrite a database from `floor1.json`.

Historical format/ownership migrations preserve original JSON/backups and
record failures. Unknown owners/models must not be guessed. Off-grid legacy
walls became flagged unresolved collisions rather than invented artwork;
explicit user resolution retains identity. Soft deletion does not erase
documents/assets/backups; project-level start references live in SQLite, not
the generated metadata's creation-time `mapIds`.

Preserve strict validation and optimistic conflicts. Surface HTTP status and
specific error, retain dirty drafts/history, and keep **Save failed - unsaved**
plus the alert visible until retry/open clears it. Uncertain writes reuse the
pending operation; do not generate success-shaped fallbacks or reset revisions.
For backups, use SQLite's consistent backup support or a coordinated clean
shutdown, not an arbitrary live `.sqlite` copy that ignores WAL.

### Source-game import and adaptation

**Implemented importer:** `studio\asset-import.js`, `project-assets.js` and
the Import Assets UI accept PNGs/static PixelLab ZIPs. They do not execute or
understand an arbitrary game's source, infer its gameplay, or import a full
campaign. Animated exports are rejected explicitly.

**Current source-game process is assistant-guided:**

1. Inspect the authorized ZIP/file inventory, source entry points, dependencies,
   license/credits, asset references and gameplay before extracting/porting.
   Preserve an untouched original under `reference\` and record original archive
   and asset hashes/source locations. Do not execute unknown archives blindly,
   overwrite existing game directories or assume a local reference is tracked.
2. Read the selected kit's public APIs, compatible sample/settings and the
   target game's current schema/module/skin. Identify supported behavior,
   adaptations and gaps explicitly before proposing new code.
3. Extract only authorized assets without transformations unless explicitly
   requested; retain source/artist credits and provenance. Astraeum's
   `assets\provenance.json` records PNGs decoded byte-for-byte from embedded
   data URIs in `reference\astraeum-tower-original\dungeon\index.html`.
   That reference is not a runtime dependency.
4. Implement game-owned behavior/rendering/schema in `games\<game>\`; reuse
   supported runtime APIs and Studio planners. Put a genuinely reusable
   experimental integration in `studio\extensions\`. Integrating a new model
   requires editor/API/catalog/schema/runtime dispatch together; dropping a
   source ZIP into `games\` does not register it or make New Game offer it.
5. Compare intended original behavior with the adaptation; record deliberate
   changes (for example Astraeum's all-slimes gate is not the original stairs
   rule), incomplete features and source/asset provenance. Verify with narrow
   tests and separately identified disposable Play/Stop/manual evidence.
6. Track reusable API gaps/contracts, tests and Engine handoff in
   [ENHANCEMENTS.md](ENHANCEMENTS.md). Record the compatible kit version,
   Engine revision and Studio Git state; do not call an adapted prototype an
   Engine API or promise multiplayer/export/server compatibility.

There is **no completed universal source-game ZIP extraction/import wizard**.
The supplied source game, one-player Tower encounter and supported asset ZIP
format are concrete examples, not evidence that arbitrary games port unchanged.
The Astraeum starter restore above installs existing local editor data; it does
not unpack an original source-game ZIP, register a different game model, or
import a complete Engine game package into a server. Keep source adaptation,
local saved-design restoration and server package import as separate tasks.

## 4. Claude reuse-first workflow

Before answering capability/workflow questions **or** writing custom code,
read the relevant guide and inspect the actual UI/call sites, module settings,
examples and installed public declarations. Help Anh find/use an existing
control before assuming she needs a new feature. Do not answer from a stale
task list or from general Engine knowledge.

Before writing custom code, inspect the installed public declarations, the
sample's supported settings, the target game's modules, and existing helpers.
Search actual imports/exports and call sites; do not infer an API from a package
name, a protocol schema, a README example from another kit version, or local
game code.

For this pin, start with:

- `engine\kits\0.5.0-d0f46931f56b\API.md` and the installed
  `@multiplayer-game\theme-sdk\dist\index.d.ts` and
  `@multiplayer-game\local-preview\dist\*.d.ts`.
- `engine\kits\0.5.0-d0f46931f56b\sample\src\settings.js`,
  `sample\src\game.js`, `sample\src\skin.js`, and `sample\theme.json`.
  The packaged `sample\src\connected-sections.js` and
  `sample\connected-sections.mjs` demonstrate the public world contract.
- The target game's `src\game.js`, `src\project.js`, `src\runtime.js`,
  `src\skin.js`, catalogs, and focused helper modules. For Studio capabilities,
  inspect `studio\src\main.js`, `studio\server.mjs`, and the relevant
  `studio\scripts\` test.

Resolve the installed declarations through
`games\sample\node_modules\@multiplayer-game\...`, whose junction targets the
receipt's `dependencyDirectory`, or inspect that exact directory directly.
Studio's Vite aliases select the same public package builds; never point them
at a private Engine checkout or a different kit as an undocumented shortcut.

| Public contract | What the consumer must implement |
| --- | --- |
| `GameModuleFactory` / `GameModuleInstance` (Theme SDK) | Validated module settings and input, initialize/applyInput/step/snapshot/results/dispose, stable metadata/state versions |
| `ModuleContext` (Theme SDK) | Consume public entity/geometry/navigation/random/clock services and optional connected-world starts; gameplay/authority policy is not supplied by an editor skin |
| `SkinFactory` / `SkinHost` (Theme SDK) | Compatible module/state metadata, mount/snapshot/events/render/viewport/dispose; use slots and `dispatchInput` for intent, not direct gameplay mutation |
| `createLocalGame` / `mountLocalPreview` (Local Preview) | Supply validated `map` **or** `world`, settings, seed, roster/viewer; drive the fixed tick timer, observe snapshots, handle rejected input and dispose game/mount |
| `@multiplayer-game/theme-sdk/package` | Node-only theme credits/manifest/assets/hash/digest validation; existing manifest/media exporter is not a game-code deployer |
| `@multiplayer-game/protocol` | JSON/wire/settings schemas; their existence does not install networking, lobby rules or Tower consumption of generic settings |

`createLocalGame` is in-memory local simulation at 30 Hz; `sendInput` can
reject an action. Completion requests are returned to the caller, not
production lobby finalization. Public roster/viewer types and per-account
Tower state are not evidence of implemented multiplayer.

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

### Assistant decision and handoff contract

| Finding | Required response/action |
| --- | --- |
| Supported now | Explain where it is (UI path or public export/module), exact options/ranges and limits; then reuse/configure it |
| Partly supported | Identify the supported part and missing behavior; extend the existing schema/controller/module and all relevant surfaces, not a parallel competing implementation |
| Missing, game-specific | Implement in the game project with explicit validated settings/schema and runtime consumption; preserve original imports/credits |
| Missing, reusable experiment | Prototype in `studio\extensions\`, compose public APIs, and record a proposed contract/options, ownership, tests and limitations in the enhancement register |
| Requires an Engine contract | Specify the missing public contract and separate Engine implementation/tests/kit handoff. Do not edit installed packages, import a private Engine checkout or silently bypass capacities |

No ineffective Inspector input: a configurable property requires document
validation/persistence, runtime consumption, tests and meaningful error behavior
together. Tower `towerEncounterTuning` values are read-only source constants,
not per-object settings. Sample `moveDistance`/`facingMovementBlend` and generic
protocol combat/NPC/wave defaults do not become Tower or lobby match rules by
being present in a package. Teams/rounds/win conditions need an explicit
game/module contract and a separately verified server integration.

For each change, report the actual API reused, files/owner, supported options,
evidence type, limitations, compatible kit and Git provenance. Distinguish
working-tree changes, local commits and confirmed remote commits. Never claim
an Engine promotion, push, deployment or server multiplayer result from a
local preview. Preserve unrelated edits/user data and dirty tabs before served
source edits, reloads or restarts; make Save failures visible and actionable.
Do not force a browser launch/restart loop or make an IDE debugger a prerequisite.

### Multiplayer game-rule discussion with Anh

During onboarding, Claude should discuss the intended rules with Anh **before
implementing gameplay changes**. Start with the supported options and evidence
below, explain the tradeoffs, recommend a coherent starting point, then let
Anh accept, change or reject it. Record her decisions and unresolved questions
in the authorized feature's handoff, not as assumed requirements. This
discussion does not authorize implementation, multiplayer delivery or T042
closure. Follow the [Git workflow](#git-workflow-and-handoff): descriptive
feature branches, preserved unrelated edits, and no unauthorized commit/push
or merge to `main`.

**Optional Dots and Squares baseline:** clear all enemies, advance together,
increase difficulty each level, respawn after a configurable delay, and show
player/team stats. Treat this as a design model supplied for discussion, not
as an inspected Dots and Squares implementation or a shipped Engine preset.
It is **not a requirement for Astraeum**; retain its existing rules and saved
designs unless Anh explicitly chooses a change.

| Decision to discuss | Tradeoff and suggested baseline for Anh to consider |
| --- | --- |
| Cooperative or competitive play? | Cooperation encourages shared goals; competition needs explicit teams, friendly-fire, winners and tie rules. Suggest cooperative PvE with no player-to-player damage. |
| Unlimited or limited lives? | Unlimited lives keep everyone involved but reduce failure pressure; limited personal/team lives create stakes but can leave players spectating. Suggest unlimited respawns; if limited lives are chosen, agree who spends a life and what happens when everyone is out. |
| Respawn delay and safe-spawn behavior? | Short delays reduce downtime but weaken death penalties; long delays can frustrate. Suggest a configurable 5-second delay, a visible countdown and an authored walkable start away from enemies/other players. Agree on any temporary protection and what happens if no safe start exists; never silently place a player in danger or outside the boundary. |
| Clear-map, timer, survival or another completion condition? | Clearing enemies gives an obvious shared goal but can stall on an unreachable enemy; timers create urgency, survival rewards endurance, and objectives allow exploration. Suggest clearing all required enemies across active sections; agree how unreachable enemies, a team wipe, the final level and simultaneous death/completion are handled. |
| Shared or individual level progression? | Shared progression keeps the group together; individual progression permits exploration but needs rules for split worlds and reunions. Suggest one shared level and a coordinated transition after clear, including players awaiting respawn; agree on readiness/exit activation and what carries over. |
| Scoring, rewards and HUD information? | Individual kill rewards encourage rivalry/last-hit competition; shared rewards encourage support. Suggest shared clear rewards, team score and informational per-player contributions. Agree on attribution, reward sharing, resets/carry-over and whether scores determine a winner. Show level, enemies remaining, team score, each player's HP/status and contribution stats, plus lives/countdown when applicable. |
| Player-start assignment and maximum players? | More players need enough distinct safe starts, legible HUD/camera behavior and capacity checks. Suggest a two-player target first, stable roster-to-authored-start assignment and explicit rejection when full; discuss join/rejoin and occupied-start behavior. This is a proposed target, not a supported Studio multiplayer mode. |

Taken together, the suggested baseline is a small cooperative party with
unlimited delayed respawns, shared clear-map progression, modest bounded
difficulty growth, shared rewards and visible personal/team feedback. It
prioritizes participation and understandable goals over elimination or
competitive balance. Ask Anh to choose the difficulty curve (enemy count,
health or behavior, and its cap) rather than silently applying protocol
defaults. Do not copy all of these rules into Astraeum merely because its
current rune already has an all-slimes gate.

#### Source-confirmed support, not multiplayer acceptance

For kit 0.3.0 / public packages 0.1.0 at Engine revision
`dca3ffc4561c14e0e83968afceabf0e85cddc565`, the following was inspected
read-only for this onboarding addition. Reinspect the selected pin and target
game before a later capability answer or implementation.

| Boundary | What is available / what remains to implement |
| --- | --- |
| Available public settings and helpers | Protocol `GameSettingsSchema` validates `maxPlayers` (integer 1-32, default 4), `respawnDelaySeconds` (0-60, default 5), NPC population/health growth and `maxLevels`; `calculateLevelDifficulty` and `validateMatchCapacity` calculate/check bounded difficulty. These are protocol contracts, not Studio controls or evidence that Tower consumes them. The sample consumes movement/control settings, not these match rules. |
| Available module/skin building blocks | Theme SDK `ModuleContext` exposes entities, geometry, clock, events and `requestCompletion({ kind: "level" \| "match", reason })`; modules own settings validation, step, snapshots and results, and skins own HUD rendering. Local Preview accepts a roster and returns completion requests to its caller. These support composing rules; they do not supply automatic team progression, respawn policy or server match finalization. |
| Existing game-specific behavior | Tower's `src\game.js` owns HP/combat, all-active-slimes exit gating, aggregate damage/kill counters and run inventory; `src\skin.js` renders its HUD. `studio\src\main.js` handles the authored local destination transition. Tower does not implement delayed respawn, lives, configurable difficulty growth, competitive rules or a shared multiplayer transition protocol. Its counters are not a complete per-player/team scoring system. Generic Grid and the kit sample remain movement examples. |
| Starts and actual preview roster | Public map/world validation and `connectedMapSpawns` supply authored/resolved positions; geometry can check walkability. Tower has game-owned initial/arrival safety checks, not a death-respawn system. `studio\extensions\connected-play.js`, Tower `src\main.js` and Generic `src\runtime.js` supply one-player rosters. Generic's two required starts and Tower's unused compatibility start do not prove two-player play or a maximum-player policy. |
| Missing ready-made capability versus Engine gap | The inspected public kit has no ready-made lives/team-rules or safe-respawn coordinator, nor a Studio lobby/rule-authoring UI. Start with game-owned policy composed from public contracts; this absence is not proof that a new Engine primitive is required. Networking, authoritative match coordination, admission/rejoin and synchronized progression need separately inspected server contracts and separate verification; the local-preview API supplies no network/session authority. Record an exact missing reusable contract in `ENHANCEMENTS.md` only when inspection establishes one. |

Evidence paths: selected kit `API.md`; installed
`games\sample\node_modules\@multiplayer-game\protocol\dist\settings.{d.ts,js}`,
`theme-sdk\dist\{index,maps}.d.ts` and `local-preview\dist\index.d.ts`;
`games\sample\src\{settings,game}.js`; Tower `src\{game,skin,main}.js`;
Generic `src\runtime.js`; and Studio `index.html`, `src\main.js` and
`extensions\connected-play.js`. These are **source/declaration findings**, not
new focused-test, browser or multiplayer acceptance results.

After Anh decides and implementation is separately authorized, use the
existing inspect/reuse/extend contract: configure a setting only where its
runtime actually consumes it; otherwise extend the owning game schema/module
and HUD with validation, persistence where intended, visible errors and
focused tests. Put genuinely reusable experiments in `studio\extensions\`
and document their Engine handoff, never patch installed packages or import
private Engine code. Report local simulation evidence separately from any
future multi-client/server evidence. This documentation pass changes no
runtime rules and requires no restart, browser suite, deployment or kit rebuild.

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

### Evidence labels and choosing commands

Use these labels in help, change notes and handoffs:

- **Confirmed implementation:** inspected current source/public contract, not
  necessarily executed in a native browser.
- **Focused-test evidence:** name command, fixture/data and assertions. Real
  public runtime with substituted DOM/Canvas/HTTP I/O is still not native UI
  acceptance. A listed command alone is not a pass.
- **Manual verification:** quote/scope the user's recorded observation; never
  broaden it to an untested restart, controller, feature or deployment.
- **Unfinished/unverified:** identify the remaining gate plainly; blocked
  startup is not acceptance, and local preview is not server multiplayer.

The latest recorded manual confirmations cover connected movement/camera/
collision, explicit-Save section edits and asset painting. Current automatic
rune entry/arrival/Stop evidence is focused disposable runtime/event coverage.
Earlier native-browser results apply only to their dated slices; the connected
browser acceptance gate is still open. Keep this distinction even when a
historical task checkbox says verified.

For code changes, choose the smallest relevant existing check and a
disposable **Play/Stop** path for affected behavior where authorized. Never
reload an unpreserved dirty tab or launch/retry blocked browser harnesses
just to refresh evidence. Documentation-only work needs link/command/source
checks, not a service, kit rebuild or browser suite.

| Root command | Actual scope / prerequisites | Existing evidence, not rerun by this documentation pass |
| --- | --- | --- |
| `npm run astraeum:combat:test` | Node Tower combat/tuning/input tests | Recorded pass |
| `npm run astraeum:progression:test` | Real public runtime: remote slimes, automatic entry/standing unlock, area latch, safe arrival, nonmutation | Recorded pass after automatic-entry change |
| `npm run astraeum:interactions:test` | Disposable public runtime: once-only pickups/chests, original loot ranges, both seam axes, level/section identity, revisits, decorative props and nonmutation | Passed for this implementation |
| `npm run studio:connected-play:test` | Both-model public-world seam/collision checks plus Tower skin/input/Canvas fixtures; no browser | Recorded pass |
| `npm run studio:apply:test` | Registered editor event/Play/Stop with substituted browser I/O; also starts its own disposable API for some cases | Passed; includes chest-tier Inspector draft change and shared Play transition-state lifecycle |
| `npm run studio:paint:test` | Planner and disposable SQLite/API Paint checks; test-owned restart/reopen | Recorded pass |
| `npm run studio:boundaries:test` | Boundary/grid/history/runtime checks | Recorded pass |
| `npm run studio:persistence:test` | Disposable API/SQLite migrations, projects/levels/sections/atomic saves/restart | Recorded pass; does not target user DB |
| `npm run studio:sections:test` | Alias of `studio:persistence:test`, not a separate browser suite | Same entry script |
| `npm run studio:runtime-sections:test` | Public geometry contract/regressions | Recorded pass |
| `npm run starter:test` | Isolated copies: mismatched pins, payload hashes, fresh restore with a matching test receipt, existing-data/sidecar refusal and explicit replacement backup | Earlier baseline handoff verification; changed fixture is not itself a compatible starter |
| `npm run studio:handoff:test` | Rejects mismatched starter/kit pins; otherwise requires a bootstrapped fresh checkout, reads its restored database and uses disposable ports/database/games | Earlier 0.4.0 handoff verification; not browser acceptance or a safe check against a user's saved database |
| `npm run studio:assets:test` | PNG/PixelLab import/API tests; requires authorized file via `STUDIO_GOPHER_ZIP` | Earlier asset evidence recorded; later invocation was blocked by missing ZIP, not a new pass |
| `npm run verify`, `npm run build` | Sample checks and sample Vite build, not a complete Studio/game acceptance or kit build | Recorded sample passes |
| `npm run studio:sections:smoke`, `npm run studio:levels:smoke`, `npm run studio:smoke`, `npm run studio:world:test` | CDP/browser harnesses, disposable storage/profile/services; inspect the script before any authorized launch | Historical segmented passes/failures below; current connected startup acceptance blocked. Legacy World flow targets retired UI |
| `npm run studio:wall-clear:smoke`, `npm run studio:map-settings:smoke` | Focused modes of the Levels CDP harness | Historical slice evidence below, not new passes |
| `npm run astraeum:smoke`, `npm run browser:smoke` | Tower/sample CDP scripts respectively; running preview and Chrome endpoint 9223 required | Historical evidence only; not a new browser pass |

From `package.json` and each entry script, the focused commands below exist.
This list is a selector, **not an instruction to run every check**:

```powershell
npm run studio:boundaries:test
npm run studio:apply:test
npm run studio:paint:test
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
npm run astraeum:progression:test
npm run astraeum:interactions:test
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

### Paint density and footprint spacing (2026-11-17)

Paint now reuses Fill's static-asset eligibility and the models' existing
object factories, footprint/pivot/ownership rules, terrain replacement,
pointer rasterization and transactional document-set history. Explicit
catalog capabilities gate static repetition, including imported prop artwork;
characters, spawns and gameplay objects retain single placement. Fill,
Boundary, section management and Play behavior are unchanged.

**User's manual confirmation:** asset painting works as desired. This is
separate from the automated checks and is not automated browser verification.

**Logic/event verification:** `npm run studio:paint:test`,
`npm run studio:apply:test` and `node studio\scripts\world-terrain-test.mjs`
passed. Coverage includes exact old/new 100% floor documents, deterministic
sparse candidates and retracing, non-32px footprints, same-layer spacing
across seams, required/optional collision defaults, capacity rejection,
actual registered settings/pointer events, preview/commit document equality,
locks, Escape, one-action Undo/Redo (also after Save), and draft-only behavior.
The Paint test uses a disposable SQLite API service for atomic multi-section
Save and restart/reopen; evidence stays under `studio\data\paint-check-*`.

**Native-browser verification:** not run. No blocked browser harness was
launched; event/render-command fixtures are not native visual acceptance.
User data, recovery, backups and unrelated edits were preserved. Changes
were reviewed for a local commit; no push, deployment or kit rebuild occurred.
T042 stays open.

### Connected Astraeum combat and rendering (2026-11-17)

Connected Astraeum Play now passes the selected Player Settings control mode to
the existing Tower skin, which reuses the existing combat module, camera,
lighting, combat effects and section-aware world renderer. Generic connected
Play remains movement-only. The stairs rune is drawn and emits its steady violet
light; generated doors are rendered, but door interaction, portal activation and
floor exit are not implemented.

**Focused executable checks passed:** `node studio\scripts\connected-play-test.mjs`,
`node studio\scripts\editor-apply-test.mjs`, and
`node games\astraeum-tower\scripts\combat-test.mjs`. The connected runtime test
covers both models' east/west and north/south seam crossings, continuous camera,
section blockers and outer/custom boundaries; Tower slime contact damage,
Halberd damage/defeat, visible attack rendering, generated door/rune rendering,
and keyboard-only, keyboard/mouse and synthetic standard-gamepad input. The
editor event test starts Play in all three selected modes and verifies the mode
reaches `connectedSkin`; Play/Stop preserves unsaved documents, saved baselines,
history and editor view. These are source/runtime and Canvas-command fixtures,
not native-browser visual acceptance. The separate assets import test could not
start because `STUDIO_GOPHER_ZIP` was not supplied; Tower rendering is covered
by the focused renderer test above. Physical-controller and browser testing
remain unverified. No browser harness, Studio restart, user-data modification,
kit rebuild, commit, push or deployment was performed. T042 remains open.

### Astraeum authored level progression (2026-11-17)

**Original inspected read-only:** `reference\astraeum-tower-original\dungeon\index.html`
parses `>` into `L.stairs` at line 825, draws the violet rune at lines
2197-2198, and handles **E**, ignoring key repeats, at lines 2554-2563.
`interact()` at lines 1364-1372 calls `nextFloor()` only within 40 pixels of
`(stairs.x, stairs.y + 8)`. `nextFloor()` at lines 1387-1391 guards the last
floor and advances with at least 40 HP; it does **not** check ordinary
enemies. Boss defeat has a separate delayed portal-opening path
(`killEnemy`, `openBossPortals`, and the `portalT` update at lines
1487-1513 and 1860); it is not an all-slimes gate. The generated door is
drawn by `buildGround` at line 976 and is not the stairs interaction target.
The source template has the equivalent stairs/interaction path.
Thus the exit is the **stairs portal represented by the violet rune**, not
the decorative door. The all-authored-slimes rule below is explicitly an
adaptation, not a reconstruction of original enemy gating.

**Authoring and validation:** the selectable `prop-stairs-rune` object has an
optional `exit: { levelId, sectionId, startId }`. Only explicit Inspector
changes add these fields. Choosing a level clears the previous start without
choosing a replacement. The level dropdown excludes deleted/unsupported levels
and is scoped to the current game. Its start dropdown lists active authored
Aries starts with section names, IDs and local positions. The existing Tower
contract still requires exactly one Aries start across the active level; this
selection identifies that start explicitly rather than adding alternate-start
semantics. Missing/deleted/inactive references, missing floor, boundary holes,
collision overlap (including small prop colliders), slime contact overlap,
ambiguous starts and public capacity errors are reported. Arrival never falls
back to an open tile or the unused compatibility spawn.

**Runtime and state policy:** the existing combat module counts living
authored slimes across every active section. Archived sections are excluded.
Zero slimes unlocks immediately. Entering an unlocked rune's activation area
(strictly within 40 pixels) automatically requests the nearest exit, with
stable-ID tie breaking. If the last slime dies while the player is already
inside, it activates then. There is no Interact input. Each attempt latches
all overlapping rune areas until the player leaves them, so failures retain
the source runtime and visible error without retrying every tick. Leave and
re-enter to retry, or Stop to repair the destination. Arrival areas are latched
before the first simulation step, preventing bounce loops even in zero-slime
levels. Destination membership/deletion and exact arrival are checked again
at activation, not trusted from the Inspector.

Between levels, preserve **HP, stamina and facing** exactly at the boundary;
max HP and combat tuning remain the existing fixed values. Do not apply the
original minimum-40-HP heal, refill stamina, or save progress. Reset movement,
aim to the carried facing, attack/dodge/knockback, cooldowns, invulnerability,
regen delay, animation, effects, simulation tick and encounter counters.
Every entry creates a fresh encounter from its authored documents, including
on revisits (enemies do not stay dead). At this progression milestone,
pickups and loot were not yet implemented; see the current interaction policy
below.

Studio uses only public `createLocalGame({ world })`, snapshots, `sendInput`,
`step`, `mountLocalPreview` and disposal. A destination is a different level,
not a continuous section crossing: validate/create its complete active world,
then dispose the old mount/game and mount the destination's Tower skin with
its root camera zoom, world bounds and rebuilt environmental lights. Preserve
the original draft and editor view separately throughout. The original level
uses the captured unsaved editor documents on revisits; other levels load
their saved complete active set. Held keyboard input is cleared/repeats ignored;
the controller must return to neutral after transition before input re-arms.
HUD shows remaining slimes and locked/unlocked exit status (or no authored exit).
The nearby prompt says **Defeat N remaining slimes** while locked and **Enter
the rune to continue** when unlocked, or shows the specific transition error.
Stop, also during an in-flight load, restores the original editor section,
selection, pan/zoom, history, saved baselines and unsaved draft, with no writes.

The public kit has the required support; no Engine API gap or private access
was needed. Studio owns current-game level resolution and host orchestration.
The standalone first-floor encounter has no Studio game/level catalog; it
explicitly reports that routing requires Studio rather than silently dropping
an exit request or assigning template destinations.

**Focused disposable verification:** `npm run astraeum:progression:test`,
`npm run astraeum:combat:test`, `npm run studio:connected-play:test`,
`npm run studio:apply:test` and `npm run studio:persistence:test` cover locked
activation, remote-section locks, final kill while on the rune, zero enemies,
automatic entry, one request per entry, arrival suppression/re-arming,
destination/start validation, safe exact arrival, carry/reset policy, complete
section loading, destination camera/lighting, explicit Inspector changes,
cancelled loads, unchanged draft/view/history and zero gameplay saves.
Persistence uses only test-owned SQLite/game directories, including explicit
exit-reference round-trip after service restart and unchanged legacy map bytes.
Runtime/event/Canvas-command fixtures are not native-browser visual acceptance.
No browser harness, regular-server restart, kit rebuild, deployment, commit or
push is part of this work. Existing user maps, backups, unrelated edits and the
read-only original are preserved; **T042 remains open**.

### Astraeum collectible and chest interactions (current implementation)

**Original source inspected read-only:** `reference\astraeum-tower-original\dungeon\index.html`.
Herbs, mushrooms and gems auto-collect once by proximity. Herbs add one
inventory item; **H** uses one for up to 30 HP and consumes none at full HP
(original `useHerb`, lines 1355-1362; confirmed in the original test log).
Gems are amethyst, sapphire, ruby, emerald and mana crystal; mushrooms have no
use effect in this Studio slice. The original **E** input opens a closed chest
strictly within 46 px (lines 1364-1385); Studio instead opens it automatically
once when a player approaches within that radius. Normal chests spill 2-4
weighted items from herb (twice), mushroom, amethyst (twice), sapphire, ruby
and emerald. Big chests spill 4-6 from herb, sapphire, ruby, emerald, mana
crystal (twice) and amethyst. Floor 1 gold is rounded from
`12 * random(0.8, 1.3)`, or 2.5 times
that for big chests; totals are 10-16 and 24-39 respectively. The original
chest flag prevents reopening during that floor. Barrels, crates and pots
have collision/rendering only: the source defines no attack durability,
break routine or drops, so Studio keeps them decorative and Halberd attacks
do not create prop loot.

The Studio Inspector exposes only the source-backed **Normal/Treasure** chest
tier; new chests default to Normal. Its levels have no original floor index,
so chest gold uses the Floor 1 baseline rather than inventing floor scaling.
Loot spills as delayed, magnetized runtime pickups and enters the original
small item/gold counters; this is not a general inventory, shop or crafting
system. H/Y remain the healing-herb controls; no keyboard or controller chest
Interact binding is used.

**Play persistence is intentionally runtime-only:** collectible/chest IDs are
qualified by level map, section and object ID. Collection, opened-chest state,
remaining drops and inventory survive connected level transitions and
revisits within one Play run; Stop, failed Play teardown or a new Play discards
that run state. No object or saved design is changed during Play. This differs
from the original local-save checkpoint: its floor-entry baseline means a
mid-floor reload restarts that floor's object state, while a normal floor
transition carries inventory/gold. Studio does not write or emulate that
browser-local save; it keeps the run ledger in memory only.

**Focused evidence:** `npm run astraeum:interactions:test` passed disposable
public-runtime cases for pickup-once, full-health and healing use, normal and
treasure chest ranges, reopening, repeated attacks against decorative props,
both seam axes, same IDs across sections/levels, revisits and unchanged
documents. Its terminal instrumentation reproduced two chest candidate
scans per fixed tick and 2,400 probes during 1,200 ticks standing near an
already-open chest; after the fix it measured two scans on the opening tick
and zero thereafter. Across that run, one chest-opened event and one ledger
entry remained, snapshot growth peaked at 5,823 bytes, and the final 100
skin renders used a stable 33 Canvas operations each. `npm run studio:apply:test`
passed the registered chest-tier Inspector event and verified that it leaves
the saved baseline unchanged;
its connected Play/Stop fixture verifies one runtime ledger is reused across
level transitions and cleared on Stop. These are runtime/event fixtures, not
native-browser visual acceptance; no browser performance run was started for
this fix. The reduced scan count is not evidence that scanning caused the
reported browser frame drop; it measures operation counts only. No Engine API gap was identified; behavior
belongs to Astraeum's game module and Studio orchestration. Physical
controller hardware, multiplayer, server delivery and native-browser
acceptance remain unverified.

**Handoff invariant:** preserve this cached opened-chest rendering in
`games\astraeum-tower\src\skin.js`; do not restore the former per-frame Canvas
filter or temporary capture/diagnostic instrumentation. Preserve the existing
Tower combat, dodge, lighting, connected-level progression, rune destinations,
pickups, chest loot and runtime-only interaction ledger. Extend their current
game/module owners rather than recreating the game or replacing its saved data.
Use `npm run astraeum:interactions:test`,
`npm run astraeum:progression:test` and `npm run studio:connected-play:test`
as relevant focused checks; they do not prove browser visual or performance
acceptance.

### Chest frame-performance investigation

The isolated headless-Chrome run used the actual mounted Tower game and skin
with cloned default content and a synthetic nearby chest. Across no-chest,
movement, chest-nearby, opening, post-open and standing-nearby phases, RAF
intervals were about 33.3 ms at p50, 33.4–33.5 ms at p95 and at most 33.6 ms;
no interval exceeded 50 ms. Sampled CPU profiles were mostly idle, and the
captured Canvas, DOM, task and allocation metrics did not identify a
chest-specific hotspot. The fixture sampled RAF cadence, not the skin's
individual `render()` duration, and did not reproduce the reported severe
drop. Its post-open heap difference (+310 KB / 1,397 nodes) includes scene
setup differences and is not evidence of a retained-object leak; six loot
items remained at sampling time, so that phase is not described as settled.

A subsequent read-only, in-memory clone of the saved Floor 1 document
(3,225 authored objects and two chests) was prepared for the same comparison,
with all chests removed only in the baseline clone. The isolated browser page
did not become ready within its startup window, so that saved-floor attempt
produced no frame or CPU measurements. No saved design was written, no
hotspot was demonstrated, and no further game change is justified by this
evidence. The terminal scan-count result above remains separate and does not
establish or resolve the browser-performance report.

**Temporary live capture (retired):** the Astraeum Play view temporarily
offered a 30-second Start/Copy capture. It measured RAF intervals,
the mounted Tower skin's actual `render()` duration and interval, runtime
`step()` wall time and interval, ticks, long tasks and available heap. It
counted chest openings by the snapshot's unopened-to-opened state transition
and generated item/gold drops by their Tower snapshot IDs at the opening tick;
it separately recorded bounded `lastEvent` sequence changes and inventory
deltas. Totals remained accurate even if detailed event lists reached their cap.
The capture validated the loaded Astraeum runtime rather than a fixture object
count and reported the loaded level revision, active section and object counts,
per-section revisions, and whether Play included unsaved changes. It finalized
on Stop or successful level replacement, retaining partial results for Copy.
Long-task availability was explicit and heap data could be unavailable in Firefox.
The capture worked on the current Play design in memory, did not save
or alter it, and did not compare against a no-chest baseline or provide an
isolated CPU profile. The 3,225-object saved-floor browser attempt remains
unmeasured. This describes the investigation before the cached-image fix below.

This diagnostic update is uncommitted in Studio (base `83d9c92`); it uses
public local-preview and skin APIs from kit 0.3.0 / Engine
`dca3ffc4561c14e0e83968afceabf0e85cddc565` (package versions 0.1.0).
The user's Firefox baseline reports one chest opening, RAF p50 33 -> 867 ms
and skin-render p50 21 -> 41 ms; the supplied figures are user evidence,
not a newly reproduced run. The attachment itself was not accessible in the
assistant session. The current Studio driver uses one `step()` per interval
callback, not a catch-up accumulator.

**Historical bounded render-stage instrumentation (`render-stages-v1`, retired):**
after the user confirmed the draft was saved and authorized Vite-served edits,
the existing capture was extended without browser launches, service restarts
or an IDE debugger. The game-owned Tower skin exposed an optional local
`setRenderStageObserver` method (not a new Engine API); Studio attached it
only during a captured render and cleared it in `finally`. Both single and
connected Tower Play used this same skin. Stages were input/controller/camera,
background, chests, loot, actors/effects, camera diagnostic attributes,
lighting (including light construction), and HUD/diagnostic attributes.
The input stage also includes controller status DOM writes; diagnostic
attributes are therefore not all isolated in the explicitly named stages.
No Canvas filtering, DOM writes, gameplay, lighting or input was disabled.

Per-phase stage samples, snapshot observation wall time, and render-sample
bookkeeping wall time shared the 5,000-samples-per-metric limit and 30-second
capture lifecycle. Each summary included count, percentiles, maximum and
sampled total; dropped samples/events remained explicit. Bookkeeping samples
were per stage plus per whole render, not per frame. Stage duration excluded
its reporting callback; whole-render duration included the stage
instrumentation. Snapshot-observation timing included ledger/event inspection
but excluded storing that timing sample. Bookkeeping timing excluded storing
its own timing sample. Clock calls, wrapper/dispatch overhead and RAF sampling
were not fully isolated; no diagnostic-off control comparison was performed.

These were synchronous timings, not browser raster/compositor/GPU profiles.
Deferred work may occur outside the render call. Percentiles must not be
subtracted or summed to explain RAF gaps.
The opened-chest Canvas filter and repeated diagnostic DOM writes were
**unproven suspects** based on these measurements alone. The temporary capture
fixture, benchmark page, Studio wrappers and Tower `setRenderStageObserver`
hook have since been removed. The earlier capture checks were Node tests, not
Firefox timings or native-browser visual acceptance.

**Opened-chest Canvas filter (historical diagnosis):** the user's
Firefox capture localized the new synchronous cost to `actorsAndEffects`
(p50 0 -> 17 ms, p95 0 -> 22 ms; chests stage near zero; one opening; final
effects 0). Source inspection found balanced save/restore and no leaked
filter, shadow or compositing state; effects expire and are spliced, and no
actor/effect work persists after pickup. The only steady post-open drawing
difference is that every render draws the opened chest through
`ctx.filter = "brightness(0.5) saturate(0.6)"`; its cost is consistent with
being deferred into later actor draws. The measured case in `npm run astraeum:interactions:test` asserted no filtered
world-canvas `drawImage` in the last 100 post-open renders and failed before
the cached-image change (100 !== 0). A prepared fix applied the same filter
once to a cached per-region chest image and drew that without a filter (glow,
automatic opening and loot unchanged); it passed the interaction and
connected-play checks in an isolated copy before being applied below.

**Cached opened-chest rendering follow-up:** after the user confirmed the draft
was saved, the existing skin was edited in place to filter each chest asset's
artwork once on an offscreen Canvas per mounted skin. Opened chests reuse that
image without a world-Canvas filter; closed treasure glow and game-owned
opening, loot and revisit rules are unchanged. The earlier saved copy of the
skin was compared with the edited file to check that unrelated intervening
edits were retained. No standalone prepared patch was found in the workspace;
the change implements the documented approach above rather than claiming an
exact patch was applied. Focused runtime/Canvas checks cover save/restore,
cache reuse and expired effect removal: `npm run astraeum:interactions:test`,
`npm run astraeum:progression:test` and
`npm run studio:connected-play:test` passed at the time. These Node checks are
not browser pixel or performance evidence. The user subsequently confirmed the
cached-image before/after check in Firefox; this task did not rerun Firefox or
receive new numeric timings. Existing before/after evidence under
`studio\data\astraeum-chest-browser-performance-*` and
`studio\data\chest-measurement-prM7lg` was left unchanged. The temporary
capture panel, capture-only instrumentation, styles, handlers and test hooks
are now removed. Studio changes remain uncommitted at base `83d9c92`, using
kit 0.3.0 / Engine `dca3ffc4561c14e0e83968afceabf0e85cddc565` and public
packages 0.1.0.
T042 remains open.

### Astraeum Inspector discoverability and supported authoring

The actual selection path is canvas `hitTest` (or a hierarchy click) ->
`setSelection` -> `refreshChrome` -> `updateInspector`. Existing canonical
stairs objects already have `type: "prop"` and `assetId: "prop-stairs-rune"`;
the exit panel deliberately checks that asset ID, not an object's name,
artwork or broad prop type. The original panel gate was correct for these
objects. Its destination fields were buried after map dimensions, identity,
transforms, collision and gameplay notes, and selection retained the panel's
old scroll position. Behavior settings now lead the Inspector, with scroll
reset only when the selection identity changes. This source/event evidence
does not establish native-browser visual acceptance of a particular viewport.

**Usable settings:** existing and newly placed built-in stairs expose
**Destination level (this game)** and **Arrival player start (active section)**.
The controls edit only that object's optional `exit` reference. Save writes
the validated section documents; reopen installs the saved catalog/documents,
and Play's host consumes the reference to resolve and validate the destination.
Position remains editable for stairs, Aries starts and slime spawns; slime
presence is authored by placing/deleting spawns. Asset-defined optional
collision remains editable where supported. Control mode and level camera zoom
are existing **Player Settings**, not per-character properties.

**Read-only/unavailable:** Aries and slime Inspectors show fixed combat values
directly from `towerEncounterTuning`/`towerSettings`, labeled read-only and not
saved per object. Per-character HP, stamina, damage, movement, weapons, AI,
drops and abilities have no game-document/runtime authoring contract. Supporting
them would require schema validation, runtime consumption and tests together;
adding ineffective inputs is not a substitute. This is a Tower module/schema
capability gap, not evidence that the public Engine API is missing.

Generated doors have no authored object identity. Clicking visible door artwork
now shows a non-authoring decorative-door advisory (higher drawn authored
items/spawns/collisions retain selection priority); it cannot set a destination,
edit an individual door, or add history/document changes. Imported artwork,
including artwork categorized as a character or named like a door/rune, remains
visual-only and explicitly says so. No image/name-based conversion, destination
assignment or saved-map rewrite occurs.

**Focused verification:** `npm run studio:apply:test` dispatches registered
canvas pointer, hierarchy, palette and destination change events. It checks
existing/new rune visibility, selection scroll behavior, locked-layer
protection, fixed combat outputs, generated doors and non-converting imported
artwork. It drives the actual Save/fetch/install controllers through a
test-owned SQLite file, closes/reopens that file, reselects the saved rune,
then verifies real public-runtime Play consumes its destination and Stop
restores the draft without gameplay writes. HTTP/DOM I/O is substituted:
this is not native-browser layout acceptance or a new regular-server
persistence check. No browser, debugger prerequisite, service restart or kit
rebuild is required. User maps/backups stay untouched and T042 stays open.

### Rune destination Save investigation (2026-11-17)

The registered Inspector and Save events were exercised against a separately
started disposable API and SQLite database, not the user's editor or storage.
Choosing a normal level, saving, choosing its start and saving again sent two
atomic section PUTs; both returned 200 and the editor reached Saved. Reopening
preserved the exit and an unrelated camera edit. A real stale-revision PUT
returned 409, displayed its error, retained the draft and Undo/Redo, and did
not overwrite the concurrent save. This fixture does not establish what happened
in the user's live tab or prove native-browser acceptance.

One separate reproducible validation defect was found: a valid 121-character
level ID produces a 129-character legacy root section ID, which the API lists
as an arrival option but the exit validator rejected. Selecting that start
threw from the change handler before Save, without an editor error. Generated
root section IDs now accept the full valid level-ID range, and failed exit
changes report an error instead of throwing silently. The disposable editor/API
fixture saves and reopens that long reference. This edge case is not established
as the cause of the user's reported symptom.

The shared validator is used by the API as well as the editor. An already-running
API must eventually be restarted to accept newly supported long references;
no existing service was restarted and no live tab was reloaded. Preserve any
live draft before coordinating that separately. T042 remains open.

### Captured rune Save recovery and visible failures (2026-11-17)

The live HAR captured HTTP 400, `Object stairs-rune-33-19 has unknown fields:
exit.` The current API imports the same strict Tower validator as the editor;
its object-key whitelist already includes `exit`, restricts it to stairs and
requires exactly `levelId`, `sectionId`, and `startId`. The complete captured
document passes that validator. This demonstrates an older API validator
relative to current source, not missing current-source exit support. No API
or web listener was running when this recovery began, so the former process's
exact version/module state could not be inspected. No server schema or
validation rules were changed.

Before any served-file edit or service start, the exact 314,533-byte HAR
request body was preserved as
`C:\Users\Owner\Desktop\studio-save-recovery-astraeum-tower-floor-1-rev4.json`.
Its SHA-256 is
`e51f0acf403b35a464ef8bda57759484289ff32f7f297a3c36dfcbf8e03605d4`.
Parsing and full-document validation confirmed level revision 4, section
revision 4, all 1,999 objects and the rune's explicit destination/start.
Pre-edit source copies and a consistent SQLite backup are retained under
`C:\code\studio-rb\save-exit-20261117\`; prior backups were not modified.

Save failures now retain a visible alert with the specific error and HTTP
status, and the toolbar says **Save failed - unsaved** rather than only
Unsaved. Unrelated UI refreshes cannot hide the alert. A new Save attempt or
opening another design clears it; drafts, history, revision checks and the
existing same-operation retry policy remain unchanged.
`node studio\scripts\editor-apply-test.mjs` passed registered Save-event
checks for 400, 409, 503 and network failures, retained drafts/history,
visible errors and successful retry, alongside the existing exit Save/reopen
checks. These are event fixtures, not native-browser visual acceptance.

The complete HAR body was also submitted to a disposable database copied
from the external backup. Save and API restart/reopen preserved every
document and exit exactly. Unknown object/exit fields and exits on non-stairs
still returned 400; stale level and section revisions still returned 409
without changing stored data. Evidence, responses, SQLite and API logs remain
under `studio\data\exit-har-recovery-20261117\`.

For live recovery, only the API was started first, with Vite still stopped.
The live revision-4 baseline matched the capture; the only document difference
was the rune's exit. The unchanged captured request, including operation ID
and both revision checks, was submitted **once**, returning 200 and advancing
level and section to revision 5. GET and an independent SQLite read verified
all 1,999 objects and exact exit contents before normal web startup. Every
unrelated database row, backup and recovery record was compared with the
external backup and preserved. The normal Studio launcher was then started;
web/API returned 200 and the proxied reopen response still matched exactly.
Live before/Save/verified responses and recovery API logs remain beside the
external SQLite backup. The old browser tab was not driven or used for another
Save; reopen the saved level before further edits from a revision-4 tab.

No browser harness, kit rebuild, commit, push or deployment was performed.
Existing unrelated edits and user backups were preserved. **T042 remains open.**

### Rune proximity feedback and registered Play input (2026-11-17)

Revision 5's destination Save was already verified and was not recovered or
resubmitted. A new disposable editor fixture mounts the actual Tower skin,
dispatches the registered Play/Stop clicks and keyboard handlers, and runs the
public local runtime. Before the fix it completed combat, unlock, Interact,
destination validation/loading, arrival at authored feet `(2000,1048)`, and
exact Stop restoration. The failing assertion demonstrated missing nearby
feedback, not a broken destination save or loading rule.

The snapshot exposes the same nearest rune used by activation, with the
same signed section origins, strict `<40px` range and stable-ID tie break.
The original feedback fix displayed an Interact binding. That requirement
has since been replaced by automatic activation, described below. Within range
the skin now displays **Defeat N remaining slimes**, then **Enter the rune to
continue**, identically in all control modes. Missing configuration,
loading and the host's specific transition error appear in that same visible
prompt. Destination membership and safe arrival are still validated by the
existing loader.

`studio:apply:test` covers a surviving neighboring-section slime, final kill,
automatic proximity activation, rejected arrival with source retained,
visible error and successful retry, exact destination spawn, and Stop restoring
the original dirty neighbor, selection, pan/zoom, history and saved baselines
with zero gameplay writes. `studio:connected-play:test` covers keyboard/mouse
and controller prompts and missing configuration;
`astraeum:progression:test` retains focused runtime coverage. These are
event/runtime/Canvas-command fixtures with substituted browser I/O, not native
browser visual acceptance. No browser was started or tab explicitly reloaded;
no existing service restart, kit rebuild, commit or push was performed.
Existing edits remain preserved and **T042 remains open**.

### Automatic rune entry (2026-11-17)

The rune now activates automatically after all living authored slimes in the
active level are defeated, including an unlock while the player is already
standing on it. The game module owns the per-player area latch; `clear` input,
blur, controller changes and host transition notifications do not reset it.
An attempt latches every overlapping rune, so a failed load cannot repeatedly
request itself or a coincident rune. Leaving an area re-arms it. Destination
creation seeds the latch from the exact authored arrival, preventing immediate
return transitions without moving the spawn or changing saved designs.
Keyboard E and controller X/Square activation dispatch and binding prompts
were removed. No document schema, saved destination or combat rule changed.

Disposable `astraeum:progression:test`, `studio:connected-play:test` and
`studio:apply:test` passed automatic entry, remote-section slime gating, final
kill while already on the rune, duplicate suppression, visible failed arrival
without repeated requests, re-entry retry, exact safe arrival and arrival-rune
bounce prevention. The registered editor/real-skin input fixture also verifies
Stop restores the original unsaved draft, active section, selection, pan/zoom,
history and saved baselines, with zero gameplay writes. Browser I/O remains
substituted; these are not native-browser visual acceptance. No browser,
existing-service restart, kit rebuild, commit or push was performed. Existing
edits and saved user designs are preserved; **T042 remains open**.

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

### Git workflow and handoff

Before any change, inspect `git status --short --branch` and preserve unrelated
work. Make future development on a descriptive feature branch, never directly
on `main`; if already on the designated branch for that feature, continue it.
Do not switch branches or create a branch in a way that moves, stashes, or
mixes existing edits. Keep game-specific changes and reusable Studio
enhancements on separate branches where practical, with focused commits Scott
can review independently.

Version required game source and original/derived assets with source, author
and transformation provenance, subject to repository policy. Exclude local
databases, secrets, dependencies, installed kits, builds, diagnostics,
recovery files and unrelated reference copies. Review both staged and
unstaged changes and ignored user data before staging; never use broad staging
or discard unrelated work.

Push only when authorized. Do not merge into `main`; Scott owns integration
and Engine promotion. A handoff identifies the branch and commits, changed
behavior, tests and evidence, limitations, compatible kit version, and any
reusable Engine enhancement proposal. Distinguish working-tree edits, local
commits and commits confirmed on the remote.

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

### Compatibility and Git provenance

`engine\developer-kit.lock.json` is the authoritative selected-kit receipt.
The selected kit 0.5.0 uses Theme SDK 0.3.0 and Protocol/Local Preview 0.1.0
at Engine `d0f46931f56b90298b3209010581a0ffd7f79561` (source state
`committed`) and archive SHA-256
`e8ce6ecea7da50db34610ee4c54e7a56480c57a1b2ac505dc5c73afb9370d2d1`.
It also records companion tooling revision
`scottzastrow/multiplayer-game-themes@778319f578b25081420e3334e1e68fa4de7540ec`
and reused-tooling provenance; do not imply those tools were rebuilt from a
currently available companion checkout. The kit version differs from its
package versions. The archive and sidecar are repository artifacts under
`engine\artifacts\`; their hash and all 63 installed-kit file checksums were
verified locally. This is not a published Engine release.

The supplied Astraeum starter manifest records source commit
`83d9c92efe235d0ecc9d17761212f4401a83359a`, the captured working-tree state,
kit 0.4.0/archive SHA-256
`62b4b582eee4913277ac9729349f6620e316539ce9056a73bfb98f48aa0cb233`
(Engine revision `6cd1d52906da084a8c3bc92ca006cf1e6288b326`), and
starter-data SHA-256
`a4f53230f2c871818b938c7423f633745a0209b8a0b99fc67546af649620bf89`.
This starter-data pin does not match the currently selected kit 0.5.0 artifact
or Engine revision. Restore validates the mismatch and must not be bypassed;
do not run bootstrap/restore until a compatible starter snapshot is supplied.
The source state is uncommitted at capture; do not imply this handoff is
published.

The current package test `npm run studio:game-package:test` passes against the
selected kit. A one-shot export-endpoint reproduction used a disposable
SQLite copy, not the live database. It returned HTTP 400 because active Level2
(`map-d8039084-4bab-4c2a-a320-d9083f4d8ed1`) has no authored stairs rune while
Level3 (`map-e6445ddd-518f-4399-874b-12064efce066`) remains active. A separate
fixture permutes level-list order and confirms ordering follows explicit exits.
No saved-campaign ZIP was produced; its ZIP hash, Engine import, multiplayer,
and browser acceptance are therefore unavailable. The specific authoring
decision is whether to add a rune in Level2 targeting Level3's active Aries
start (`spawn-aries-1` in
`section-map-e6445ddd-518f-4399-874b-12064efce066`); Studio does not author
that exit automatically. No level or live data was changed.

Read-only inspection commands, from the Git root:

```powershell
git rev-parse --show-toplevel
git rev-parse HEAD
git status --short --ignored
git log -5 --oneline
Get-Content .\engine\developer-kit.lock.json
```

The documentation audit observed local HEAD `83d9c92` (asset painting density
and spacing), preceded by `90e5574` (explicit-Save sections), `55fd2e8`
(connected editor/Play) and `488a5ad` (kit 0.3.0 pin). Combat/progression/
Inspector/recovery edits and these onboarding changes were present as
uncommitted work; this is a dated observation, not a claim that HEAD contains
them or that any commit is pushed. Re-read Git state for each delivery.
Do not invent a Studio or Engine commit ID for working-tree changes.

## 7. Promotion into Engine

The promotion cycle is: **Anh develops** a game-specific feature or reusable
Studio prototype → **Scott reviews** reusable enhancements → **Scott implements**
approved reusable APIs in Engine → **Scott releases** a versioned kit and
updates Studio's pin → affected games are explicitly migrated to the public
API. Game-specific behavior can remain in its game project; it does not need
Engine promotion.

1. Prototype the capability in `studio\extensions\` or the owning game and
   record the API gap and evidence in `studio\docs\ENHANCEMENTS.md`.
2. Scott reviews whether it is genuinely reusable, defines the public API and
   supported options, and implements/tests it in the Engine repository—not in
   this checkout's installed package.
3. Scott builds and verifies a new versioned kit in the Engine workflow,
   releases it, and records its version and Engine commit. Do not edit or
   rebuild the installed kit as a substitute.
4. Scott updates Studio's kit pin; then explicitly migrate each affected
   game. A kit upgrade does not overwrite or replace custom game code.
5. Compare saved settings, artwork, collision and gameplay behavior before
   retiring the prototype; mark the record migrated only after focused tests.

This repository contains the packaged kit and its pin, not the Engine source
checkout. A required Engine change must be tracked and implemented in that
separate owner; do not claim that a Studio-local module has been promoted.

For an Engine handoff, the enhancement entry must include the consumer use
case, currently available public API and exact missing contract, proposed
exports/options and validation/error semantics, state/ownership/capacity
invariants, focused tests and evidence, compatibility/credits constraints,
known limitations, and separate Studio/Engine Git provenance. Adoption is a
separate reviewed change: keep the old prototype until behavior/settings/
saved-design compatibility is checked, then record the shipped kit and
retirement/migration outcome. No installed-package patch is a promotion.

## Wednesday delivery checklist

Use this as a handoff/demo gate for Wednesday (target 2026-11-18), **not a
record that delivery or deployment has passed**. Do not mark items complete
without the specified evidence.

- [ ] Confirm Anh can find the root quick start and user guide's "How do I...?"
  index; obtain the authorized kit ZIP/sidecar for a new machine. Record the
  clean-machine limitation instead of claiming a fresh-clone trial.
- [ ] Record local Studio HEAD, dirty/staged files, actual selected kit/package
  versions, Engine revision, archive checksum and import/artist provenance.
  Separate local commits, uncommitted changes and verified remote state.
- [ ] Preserve every open dirty draft and verify recovery artifacts/backups
  before any authorized source update/reload/restart. Confirm Saved or keep the
  specific Save failure visible; do not repeat already-completed Save recovery.
- [ ] Prepare an explicitly disposable demo game/data set, not the user's saved
  map. Demonstrate Open Game, selected level versus start, section draft/Save,
  layer locks, selection, Paint sizes/density/spacing, Fill and boundary preview/
  cancel/Undo, imported artwork and independent gameplay camera zoom.
- [ ] With authorization, demonstrate Astraeum controls/combat, a remote-section
  slime keeping the rune locked, final-kill unlock while on it, automatic entry,
  exact destination arrival without bounce, visible failure without per-tick
  retry, deliberate leave/re-entry retry, and Stop restoring the original
  draft/view. Record focused/event, manual and native-browser evidence separately.
- [ ] Select only relevant focused checks from Section 5; record actual results
  and prerequisites. Keep blocked connected browser acceptance open; do not
  launch browser loops or require an IDE debugger for onboarding.
- [ ] Explain unfinished scope explicitly: source ZIP adaptation is
  assistant-guided; saved-campaign export acceptance, server upload, verified
  multiplayer, collaborative editing or configurable match-rule UI. A sample
  theme media ZIP and local preview are not a deployable complete game.
- [ ] Hand off game-specific/reusable changes with API contracts, test scope,
  limitations and promotion status in `ENHANCEMENTS.md`. Leave **T042 open**;
  no commit, push, deployment, service restart or kit rebuild is implied by
  documentation or checklist completion.
