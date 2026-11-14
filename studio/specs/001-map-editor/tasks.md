# Studio Map Editor Tasks

- [x] Implement the local Studio shell and Floor 1 viewport.
- [x] Add wall editing, viewport controls, keyboard nudging, undo/redo, and
  dirty-state handling.
- [x] Add the loopback-only SQLite service and document the authoritative map
  representation.
- [x] Connect Play/Stop to the installed public runtime without mutating the
  authored design.
- [x] Verify the complete browser workflow with a disposable database and
  document the actual result.
- [x] Trace the wall-selection/cobblestone bug through selection, asset
  mapping, and draw order; share render and hit-test geometry.
- [x] Introduce the format 2 object document, asset catalog, layer locking,
  and drag-from-palette placement with preview and snapping.
- [x] Migrate format 1 SQLite rows with an untouched backup and visible report.
- [x] Fix Play startup (visible, focused runtime canvas, loading state,
  actionable errors) and verify through the real Play button.
- [x] Label unresolved migrated collisions with assign/keep/delete actions and
  add palette thumbnail/list views remembered locally.
