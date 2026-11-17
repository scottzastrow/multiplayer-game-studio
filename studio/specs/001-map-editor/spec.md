# Studio Map Editor — Scoped Milestone

## Goal

Deliver the first local Web Studio map-editor workflow around the existing
Astraeum Tower Floor 1 adaptation. The editor lives in `studio/`; the editable
game remains in `games/astraeum-tower/`.

## In scope

- Unity-style top toolbar, hierarchy, central map viewport, Inspector, and
  bottom art palette using the existing Floor 1 map and credited artwork.
- Pan, zoom, optional grid, independent grid snapping, wall selection,
  placement, movement, deletion, and five-world-pixel arrow-key nudging.
- Undo/redo, dirty state, and save through a loopback-only local HTTP service
  into SQLite under ignored `data/`.
- One documented authoritative saved representation that can be reopened
  after restarting the service.
- Play the edited design through installed public runtime exports. Stop returns
  to the authored state and editing camera/zoom without persisting play state.
- Browser verification of a complete edit/save/reopen/play/collision/stop flow
  against a disposable database.
- Project-scoped SQLite persistence with validated stable IDs, including
  transactional migration of the existing Astraeum map and its backup history.
- Open Game lists each saved project once and opens its designated starting
  level; use Levels to switch to another level. Protect unsaved changes and
  use the selected document for Play/Stop. Require explicit consent before
  identifying an untyped compatible starting level as Astraeum.
- New Game beside Open Game: collect a nonblank game name (up to 64 characters),
  author/credits (up to 128), and explicit Generic Grid v1 model. New games
  have a fixed 2048 x 2048 pixel world; there are no editable dimension fields,
  and the service rejects requests to create another size.
- Allocate stable, independent project/map IDs and collision-safe directories.
  Reject case/Unicode-normalized duplicate names without overwriting existing
  projects. Commit project metadata and the map in one SQLite transaction;
  remove newly allocated files if creation fails.
- Keep saved maps exclusively in SQLite. Generated game directories hold only
  code, assets and project metadata, never independently editable map copies.
- Generic Grid v1 has its own versioned document, primitive asset catalog and
  runtime adapter: blank terrain, two safe player starts required by the public
  runtime, basic movement and explicit grid blockers. No Tower art, lighting,
  collision rules or gameplay. Identity and author are not template/model IDs.
- Save/discard/cancel protects dirty edits for creation as well as switching.
  Cancellation and failed creation preserve the current design; successful
  creation opens the saved project with placement, undo/redo, Save/Ctrl+S,
  Open Game and model-specific Play/Stop.
- Show only project-compatible assets. Collapse historical migration details
  by default; failed migration reports and unresolved-collision review/actions
  remain visible for Astraeum.
- Browser acceptance uses disposable database/files and real controls to
  create two generic games, edit/save different maps, restart/reopen, confirm
  isolation, move in Play/Stop for both and return to unchanged Astraeum.
  Cover invalid inputs, duplicate names and cancellation.
- Blank levels use a fixed 2048 x 2048 world. Existing levels keep their saved
  dimensions until the user explicitly applies an undoable expansion; resizing never moves
  or scales objects and leaves new space empty. This increment exposes expansion
  only; contraction is deferred.
- Derive editor bounds, placement limits, runtime bounds, collision grid and
  gameplay camera limits from the saved level dimensions. Keep editor zoom
  independent. Save a gameplay camera zoom setting (default 1.0) with the level;
  larger values zoom in, smaller values show more world, and the camera follows
  the player, clamps at map edges, and centers smaller worlds without fit scaling.
- Verify default dimensions, explicit expansion, placement in expanded space,
  save/reopen, gameplay movement/collision and camera behavior at multiple
  viewport sizes through disposable data and direct CDP.
- Astraeum Play presents Keyboard Only, Keyboard + Mouse, and Game Controller
  modes with mode-specific instructions. Translate device input to generic
  movement, aim, attack, and dodge actions; preserve analog stick magnitude,
  buffer brief attack/dodge presses, and clear queued input on Stop, blur,
  disconnect, and mode changes. UI controls must not drive gameplay.
