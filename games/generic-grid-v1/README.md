# Generic Grid v1 model

Shared, versioned starter code, not a saved game or an Astraeum template.
`src/project.js` owns the independent primitive catalog, document validation,
placement geometry, renderer and runtime-map derivation.
`src/runtime.js` adapts that document to the installed public
`@multiplayer-game/local-preview` and `@multiplayer-game/theme-sdk` exports.
It implements only radius-8 player movement (4 pixels per fixed tick),
bounded by the map and explicitly placed 32-pixel blockers. No Tower artwork,
lighting, autotiling, collision exceptions, enemies or other gameplay is used.

New Game allocates a different stable project ID and map ID, writes its
identity/author/model/adapter metadata and a runtime re-export under
`games/<project-id>/`, and inserts the design in SQLite. The starter has a
blank background and two distinct player starts because the installed public
map contract requires two. Dimensions default to 640 x 480 pixels and must be
multiples of 32 between 64 and 2048. Both 64 x 64 and 2048 x 2048 are supported.
The map is not written into the generated directory: SQLite is authoritative.
The `assets/` directory is reserved for the following asset-import milestone;
only the built-in primitive catalog is currently available.
