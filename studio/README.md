# Web Studio map editor

## World workspace foundation

**Worlds** opens a workspace scoped to the current saved game. Create a world
with two new 2048 × 2048 sections; the second is immediately east of the
specified integer grid position. Existing levels are not added, resized or
relocated. Open an existing world from the same dialog. Each section retains
its own stable ID and local document; section borders and grid coordinates are
shown on one pan/zoom canvas.

Drag a visible, unlocked object within its section to move it. Middle-drag or
Space-drag pans; the wheel zooms. A move crossing the section boundary is
rejected. Undo/Redo applies to workspace moves, and Save writes both sections
in one revision-checked SQLite transaction. If a save response is lost, retry
the same save before closing; a conflict leaves edits open. Closing a dirty
workspace asks before discarding it. The independent level beneath the
workspace is not changed. Save, history and Close are unavailable during an
active drag.

This foundation does not include painting, fill or cross-section object moves.
Play is unavailable while a world workspace is open; use an independent
level for Play. Runtime section streaming and cross-section Play are not
implemented. `npm run studio:world:test` uses disposable storage and direct CDP,
retaining its evidence under `studio/data/`.

The 2026-11-14 disposable verification was segmented: API creation, validation,
rollback, revision checks, retry and restart passed before an opening timeout;
opening and movement passed in a continuation before a CDP wheel-event error;
zoom, pan and exact save/reopen passed in a further continuation. The full
smoke did not pass end-to-end. After the drag-action review fix, the
`--reuse-data world-workspace-yzWxps --pending-ui-only` continuation passed
with evidence in `studio/data/world-workspace-aA8MAL/`.

Run `npm run studio:dev` from the repository root, then open
`http://127.0.0.1:4173`. This starts the Studio Vite app and its map service;
the service binds only to `127.0.0.1`. The editor reads the existing Floor 1
template and artwork from `games/astraeum-tower/`, but does not modify that
game's launch command (`npm run astraeum:dev -- --port 5180 --strictPort`) or
the reference copy. The Studio's default database file is ignored at
`studio/data/studio.sqlite`.

## Project-aware persistence

SQLite is the authoritative store for saved designs. `games/` retains game
code, assets, and metadata; the checked-in Floor 1 JSON is an import template,
not the saved design. Map rows, backups, and migration history are scoped by
stable `(project_id, map_id)` pairs. The editor initially opens project
`astraeum-tower`, map `astraeum-tower-floor-1`; its document keeps the
existing map ID. **Open Game** lists saved project/map pairs and shows the
selected pair in the editor and Play toolbar. It asks to save, discard, or
cancel before switching away from unsaved changes; cancelling or a failed
load keeps the current design. Play and Stop use the selected document.
IDs are 1-128 lowercase ASCII letters, digits, or hyphens,
and must start and end with a letter or digit.

## Levels in the selected game

The **Levels** panel above Layers has a labelled **Current level** dropdown
showing the open level and marking the starting level with `(Start)`.
Choose a level with the pointer or native keyboard controls to open it;
dirty edits require Save and Open, Discard and Open, or Cancel. Cancelling
keeps the original level selected and its unsaved edits intact. The compact
action buttons target the open, selected level; switching and actions are
disabled during Play or an operation. Recovery stays in the separate
**Deleted levels (recover)** collapsible section.
**Add blank** uses the selected game's existing model and defaults: Generic
Grid and Astraeum default to 2048 x 2048 with safe starts; Astraeum keeps
uniform Floor 1-sized terrain and an Aries start, without Floor 1's walls,
props, enemies or layout. Project assets remain available, and Play uses the
existing model-specific settings and adapter.

On 2026-11-14, the user manually saved an edit, opened another game, and
returned to find the edit persisted. This did not verify a refresh or restart.
The pending Levels smoke helper opens the game's designated start through
**Open Game**, then selects a different requested level through **Levels**;
its assertions and timeout limits are unchanged.