- Preserve the original directional dodge curve, duration, stamina cost,
  cooldown, regeneration, and damage invulnerability. A held dodge cannot
  repeat until released/re-armed; controller dodge requires B/Circle and a
  non-neutral left stick, and mouse dodge requires right mouse plus an arrow.
- Verify all three modes through the actual Studio Play button using real
  keyboard/mouse events and simulated standard-gamepad input, including
  movement without dodge, short taps, held input, stamina/cooldown rejection,
  neutral stick, disconnect, blur, and visible Halberd attacks. Physical
  controller testing remains explicitly pending.

## Object model and placement correction

- Fix the reported wall bug: an off-grid wall left the derived wall grid, so its
  own cell rendered floor art while the wall was drawn with the cobblestone
  tile above props, and selection used a different rectangle from the visuals.
- Replace the wall-only document with format 2: terrain tiles, walls, props,
  items, and character spawns as distinct objects with stable IDs, catalog
  artwork references (sprite-sheet regions and credits), transforms,
  layer/order, and optional collision. Runtime collision is derived from it.
- Render and hit-test the same geometry. Moving keeps layer and order. Layers
  can be hidden or locked; the floor starts locked.
- Drag assets from a palette onto the map with a placement preview and
  optional snapping; click-to-place remains. Palette entries state whether the
  type works in Play; collision rectangles are never labelled as walls.
- Migrate stored format 1 rows explicitly and transactionally, keeping an
  untouched backup; unmappable off-grid walls become flagged collision boxes.
- Fix Play appearing to do nothing: mount the runtime only after the play view
  is visible, show loading and actionable startup errors, and restore the
  editing camera/zoom on Stop.
- Label migrated off-grid boxes "Unresolved collision" in the hierarchy and
  Inspector, explain their origin, and offer undoable assign-artwork, keep,
  and delete actions; collision is preserved until the user acts. Their
  diagnostic overlay is drawn in Edit mode only.
- Offer large, medium, and small thumbnail palette views plus a compact list,
  with drag-to-place in each; the choice is a local browser preference only.

## Explicitly out of scope

Level transitions, generation, tile painting, area fill, boundaries,
procedural scattering, audio and shared libraries remain separate future work.
The proposed world-workspace increment below scopes tile painting and
rectangular fill separately; it does not change this original milestone.

Multiplayer editing, collaboration, dynamic-object motion, generators,
PixelLab integration, engine-kit changes or rebuilds, publishing, deployment,
changes to `reference/`, arbitrary custom model loading or gameplay scripting.
Project-scoped PNG and PixelLab ZIP importing was delivered as a separate
subsequent milestone; this original milestone does not include its import UI
or implementation.

## Constraints

- Preserve the Astraeum Tower launch command, map, collision, lighting, artwork
  credits, sample project, and the reference source.
- Use only installed public runtime APIs; report a blocker instead of importing
  private engine modules.
- Keep all changes local and uncommitted; leave T042 open.
- Do not rewrite existing saved levels unless the user explicitly saves an edit.

## Scoped level-management increment

- Add a Levels panel to the current workbench, scoped strictly to the selected
  project/game. List/open active levels, add blank, duplicate with a new stable
  map ID and independent saved state, rename, and select the starting level.
- Blank levels use that game's existing supported model, project asset catalog
  and settings defaults, with 2048 x 2048 bounds and safe starts. Astraeum uses
  uniform floor and a safe Aries start, not Floor 1's authored layout. Play/Stop
  uses the selected level's existing adapter.
- Protect dirty edits on switch and before operations that replace the open
  document: save/discard/cancel, with no discard on a failed operation.
- Require one or more active levels and an active starting-level reference.
  Deleting the start requires explicitly choosing another valid active level
  in that same game. Confirm every delete and retain the saved design for
  recovery with the original ID. Reject opening/saving deleted levels until
  recovered; never alter another game's maps or asset catalog.
