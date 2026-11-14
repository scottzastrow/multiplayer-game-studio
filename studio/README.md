# Web Studio map editor

Run `npm run studio:dev` from the repository root, then open
`http://127.0.0.1:4173`. This starts the Studio Vite app and its map service;
the service binds only to `127.0.0.1`. The editor reads the existing Floor 1
template and artwork from `games/astraeum-tower/`, but does not modify that
game's launch command (`npm run astraeum:dev -- --port 5180 --strictPort`) or
the reference copy. The Studio's default database file is ignored at
`studio/data/studio.sqlite`.

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

## Migration from format 1

Format 1 stored terrain rows plus a `walls` rectangle list. On startup the
service upgrades every stored format 1 row inside one SQLite transaction and
first copies the original row byte-for-byte into `map_backups`; the outcome is
recorded in `migrations` and shown in the Inspector. Grid-aligned format 1
walls become walls with the same IDs. Off-grid format 1 walls were drawn with
floor art, so they are not relabelled as walls: they become collision boxes
with the same ID, position, and collision, flagged "migrated" with an
explanation. Overlapping walls are kept and reported. If a row cannot be
migrated, it is left untouched, the failure is recorded, and the API refuses
to read or overwrite it (HTTP 409) rather than silently discarding data.

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
locked: visible but not selectable) and a hierarchy grouped by layer. The
bottom palette groups assets by type; drag a card onto the map to place it
with a live preview (green when valid, red with a reason when not), or click a
card to arm **Place** and click the map. Each card shows its artwork region,
credit, and Play status ? **In Play**, **Partial in Play**, or **Editor only**
for items and enemy spawns that are saved but have no gameplay yet. Drag
objects to move them, Delete to remove (required objects such as the Aries
start cannot be deleted), and use the Inspector for exact coordinates and
optional collision. Grid visibility and snapping are independent; terrain
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
test-specific files. Later milestones: multiplayer editing, dynamic-object
motion, item and enemy gameplay, generators, and PixelLab integration.

## Verified result

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