Automated Levels acceptance remains unverified: attempts in
`studio/data/levels-smoke-ZTQqYn/` and `studio/data/levels-smoke-0Yb2hw/`
timed out during startup before acceptance checks. A subsequent diagnostic in
`studio/data/startup-levels-oCi2Ct/` failed during fixture preparation; the
startup-only continuation in `studio/data/startup-levels-NPIAbV/` reached
readiness but recorded no acceptance checks. T042 remains open.

## Map dimensions and gameplay camera

The Inspector's **Map Width** and **Map Height** controls explicitly expand
the current level in 32-pixel increments, from its current dimensions up to
2048 x 2048, matching the installed public runtime's map contract. Applying an
expansion is one undoable edit; existing objects, spawn positions, artwork and
collision shapes keep their exact values. Newly added space has no authored
objects or terrain. Existing maps are not resized on open; saving an explicit
edit persists the new bounds in the authoritative SQLite document. Contraction
is deferred; author smaller playable areas with walls or borders inside the map.

Player Settings exposes **Gameplay camera zoom**, from 0.5x through 2.0x in
0.1x steps, defaulting to 1.0x. It is saved in the current level document with
Save/Ctrl+S and is independent of the editor's pan and zoom. Larger values show
less world with larger artwork; smaller values show more. Play follows the
player, clamps to map edges, and centers a world smaller than the visible
world-area without automatically scaling it to fit. Viewport size and device
pixel ratio do not change authored artwork size, and pixel smoothing remains
disabled. The saved dimensions drive editor bounds and placement, runtime bounds,
collision grids and camera clamping for both models.

**Duplicate** copies the saved design into a new stable map ID; subsequent
edits are independent. **Rename** preserves identity. Add, duplicate, rename
and delete protect dirty edits with save/discard/cancel; discard is applied
only after a successful operation. **Set as start** changes the game's saved
starting-level reference without switching or discarding edits. Play previews
the selected level, not necessarily the start. No automatic transitions exist.

**Delete** always asks for confirmation, refuses the last active level, and
requires an explicit active replacement from the same game when deleting the
start. **Deleted levels (recover)** restores the original map ID and saved
design, without changing the current start. Deletion sets `maps.deleted_at`;
it never removes map JSON, assets, migration history or backups. Deleted maps
cannot be opened, saved over or chosen as start until recovered.

The transactional schema upgrade adds the nullable deletion timestamp and
`project_levels` starting-map reference, leaving existing project rows,
document bytes, timestamps and migration backups untouched. Existing games
start at their lowest map ID, except the known Astraeum Floor 1 takes
precedence. Unsupported legacy records stay untouched and non-openable.
SQLite, not generated `project.json`, owns the current level list and start;
the generated `mapIds` field is only the creation-time receipt.

`npm run studio:levels:smoke` launches disposable storage, Vite and Chrome
with direct CDP (no IDE-debugger prerequisite). It exercises actual controls
for blank levels in both models, independent duplication, renaming, choosing
start, save/reopen after service/page restart, dirty save/discard/cancel,
confirmed delete/recover, project isolation and selected-level Play/Stop.
Generic spawn transforms are the tile's top-left corner; Play reports the
radius-8 player's center, offset by half the 32-pixel cell on both axes.
The smoke asserts that exact centered position, not the authored tile origin.
`npm run studio:map-settings:smoke` uses the same disposable direct-CDP setup
to verify existing-map dimensions remain unchanged until explicit expansion,
undo/redo, empty added space, extended placement and collision, save/reopen,
2048 x 2048 defaults, saved camera zoom, multiple Play viewport sizes, lighting
alignment and independent editor zoom.
For focused dropdown coverage without the broad restart/isolation workflow,
run `npm run studio:levels:smoke -- --dropdown-only`. It checks keyboard
selection, unsaved cancellation, selected-level action targeting, separate
recovery and Play/Stop disabled states using disposable direct CDP.
The draft-recovery and wall-clear smoke modes also compare wall artwork against
`reference/astraeum-tower-original/dungeon/index.html`. That original reference
is not tracked or supplied by a fresh checkout; those modes require an
authorized local copy and do not modify it.
`npm run studio:persistence:test` also covers API invariants and migration
backup preservation. These commands do not use the user's database or games.
Level transitions, generation, area-fill tools, audio and shared libraries
remain separate future work. T042 remains open.