- SQLite remains authoritative for saved designs, current level membership
  and starting-level selection. Extend schemas transactionally without
  rewriting existing project rows, design bytes or migration backups/history.
  Generated metadata is a creation receipt, not a second map authority.
- Verify actual UI controls with disposable data and direct CDP, without
  requiring an IDE debugger: add in both models, duplicate, rename, choose
  start, protect dirty edits, save/reopen after restart, delete/recover,
  isolation and Play/Stop on the selected level. Run affected checks once and
  stop on failure. Preserve user edits/databases; no push, deployment, commit
  or kit rebuild. T042 stays open.

## Scoped multi-selection and bulk-edit increment

- Selecting with a normal click replaces the current selection; Shift-click
  toggles an object. Dragging from empty canvas creates a marquee, while
  middle-drag and Space-drag continue to pan.
- Ctrl+A works only while the editor canvas has focus and selects objects on
  visible, unlocked layers. Map and hierarchy selection stay synchronized;
  shortcuts do not edit the document while typing or during Play.
- Group drag, shared-offset edits, and 5-world-pixel arrow nudges preserve
  relative transforms, layer membership, and draw order. Grid snapping derives
  one shared displacement for the whole selection. Operations that would move
  any selected object outside the map are rejected atomically.
- Duplicate assigns fresh object IDs and preserves arrangement, layers, and
  draw order. Delete removes the complete selection. Group movement, nudging,
  duplication, deletion, bulk property edits, and content clearing each form
  one undo/redo action.
- The Inspector reports selection count and common properties; differing
  values are explicitly marked Mixed. It offers shared positional offsets and
  edits compatible common collision properties.
- Clear Level Contents offers terrain, walls, props, items, collision boxes,
  and spawns as separate categories. Before confirmation it reports affected
  and locked/skipped counts. Locked-layer content is never removed; hidden,
  unlocked content is eligible. Clearing is one undoable edit and preserves
  the level and its dimensions, settings, asset catalog, credits, and other
  levels.
- A level with cleared required player spawns remains a valid saveable draft.
  Play is blocked with an actionable message to restore a start or undo;
  Studio never creates replacement spawns silently.
- Verify actual controls through direct CDP against disposable data:
  marquee/Shift/Ctrl+A selection, locked and hidden exclusions, snapped group
  movement, 5-pixel nudging, invalid atomic movement, duplicate IDs, delete,
  undo/redo, save/reopen, clear-category counts and locks, and save/reopen plus
  Play rejection for a spawn-free draft. Retain actual-versus-expected
  evidence, run affected checks once and stop on failure; no debugger is
  required. Keep all work local and uncommitted, leave T042 open, and preserve
  pending map/camera and onboarding work.

## Prior World-workspace proposal (superseded)

The following section records the earlier separate-workspace design and its
historical verification only. The current editor surface is the unified
level-section implementation documented below; the standalone Worlds chooser
and canvas are no longer part of Studio.

The foundation supports two new adjacent sections, a shared canvas,
section-local object movement and transactional workspace persistence.
The terrain-brush increment adds continuous 32px world-cell strokes, including
negative coordinates and seam crossing, deduplicated drag rasterization,
replacement/no-op behavior, whole-stroke preflight, Escape cancellation and
one cross-section Undo/Redo. It reuses each model's catalog/object factory and
validator and the existing transactional two-section save endpoint. Terrain
visibility/lock controls share the editor's local layer preferences.
Rectangular fill shares those contracts and adds a snapped, counted preview
with explicit Apply/Cancel. Boundary editing is now implemented and covered by
focused tests; cross-section object moves and world Play remain deferred. The
one disposable boundary browser flow stopped at Studio startup before any
boundary assertion, as recorded in
`studio/docs/DEVELOPMENT.md`.

