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
- Open saved project/map pairs supported by the Astraeum model, protect
  unsaved changes, and use the selected document for Play/Stop. Require
  explicit consent before identifying an untyped compatible map as Astraeum.
- New Game beside Open Game: collect a nonblank game name (up to 64 characters),
  author/credits (up to 128), explicit Generic Grid v1 model and dimensions.
  Defaults are 640 x 480 pixels; each axis must be a multiple of 32 from
  64 through 2048, matching the installed public map contract.
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

Multiplayer editing, collaboration, dynamic-object motion, generators,
PixelLab integration, engine-kit changes or rebuilds, publishing, deployment,
changes to `reference/`, arbitrary custom model loading or gameplay scripting.
Asset importing is the following milestone; no asset borrowing or import UI
is part of this milestone.

## Constraints

- Preserve the Astraeum Tower launch command, map, collision, lighting, artwork
  credits, sample project, and the reference source.
- Use only installed public runtime APIs; report a blocker instead of importing
  private engine modules.
- Keep all changes local and uncommitted; leave T042 open.