## New Game

**New Game** sits beside Open Game. Enter the game name and author/credits,
choose the explicit **Generic Grid v1** model, and use its fixed 2048 x 2048
pixel world. New Game has no editable dimensions; the service rejects attempts
to create a different size. Existing saved maps keep their own dimensions and
remain editable through the explicit, undoable expansion workflow.
Names and credits must be nonblank, without control characters (64 and 128
characters maximum, respectively). Case/Unicode-normalized duplicate names
are rejected, not treated as an overwrite.

The generic starter is independent of Astraeum: a blank background and two
distinct, safe player starts (the public map contract requires two), with no
artwork, lighting, Tower collision rules or gameplay. Its own primitive
catalog contains tiles, blocks, markers, player starts and collision boxes.
Only that compatible catalog appears for generic games; there is no fallback
to Tower assets. `games/generic-grid-v1/src/project.js` owns the explicit
versioned model; `src/runtime.js` is its public-runtime movement adapter.
The model is not a game identity: every game and map receives a separate
stable ID, even when using the same model.

Creation inserts a `projects` row (name, author, model and creation timestamp)
and a map row in one SQLite transaction. The filesystem directory is an
exclusive UUID-suffixed allocation, never an overwritten existing directory.
`games/<project-id>/project.json` holds identity/credits/model/adapter metadata
and creation-time map IDs; `src/runtime.js` references the shared adapter and `assets/` is
initially empty. There are **no saved map copies** in these directories.
If creation fails, SQLite rolls back and the newly allocated directory is
removed. Save/discard/cancel protects the current dirty map before creation;
cancelling or a failed creation leaves the current document open.

Creation opens the new, already saved game. Palette placement, selection,
movement, Inspector, undo/redo, Save/Ctrl+S and Open Game all use its own model
and project/map pair. Play uses the current design (including unsaved edits)
and the generic adapter: Arrows/WASD move a radius-8 player at 4 pixels per
fixed tick, bounded by the map and explicit 32-pixel blockers. Blocked or
overlapping starts produce an actionable Play error. Stop disposes the
preview without saving movement. At the default 1.0x zoom, the generic Play
camera follows the active player at 1:1 world-to-CSS-pixel scale, clamped to
world bounds; smaller worlds stay centered without scaling. Pixel-art
smoothing is disabled, and Stop restores the editor's independent pan and zoom.

## Project-scoped asset importing

**Import Assets** accepts individual PNG files and PixelLab ZIP exports. ZIP
metadata is authoritative: each declared static direction becomes a separate
palette asset; animation frames are not inferred or generated. The supplied
mutant-gopher export contains one `Idle` state with eight 48 x 48 directions
and no animation frames.

Preview images before import, then set the palette name, descriptive category,
author and source credits. PNG bytes and ZIP `metadata.json` bytes are kept
unchanged; SHA-256 hashes are recorded for every image, the metadata and the
source archive. Files live under `games/<project-id>/assets/`, while the
project-scoped SQLite catalog is authoritative. Different projects have
isolated catalogs. Identical images within a project are explicitly rejected
without partial files or records; existing files are never overwritten.
Image pixels map one-to-one to world pixels; placement does not scale or
rewrite image data. The supplied south-facing gopher PNG has a 48 x 48 source
canvas but transparent margins leave 34 x 37 opaque pixels (at x=7, y=5),
which can make the visible character look smaller than its placed bounds.
Palette thumbnails are scaled independently. At default zoom, Generic Grid v1
Play follows the active player at a 1:1 world-to-CSS-pixel scale; smaller worlds
are centered without scaling. Its camera zoom is saved with the level and is
independent of editor pan and zoom. Astraeum
Tower Play offers **Keyboard Only: WASD: Move · Arrow keys: Dodge · Space: Attack**,
Keyboard + Mouse (arrows, pointer aim, left-click attack, right-mouse-plus-
arrow dodge), and Game Controller (left/right sticks, right-trigger attack,
B/Circle-plus-direction dodge). It preserves the original 14-frame dodge,
34-stamina cost, six-frame cooldown and invulnerability. The selected mode's
bindings appear in Play; keyboard, mouse, and simulated standard-gamepad
checks run through Studio's disposable browser smoke. Physical-controller
testing remains pending. The Halberd uses its procedural attacks against the
authored Floor 1 slimes; the slime is a static procedural Canvas drawing, with
no added sprite frames. This is a one-player encounter, not multiplayer
support. Imported assets remain static artwork and do not acquire behavior
automatically.