The focused logic check passed with evidence in
`studio/data/world-terrain-logic-ldQV1c/diagnostics.json`. The disposable
direct-CDP terrain flow passed with evidence in
`studio/data/world-workspace-AvOQBm/diagnostics.json`: it covered rejected
and cancelled strokes, seam painting, Undo/Redo, no-op repaint, transactional
save, service restart and exact reopen. T042 remains open.

### Existing boundaries

- SQLite `maps` owns each project-scoped level document; `project_levels` owns
  the start reference. Level deletion is soft, and backups and migration records
  are separate. A single-map PUT is transactional but has no revision check
  and cannot atomically save multiple maps (`studio/server.mjs`).
- Both supported models store whole-pixel, section-local object transforms,
  require artwork bounds inside the document, enforce per-document object IDs
  and terrain-cell uniqueness, and limit a design to 4000 objects
  (`games/generic-grid-v1/src/project.js`,
  `games/astraeum-tower/src/project.js`). Assets can have pivots; collision
  offsets are relative to the object transform.
- The editor has one document, camera, cached map-sized scene and selection
  keyed by object ID. `worldPointFromClient` converts canvas input using pan
  and zoom; a 100-entry history stores immutable document/selection snapshots.
  Layer visibility and locks are local model preferences. Placing on a hidden
  or locked layer is rejected. Switching documents clears history
  (`studio/src/main.js`). The world workspace has a terrain brush and
  rectangular fill.
- The pinned public SDK map is limited to 2048 pixels per dimension, 4096
  runtime objects, 4096 collisions and 256 spawns; `createLocalGame` accepts
  one optional `MapDefinition` at creation. Its declarations do not expose
  section loading or replacement of a running map. These runtime limits are
  distinct from Studio's design limit and the current 2 MB single-map request
  limit.

### Identity, storage and compatibility

- Add explicit project-owned worlds and section membership in SQLite. A world
  has an immutable stable ID and model; each section has an immutable stable
  section ID, an integer `(gridX, gridY)` and a reference to exactly one active
  2048 x 2048 map of that project and model. Unique constraints cover world
  position and map membership; section IDs do not encode position. Retain map
  IDs and local object IDs; identify editor objects by `(sectionId, objectId)`.
  Grid positions and their pixel origins/endpoints must be safe integers;
  reject arithmetic overflow rather than rounding.
- Initial scope creates new world sections explicitly, including two adjacent
  sections. Existing independent levels are not added, resized, translated,
  connected or rewritten by migration or opening a world. Attaching, moving,
  detaching or deleting sections and importing existing levels are deferred;
  no automatic level transitions are implied. Keep existing Levels, start,
  delete/recover, single-level Save and Play behavior for independent levels.
  Protect world-owned maps from independent level operations that could break
  membership; expose an actionable explanation, not silent unlinking.
- Add world metadata and revision fields in a transactional, additive schema
  migration without modifying existing map JSON, IDs, timestamps, backups,
  migration reports or start references. Opening the world loads its membership
  and saved section documents; creating a world and its sections must itself
  be all-or-nothing. Project assets remain project-scoped. Workspace state is
  editor data, not a second map authority or a runtime streaming protocol.

### Coordinates and canvas

- A section at `(gx, gy)` has origin `(gx * 2048, gy * 2048)` and owns the
  half-open rectangle `[originX, originX + 2048) x [originY, originY + 2048)`.
  For a finite world point `(x, y)`, use `gx = floor(x / 2048)` and
  `gy = floor(y / 2048)`, then `localX = x - gx * 2048` and likewise for Y.
  Thus `-1` maps to section `-1`, local `2047`; `-2048` maps to `-1`, local
  `0`; `2048` maps to `1`, local `0`. Reverse conversion adds the origin.
  Do not use truncation toward zero or signed remainder as the local coordinate.
  Pointer coordinates may be fractional; authored transforms remain whole
  pixels and respect each model's snap rules.
- Use one world-space camera and canvas. Convert the pointer to world space
  once, resolve section and local coordinates, and translate each section's
  rendering, grid, overlays and hit tests by its origin. Cache/invalidate
  scenes per section and render only visible sections; never allocate a canvas
  covering the entire world. Keep per-model draw ordering, artwork and
  selection geometry consistent. Show section boundaries and loading/error
  states distinctly from authored terrain. No panning or zooming discontinuity
  occurs at the shared edge.
