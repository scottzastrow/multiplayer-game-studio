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
- [x] Add validated stable project/map identity, project-scoped SQLite rows,
  backups and migration history; migrate the existing Astraeum data and wire
  the current editor to its explicit identity.
- [x] Verify disposable database migration, save/reopen, invalid IDs and
  isolation; run the existing editor smoke.
- [x] Add Open Game for saved project/map pairs, unsaved-change protection,
  explicit Astraeum model identification, and selected-document Play/Stop.
- [x] Verify project switching, isolation, restart/reopen, model confirmation,
  unsupported records and Play/Stop with disposable data.
- [x] Add New Game UI, validation, unsaved-change protection and transactional
  project creation with independent stable IDs and rollback of generated files.
- [x] Add the explicit Generic Grid v1 document and primitive catalog, blank
  terrain and two safe player starts; no copied Tower art or gameplay.
- [x] Select the model-specific editor catalog/renderer and public runtime
  adapter for created and reopened projects; keep SQLite authoritative.
- [x] Collapse migration history while retaining visible, actionable
  Astraeum unresolved-collision warnings.
- [x] Verify two generic games through actual browser controls: invalid and
  duplicate inputs, cancellation, separate edits/saves, restart/reopen,
  isolated Play/Stop and return to unchanged Astraeum.
- [ ] Following milestone: asset importing with project-specific compatibility
  and credits. No silent fallback to Tower assets.
- [ ] T042 remains open (no publication/deployment or kit rebuild).