Imports are limited to 16 MB ZIPs, 40 archive entries, 16 MB total uncompressed
data, 1 MB metadata, 4 MB per PNG, dimensions up to 2048 x 2048, and at most
32 images. Only PNG images and `metadata.json` are accepted in ZIPs. The
service rejects unsafe paths, special/encrypted/unsupported ZIP forms,
duplicate or unreferenced images, malformed PNGs, dimension mismatches, and
animated exports. Imported art is visual-only: character artwork does not
add collision, AI, combat, or animation. Imported assets appear in each
palette layout, can be placed/moved/undone, persist on save/reopen, and render
in Play. An image larger than the current map remains at its original size but
cannot be placed; the editor shows an invalid preview and explains that a
larger map is required rather than silently shrinking it.

`npm run studio:assets:test` tests original bytes and hashes, project
isolation, duplicate handling, and rejected archives. Set
`STUDIO_GOPHER_ZIP` to the supplied ZIP path before running this test or
`npm run studio:smoke`; the browser workflow verifies all eight directions,
zero animations, source alpha bounds, 48 x 48 world and editor CSS dimensions
at 100% zoom, Play's 1:1 scale, palette layouts, placement,
save/reopen, unchanged catalogs in a second project, and blocked placement for
an image too large for its map. Both checks use disposable data.
Game export and PixelLab API integration are separate milestones. No engine-kit
rebuild, publication or deployment is involved; T042 remains open.

## Local API

`GET /api/projects/{projectId}/levels` returns that game's active and deleted
levels and `startingMapId`. `POST` at the same path accepts `action`, `mapId`
and, for add/duplicate/rename, `name`. Actions are `add`, `duplicate`, `rename`,
`start`, `delete` and `recover`; deleting the start additionally requires
`replacementMapId`. Mutations and invariant checks share one SQLite write
transaction. Map IDs always resolve within the project in the URL.

The loopback API lists saved maps at `GET /api/projects` and uses `GET` and `PUT` at
`/api/projects/{projectId}/maps/{mapId}`. A PUT contains `projectId` and
`document`, plus the explicit model (`astraeum-floor-v2` or `generic-grid-v1`); the project ID and
document's `id` must match the path. Storage
uses the full pair, so an identical map ID in another project is a separate
record. Each model validates its own catalog, bounds and document format.
Only the Astraeum model uses the Tower runtime. A saved map/project cannot
change models through Save. Unknown models and invalid documents appear as
unsupported and cannot be opened or overwritten. A legacy untyped document
that validates as the Astraeum model can be explicitly assigned that model
from the dialog; the confirmation explains the Tower behavior before the
service records the choice. This only changes model metadata, not design JSON.
Untyped incompatible records and records explicitly marked as another model
cannot be assigned.

`POST /api/projects` accepts `{ name, author, width, height, model }`, requires
2048 x 2048 dimensions, and returns the new project/map identity, metadata and
document (HTTP 201). Validation errors are HTTP 400; duplicate names are HTTP
409. Generic saves must reference
an existing generic map, not create projects through PUT. Generated metadata
is a filesystem companion, not another editable design authority.

<details>
<summary>Historical project-storage migration</summary>

On startup, the service transactionally assigns the former unscoped Floor 1
row, its backups, and migration history to the Astraeum pair, preserving the
stored JSON, timestamps, backup IDs, references, and sequence numbers. It
then applies the existing format migration when needed. Existing scoped
databases gain a nullable model field transactionally; only the known Astraeum
Floor 1 pair is identified automatically. Other records retain their contents
and require the explicit confirmation above. If a legacy database
contains any other map identity, startup refuses to assign it to a project
and rolls back the schema change. Back up the database before manual recovery;
the service never guesses the owner of unknown legacy records.