- The terrain brush supports cell-sized strokes and rectangular fill across
  the loaded sections. A single object, artwork
  bounds and collision must remain wholly inside its owning section; reject
  placement or movement that would
  straddle an edge instead of clamping, splitting or relocating it. Cross-edge
  object moves, multi-section selection/group transforms and seamless
  cross-section autotiling/decorations are deferred. In particular Astraeum's
  renderer derives Wang tiles and decorations from a section-local grid:
  show its existing section-edge appearance rather than claim seamless
  neighboring-wall rendering or alter single-level artwork.

### Brush, fill, locks and atomic history

- Add a 32-pixel grid-aligned terrain brush and rectangular fill using
  compatible single-cell terrain assets. Rasterize the entire pointer path in
  world grid cells so fast movement cannot leave holes; deduplicate revisited
  cells. A rectangle includes both endpoint cells, regardless of drag
  direction. At each cell convert its world origin to the owner section and
  local cell. Replacing an existing terrain tile is explicit tool behavior:
  replace that tile, never add a duplicate; an identical tile is a no-op.
  Preserve unrelated objects, layer order, asset references and valid IDs.
- Preview the complete proposed operation without mutating documents. At
  pointer completion validate every affected section, target layer, cell,
  replacement, ID, asset, model and capacity before applying anything.
  A locked or hidden target layer, invalid cell, capacity failure, failed
  load or missing section rejects the entire gesture with an actionable
  section-specific reason; do not skip cells, clip at a boundary, auto-create
  sections, or commit a partial stroke. Pointer cancellation also changes
  nothing. Existing local layer lock/visibility preferences apply throughout
  the workspace and are not collaboration or server locks.
- A gesture may proceed only with every touched section fully loaded and
  validated against the current membership; an unloaded known section may be
  explicitly loaded and retried. Missing, deleted, unsupported, or failed-to-
  load sections remain visibly unavailable, never blank writable land. Keep
  dirty sections and history pinned in memory; do not evict them silently.
  Block the gesture if the required bounded working set cannot be loaded.
- Commit one immutable workspace command containing before/after documents
  and selection for every affected section. One Undo or Redo restores all of
  them together, even across a save; restoring a history command is not a new
  brush operation and is not blocked by a later local layer-lock change.
  A no-op or rejected gesture adds no history entry; a new committed edit
  clears Redo. Preserve the existing 100-command bound and never silently
  discard dirty documents when history is trimmed. World switching and closing
  must offer save/discard/cancel for the whole dirty workspace and retain the
  original documents, history and view on cancel or failure.

### Capacity, saving and concurrency

- Preflight the resulting 4000-object limit separately for each model document,
  including existing terrain and all other objects. A 2048 x 2048 section
  has 64 x 64 = 4096 terrain cells, so filling every empty cell as individual
  objects already exceeds that limit; fail the whole operation rather than
  silently truncate or change the format. Account for replacements before
  counting. Apply existing model validation, per-section serialized-size
  limits and applicable runtime map limits without relaxing or bypassing them;
  drafts may retain the existing saveable-but-not-playable behavior.
- Save all dirty section documents and relevant world metadata through one
  bounded workspace request and one SQLite transaction, not sequential
  single-map PUTs. Validate each payload and identity, project/model,
  membership, active status, section bounds and every expected revision
  inside the transaction before writing; enforce a per-document 2 MB limit
  and an explicit aggregate request/section bound. Use monotonic revisions,
  not timestamps, and make every existing single-map write and level mutation
  that can affect a world member participate in the same revision/conflict
  scheme. Migrate existing revisions without rewriting document bytes.