</details>

`npm run studio:persistence:test` exercises migrations, legacy backups, failed
migration protection, ID validation, model isolation, fixed New Game and blank
level dimensions, rejection of custom-size creation requests, duplicate
rejection, metadata-only files, rollback cleanup after an injected database
failure and restart/reopen with disposable
databases/directories; it does not use the default database.

## Saved design (format 2)

The authoritative saved document is one versioned JSON object
(`formatVersion: 2`) holding a flat `objects` array. Each object has a stable
`id`, a `type` (`terrain-tile`, `wall`, `prop`, `item`, `spawn`, or
`collision`), an `assetId` into the asset catalog, an integer world-space
`transform` (the asset's pivot point), a `layer` and `order`, and an optional
`collision` override. Artwork references, sprite-sheet regions, sizes, pivots,
snapping, collision boxes, Play support, and credits live in
`games/astraeum-tower/src/catalog.js`; documents never duplicate artwork.
`games/astraeum-tower/src/project.js` validates documents and derives
everything else from them: draw order, hit-testing bounds, the wall grid,
runtime map collisions, spawns, and lights. Studio editing, selection, and Play
share one renderer (`design-render.js`), so hit-testing and drawing use the
same geometry. The original `src/floor1.json` is the import template, not a
second editable save.

Layers draw in a fixed order ? terrain, walls, props, items, character spawns,
collision boxes ? and objects keep their layer and order when moved.
Grid-aligned walls use the original dual-grid wall autotile; off-grid walls are
drawn with solid wall artwork over the unchanged floor tile beneath them.

<details>
<summary>Historical migration from format 1</summary>

Format 1 stored terrain rows plus a `walls` rectangle list. On startup the
service upgrades the stored Astraeum Floor 1 format 1 row inside a SQLite transaction and
first copies the original row byte-for-byte into `map_backups`; the outcome is
recorded in `migrations` and shown in the Inspector. Grid-aligned format 1
walls become walls with the same IDs. Off-grid format 1 walls were drawn with
floor art, so they are not relabelled as walls: they become collision boxes
with the same ID, position, and collision, flagged "migrated" with an
explanation. Overlapping walls are kept and reported. If a row cannot be
migrated, it is left untouched, the failure is recorded, and the API refuses
to read or overwrite it (HTTP 409) rather than silently discarding data.

</details>

### Unresolved Astraeum collisions

The Inspector's migration history is collapsed by default (failed migrations
expand their error details). Unresolved-collision warnings are separate and
stay visible and actionable.

Migrated off-grid boxes are labelled **Unresolved collision** (with a warning
glyph) in the hierarchy and Inspector, and the Inspector shows a count with
**Review next**. They are shown as pink dashed boxes with an X in Edit mode
only; Play never draws them, but they keep blocking movement until you act.
The Inspector explains their origin and offers three undoable actions:
**Assign artwork** (a wall keeps the identical position and collision; a prop
or item is centred on the box and the resulting collision change is stated
before you commit), **Keep as collision box** (an intentional invisible
blocker), or **Delete** (removes the collision). The ID is kept in every case.

## Editing

The left panel lists layers with visibility and lock toggles (terrain starts
locked: visible but not selectable) and a hierarchy grouped by layer. Hierarchy
groups start collapsed; their headings expand and collapse normally. The
bottom palette groups assets by type; drag a card onto the map to place it
with a live preview (green when valid, red with a reason when not), or click a
card to arm **Place** and click the map. Each card shows its artwork region,
credit, and Play status ? **In Play**, **Partial in Play**, or **Editor only**
for items and enemy spawns that are saved but have no gameplay yet. Click,
Shift-click, marquee drag or Ctrl+A select visible, unlocked objects. Move,
nudge, duplicate or delete a selection as one undoable edit; the Inspector
also offers shared offsets and compatible collision settings. Clear Level
Contents previews removal and locked/skipped counts by category. Missing
player starts can be saved as a draft, but Play requires restoring them.
Use the Inspector for exact coordinates and optional collision. Grid visibility
and snapping are independent; terrain
tiles always snap. Arrow keys nudge the selection five world pixels without
snapping. Middle-drag or Space-drag pans; the wheel and zoom buttons control
the view. Ctrl+Z / Ctrl+Y undo and redo; Ctrl+S saves to local SQLite.

The palette's **Large / Medium / Small / List** control switches between three
thumbnail sizes and a compact text list (type glyph, name, Play status). Names
stay readable and drag-to-place works in every view. The choice is stored in
this browser's `localStorage` (`web-studio.palette-view.v1`) and is never part
of the saved design.

## Play

**Play** validates the current design (including unsaved edits), shows a
loading overlay, makes the play view visible, and only then mounts the
installed public `@multiplayer-game/local-preview` runtime with the derived
map, so the canvas is sized to the viewport and focused for keyboard input.
Startup problems ? such as a wall on the Aries start ? are shown with an
explanation instead of failing silently. **Stop** (or Escape) disposes the
simulation and restores the unchanged design and the editing camera/zoom.
Previously Play mounted the runtime into a still-hidden container, which the
runtime measured as 1 ? 1 pixels, so pressing Play appeared to do nothing. This
milestone is a local, single-player editor and does not verify multiplayer.

Run `npm run studio:smoke` for the end-to-end browser workflow. It uses
uniquely named disposable SQLite databases and an isolated headless Chrome
profile, restarts the service before reopening, and removes only those
test-specific files. It also checks Open Game switching, unsaved-change
choices, isolated saves, restart/reopen, selected-map Play/Stop, unsupported
models, and explicit assignment of a compatible untyped map. The same browser
run creates two generic games through real controls, validates invalid and
duplicate inputs and cancellation, saves distinct maps via Save/Ctrl+S,
restarts/reopens them, moves in both generic previews and returns to Astraeum
without changing its design, timestamps or migration history.
The isolated two-game phase passed after fixing a hierarchy feedback loop:
initializing open empty groups queued `toggle` events that rebuilt the tree
and queued more events. Toggle handling now ignores unchanged or detached
groups, and empty groups need no lazy population. Regression checks cover
idle tree stability and collapsing/reopening an empty group.
Both checks use a disposable `STUDIO_GAMES_PATH` under `studio/data/`; only
test-specific files are removed. Production defaults to `games/`.
With `STUDIO_GOPHER_ZIP` set, the browser workflow also previews and imports
the supplied eight-direction static character, checks all palette layouts,
places and saves a direction, reopens it, renders it in Play, confirms
duplicate rejection, and confirms a separate project's catalog stays empty.
Later milestones: game export, multiplayer editing, dynamic-object motion,
item and enemy gameplay, generators, and PixelLab API integration.

<details>
<summary>Previous Astraeum verification result (before New Game)</summary>

`npm run studio:smoke` passed. It seeded a disposable format 1 database (384
walls, one off-grid), confirmed the browser migration notice, the
off-grid wall shown as a flagged collision box, and a byte-identical backup.
The box was labelled "Unresolved collision"; assigning wall artwork kept its
transform and collision, and keep and delete worked, each reverted by undo.
On a fresh database it dragged a wall and a barrel from the palette with
snapped previews, then moved the wall off-grid: only the wall moved, every
terrain tile was unchanged, the old cell showed floor again, and the barrel
still drew above the wall. It exercised snap on/off, the five-pixel nudge,
undo/redo, and the terrain lock; saved, restarted the service, and reopened the
identical design. The real Play button showed the loading state, a visible,
focused canvas, and 384 derived collisions; Aries stopped at `x=156` against
the wall at `x=165`. Stop restored the camera/zoom and left the design
unchanged, and a wall on the Aries start produced an actionable Play error.
The standalone Tower Play render is pixel-identical to the pre-change capture,
and `npm run astraeum:smoke` passed.

</details>