- Concurrent changes, deletion, membership changes, validation errors,
  request-limit failures and SQLite errors roll back every write; preserve
  dirty documents and history, identify the conflict and require an explicit
  reload/reconciliation rather than overwrite. Mark all saved baselines clean
  only after a confirmed commit. Use a client-generated operation ID and a
  transactionally stored receipt so an interrupted or lost response can be
  reconciled/retried idempotently; never assume either success or failure.
  Disable conflicting editor actions during the save and protect unsaved work
  across service restart or failed reopen.

### Studio/public API boundary

Studio can implement the workspace, persistence, coordinate math, rendering,
tools and history locally while continuing to validate each supported section
and to use the installed public map validator for playable individual maps.
The older separate World workspace is not automatically adopted. Main-editor
level Play now uses kit 0.3.0's public `createLocalGame({ world })` contract:
every section of the selected level, including unsaved edits, retains local
bounds and a signed origin. Validate global starts and public local/aggregate
limits before mounting. Do not flatten a larger level, use replacement geometry
as a streaming bypass, or silently play only one section.

Connected mode is movement, camera and collision only for both models;
single-section gameplay stays on its existing module/skin paths. Resolve the
authored primary start once, preserve entity identity/ticks while crossing
seams, compose neighbor-aware floor artwork and track a continuous world
camera. Enforce both-side collisions, holes and root-owned outer/custom
boundaries. Stop restores editor pan, zoom, active section and selection.
Play never modifies documents, history or saved baselines. Missing starts
fail explicitly; Tower's required unused second runtime slot never replaces
its authored Aries start. Exact contract constraints and compatibility-slot
handling are in `studio/docs/DEVELOPMENT.md`.

Focused runtime/controller checks and traversal of the unchanged disposable
two-section saved level pass. The single native-browser attempt was blocked
at startup; UI/visual acceptance remains unverified, not completed.
Future multiplayer still needs explicit authoritative section loading,
movement/collision and client synchronization. Do not edit private Engine
internals or rebuild the installed kit.

### Acceptance criteria for a future implementation

- Create and reopen a world with adjacent `(0, 0)` and `(1, 0)` sections, plus
  negative-position cases. Assert exact conversions at `-2049`, `-2048`, `-1`,
  `0`, `2047` and `2048` on both axes, round trips, unique identities/positions
  and safe-integer overflow rejection. Existing independent level bytes, IDs,
  bounds, locations, start and backup history remain unchanged.
- In one canvas, pan/zoom, render and hit-test both sections using local
  artwork, including duplicate local object IDs and asset pivots. A seam-crossing
  stroke and rectangles dragged in both directions edit the exact expected
  32-pixel cells in both sections, including negative coordinates, with no gaps
  or duplicate terrain; replacement and no-op behavior are verified.
- One Undo and one Redo restore both section documents and selection exactly;
  save, Undo, Redo and save again preserve correct dirty state. Cancelled or
  invalid gestures create no history; locked/hidden layers, missing/unloaded/
  deleted sections, failed loads and object-boundary crossings cause no
  partial changes and show actionable errors. Loading or retrying never loses
  dirty content. Check per-section capacity, including 4096-cell fill rejection,
  replacement counts and runtime/play validation.
- Inject failure on the second section, stale revisions from a separate
  single-map writer, deleted or changed membership, oversized payload,
  SQLite failure and lost save response. Verify all-or-nothing persisted
  documents, retained dirty state/history and idempotent reconciliation.
  Restart the service and reopen: both committed documents and membership are
  exact; rejected or rolled-back saves leave both prior documents intact.
- Verify independent-level workflows and Play/Stop remain unchanged. Use
  disposable storage and actual editor controls for future
  focused verification; this design is not a claim that those checks ran.
  Runtime streaming, multiplayer, deployment and kit rebuild remain out of
  scope. T042 stays open.

## Unified level sections (current)

- Each level is a stage containing one or more adjacent 2048 × 2048 sections.
  New levels begin with one section. Select an existing section, choose
  Add Section, and click a visual North/East/South/West preview. Disable
  occupied sides; do not expose coordinate entry in the normal workflow.
  New sections have an empty object array (no terrain, walls, props or starts),
  without clearing any saved contents or changing the editor camera. Independent levels are
  never merged or relocated.
- Remove Section reviews the selected section's name, position and object
  count before confirmation. At least one remains, other sections never move,
  and removal is one Undo/Redo action. Save retains archived documents rather
  than purging them; history does not survive reopening. The archive is limited
  to 16 sections. Add and Remove drafts may be combined before Save. Warn
  about starts and custom boundaries; reject removal if the
  custom boundary includes the removed area rather than reshaping it.
- Section maps retain their own map IDs and section-local object coordinates.
  The editor uses the existing main canvas, palette, hierarchy, Inspector,
  layers, tools and history. Object selection identity is `(sectionId,
  objectId)`; objects remain inside their owning section. Unsupported boundary
  moves are rejected with an explanation.
- One labelled Tool dropdown exposes Select, Paint, Rectangle Fill and
  Boundary; only active-tool settings are shown. Palette choice preserves Fill mode;
  Paint strokes terrain and click-places other assets. Keep Save, Undo/Redo
  and Play in the main toolbar. Explain locked/hidden Terrain and incompatible
  palette assets without silently changing layer preferences.
- Terrain painting and rectangle fill operate in continuous 32px world cells
  across loaded section seams. Preflight and history cover all changed
  sections atomically; the existing two-section working-set bound remains.
  Existing smaller maps can paint/fill within saved bounds without resizing.
  Pending fill has explicit Apply/Cancel and blocks Play until resolved.
- Rectangle Fill also repeats non-unique static props and walls at their
  configured world footprint, with independent horizontal/vertical gaps.
  Source artwork resolution and object properties are unchanged. Preview
  counts placements, same-layer Skip/Allow overlaps, and seam-straddling slots
  left empty to retain section ownership. Spawns, items and unique gameplay
  objects do not repeat. Intentional borders are off by default and have a
  separate terrain/wall asset selector in existing tool settings; they use
  a one-cell ring inside the rectangle, not along section seams. Existing
  Wang artwork edge selection is preserved and is not generated geometry.
  Capacity, locks, stale-preview protection and Undo/Redo remain atomic
  across sections. See the development guide for evidence and UI limitations.
- The default playable boundary is the union of saved sections, not their
  bounding rectangle; exposed outer edges block movement, shared seams stay
  open, and holes remain blocked. Adding a section expands the implicit
  default; removing one contracts the union. Custom grid masks or closed polygon outlines preview before Apply,
  reject self-intersections and missing-section areas, and support Escape,
  Undo/Redo and Reset as single history operations. A custom root-level
  boundary remains unchanged when sections are added. Boundary data is
  versioned and validated with the level; decorative border assets are
  independent.
- SQLite migration is additive. `level_sections` and its revision/receipt
  records associate section maps with their owning level; the original map row
  remains the level identity and boundary owner even if its `(0,0)` section is
  archived. Section saves validate membership and revisions
  and update all documents in one transaction. Each level is bounded to 16
  sections and each saved section retains the 2 MB document limit.
- Existing level documents, metadata, starting-level references, assets,
  credits, backups, and independent stages are not rewritten by startup.
  Existing `worlds`, `world_sections`, and workspace-save receipts remain
  unchanged; there is no automatic World adoption. Multi-section movement
  Play loads the selected level's complete section snapshot through public
  connected-world APIs. Single-section custom boundaries remain enforced
  through public rectangle collisions. Excluded/missing authored starts are
  explained, never repositioned or replaced.
  When the original section is archived, even one remaining section uses the
  connected movement-only preview with the retained root document.
  Do not equate runtime adapter checks with main-editor UI acceptance.

Focused disposable checks include `npm run studio:sections:test` and
`npm run studio:boundaries:test`. The one attempted boundary-only
direct-CDP flow stopped at startup and retains diagnostics and screenshots;
its actual results are recorded in `studio/docs/DEVELOPMENT.md`. T042 remains
open.
