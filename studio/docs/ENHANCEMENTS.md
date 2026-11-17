# Enhancement register

Track reusable Studio prototypes, game-specific capabilities, and public API
gaps here. Keep independent game-specific and reusable work in separate
changes. Add evidence and focused test commands; a listed test is not a claim
that it has passed.

Statuses: **game-specific** (intentionally stays in one game), **Engine
candidate** (local reusable prototype, not public), **promoted** (shipped in a
versioned Engine kit), **migrated** (affected games explicitly use the shipped
API and the prototype was retired after behavior checks).

| Feature | API gap / available capability | Implementation path | Focused tests | Kit dependency | Status | Studio commit | Engine commit/revision |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Astraeum tilemap-to-runtime collision adapter | Public `MapDefinition` validation and runtime geometry exist; no first-class Wang/tilemap renderer or Astraeum wall-face adapter. | `games/astraeum-tower/src/tilemap-adapter.js`, `src/design-render.js` | `npm run astraeum:smoke` | Kit 0.2.0; theme SDK 0.1.0; Engine revision `2717a9bc86c2b8db0865a2e37cffa609b0f8a208` | Engine candidate | `3cd3699` | `2717a9bc86c2b8db0865a2e37cffa609b0f8a208` |
| Astraeum combat and input | Public module, movement and geometry contracts support game modules; Tower-specific dodge, stamina, weapons and slime encounter remain game-owned. | `games/astraeum-tower/src/game.js`, `src/skin.js` | `npm run astraeum:combat:test`; `npm run studio:smoke` | Kit 0.2.0; theme SDK 0.1.0; Engine revision `2717a9bc86c2b8db0865a2e37cffa609b0f8a208` | game-specific | `44798ab` | `2717a9bc86c2b8db0865a2e37cffa609b0f8a208` |
| Astraeum world lighting | Public Canvas and skin view/anchor boundaries exist; no public Engine world-lighting renderer or Tower lighting settings. | `games/astraeum-tower/src/lighting/world-lighting.js`, `src/lighting/tower-lighting.js`, `src/skin.js` | `npm run astraeum:smoke` | Kit 0.2.0; theme SDK 0.1.0; Engine revision `2717a9bc86c2b8db0865a2e37cffa609b0f8a208` | Engine candidate | `9cc5489` | `2717a9bc86c2b8db0865a2e37cffa609b0f8a208` |
| Studio playable boundaries | Public rectangle collisions enforce rasterized polygon/grid cells; connected worlds retain section union, gaps and outer edges. | `studio/playable-boundaries.js`, `studio/extensions/connected-play.js`, both game `src/project.js` adapters | `npm run studio:boundaries:test`; `npm run studio:connected-play:test` | Kit 0.3.0; theme SDK 0.1.0 | Engine candidate | this change | `dca3ffc4561c14e0e83968afceabf0e85cddc565` |
| Connected-section public world API | Validated `world` option, signed origins, qualified/resolved starts and continuous union geometry now ship publicly; no oversized maps or geometry replacement workaround. | Both-model movement-only Studio integration in `studio/extensions/connected-play.js` and main-editor Play; legacy single-section branches retained | `npm run studio:connected-play:test`; `npm run studio:apply:test`; `npm run studio:runtime-sections:test`; browser attempt blocked at startup | Kit 0.3.0; public packages 0.1.0 | migrated | this change | `dca3ffc4561c14e0e83968afceabf0e85cddc565` |

For new rows, record the exact Engine revision that supplied the public API,
not an assumed Engine repository commit. This checkout has no Engine source
history. Update status and commit references only after the work is actually
reviewed, versioned, migrated, or committed.

## Connected-section Play: current integration

The separately scoped Engine handoff below is fulfilled by kit 0.3.0 at
`dca3ffc4561c14e0e83968afceabf0e85cddc565`. Studio's selected-level Play
uses the validated public `world` contract for both models, including all
unsaved section documents, authored primary start, root boundary, neighboring
floor occupancy and continuous world camera. Combat, dodge, lighting and
generated decor remain outside connected mode. No editor features were added.

Per-section map limits are unchanged; aggregate world limits are 4096
objects/collisions, 256 spawns and 1,000,000 bounding navigation cells, across
1-16 sections. Generic keeps both authored starts. Tower keeps its existing
unused compatibility slot on a distinct already walkable cell because the
world schema requires two starts; it never replaces the authored Aries start
or changes a saved design. Public validation rejects invalid/over-budget input.
Single-section modules/skins remain on their original path.

Focused runtime, controller, rendering-command and boundary checks passed,
including read-only traversal of the preserved two-section level's disposable
copy. The one native-browser attempt stalled at **Opening Floor 1...**; actual
browser acceptance remains open. See `DEVELOPMENT.md`, Section 5, for the exact
provenance, compatibility-slot constraint, measurements and retained evidence.
**Migrated** records adoption of the shipped API, not browser acceptance,
multiplayer support, publication or completion of T042.

## Historical 0.2.0 public contract audit and Engine handoff

The following records the earlier audit, not the current installed contract.
**Then-next milestone:** movement, camera and collision across the selected level's
sections, not more editor tools. **Disposition:** blocked on a supported
connected-world contract under the existing map limits and stable runtime
world-coordinate requirement. Keep the current explicit multi-section Play
guard and existing single-section adapters. This is not a claim that the
runtime lacks geometry replacement, or a proof that every possible custom
streaming/rebasing implementation is impossible.

### Installed evidence (2026-11-17)

The audited pin is kit 0.2.0 / Engine
`2717a9bc86c2b8db0865a2e37cffa609b0f8a208`. Read the installed `API.md` and the
published entrypoint declarations, resolved by `games\sample\node_modules\`:

| Public surface | Available contract | Missing for this milestone |
| --- | --- | --- |
| `local-preview\dist\index.d.ts`: `LocalGameOptions`, `LocalGame` | One initial `map?: MapDefinition`, or factory `createInitialMap`; isolated fixed-tick simulation, input, snapshots, disposal | No validated section collection, origins or connected world option |
| `theme-sdk\dist\maps.d.ts`: `MapDefinition`, validation, limits | Local width/height <= 2048, cell size 32, <= 4096 objects/collisions and <= 256 spawns | No signed world origin or seam/adjacency semantics; flattening adjacent full sections fails validation |
| `theme-sdk\dist\index.d.ts`: `GeometryService` | Circle movement and walkability against active geometry | No section-aware query/continuous collision over the union of separately bounded maps |
| Same: `MapGeometry`, optional `ModuleContext.maps` | `prepare({bounds, cellSize, obstacles})`, then `commit(token, entities)` replaces geometry and the supplied entity set | A single zero-origin rectangle, not coexisting sections; no origin transform or preserved global-coordinate section handover |
| Same: `SkinHost`, `SkinFactory` | Arbitrary snapshots and Canvas rendering, input, camera anchor | Camera/render composition is Studio/game integration work, not an Engine renderer blocker |

`MapGeometry.bounds` is typed as numbers without the `MapDefinition` schema's
2048 maximum. That does **not** justify claiming `prepare` rejects a 4096-wide
layout. No oversized layout was submitted: using that lower-level path to
flatten a level would bypass the requested map limits. A bounded moving-window
implementation would instead require explicit entity rebasing plus a separate
virtual-world origin, obstacle clipping, navigation and snapshot/camera
coordinate conventions. None is supplied as a connected-world contract by
this pin. Do not silently substitute teleports, recreated games, or undocumented
capacity assumptions for continuous section traversal.

The public-entrypoint contract check `studio\scripts\runtime-sections-contract-test.mjs`
demonstrates both X and Y edges: an authored position at 2000 moves only to
2040 for radius 8; a replacement layout cannot commit that player at global
coordinate 2064; a same-position replacement succeeds; entering the next
map at local coordinate 16 requires an explicit position change. Failed
replacement preserves the entity and active geometry. This is bounded
replacement evidence, **not** connected-section acceptance.

Current adapters also need migration, even after an Engine contract ships:

- `studio\src\main.js` clones only the active document for Play and rejects
  `state.sections.length > 1` before constructing a runtime. Do not remove
  that guard until the entire selected level can be validated and loaded.
- Generic `src\runtime.js` captures one map for initialization and movement;
  its skin draws one design and clamps its camera to that design.
- Astraeum `src\game.js` captures one grid, map, blockers and authored start;
  its local `moveActor`/`isActorBlocked` treats outside-grid cells as walls.
  `src\skin.js` caches one design background and one map's camera bounds.
  Changing only `createLocalGame({map})` cannot fix these independent seams.
- Astraeum's `src\design-render.js` derives Wang floor corners from one
  section's occupancy. Connected rendering must sample neighboring sections'
  occupancy instead of inventing an artwork edge at their shared seam.
- `studio\playable-boundaries.js` already computes section-union cells and
  exposed edges. Reuse that ownership; retain gaps, holes and custom boundaries
  instead of treating a bounding rectangle as playable.

### Proposed Engine-owned package step (subsequently shipped in 0.3.0)

The following is a **proposal**, not callable API in the installed kit. Implement
and review it in Engine, then publish declarations, executable contract tests,
API documentation and checksums in a new versioned kit. No kit rebuild or
upgrade is part of this Studio task.

```ts
interface ConnectedMapDefinition {
  formatVersion: 1;
  id: string;
  name: string;
  cellSize: 32;
  sections: readonly {
    id: string;
    origin: { x: number; y: number };
    map: MapSectionDefinition;
  }[];
}
// New public MapSectionDefinition validator: same local geometry/ID limits as
// MapDefinition; zero local starts are allowed for blank neighbor sections.
// Validate starts globally, once, against roster requirements.
//
// New public validateConnectedMapDefinition(input).
// LocalGameOptions: exactly one of map / world (or legacy createInitialMap).
// world: ConnectedMapDefinition; existing map behavior remains unchanged.
```

Required Engine semantics and deliverables:

1. Validate 1-16 sections, unique section IDs and grid origins (multiples of
   2048, including negative origins), local bounds <= 2048 and existing
   per-section object/collision/spawn limits. Publish explicit aggregate budgets;
   reject excess with section-qualified errors, never truncate or inflate a
   local map's bounds. Keep old `MapDefinition` validation unchanged.
2. Geometry queries and `moveCircle` take stable **world coordinates**.
   Collision broad phase includes every section touched by the circle/swept
   movement, not only the section containing its center. Shared edges of
   adjoining playable areas are open; missing sections, small-root gaps, holes
   and exposed outer edges are blocked. Movement cannot tunnel at seams/corners.
   Document whether lower-level `MapGeometry` remains replacement-only.
3. Namespace geometry/entity references by section while retaining local
   authored IDs. A start is `origin + local position`, resolved once from the
   selected level, never the project's starting level or current editor section.
   Missing/duplicate/blocked starts are explicit errors, not replacement starts.
   Blank neighbor sections do not require duplicated players or reserved starts.
4. Do not recreate the simulation, reset ticks, or reinitialize players on a
   crossing. Entities and snapshots retain world position/identity; navigation
   and entity indexing must agree with the same geometry. If Engine chooses
   internal streaming/rebasing, expose and document its atomic origin semantics
   rather than making Studio depend on private behavior.
5. Add Engine tests for east/west and north/south crossings, negative origins,
   corners, circle straddling a seam, blockers on either side, high-delta sweeps,
   missing-section holes, invalid/over-budget input, failed-load atomicity and
   unchanged legacy one-map movement. Scope gameplay to movement/collision;
   combat, NPC streaming, multiplayer and publishing are separate work.

### Studio adoption after that separate step

Take an immutable snapshot of **all sections of the selected level**, including
unsaved edits, catalog and root-owned playable boundary. Validate it as a whole
before mounting; no save or database write occurs. Translate local geometry
and authored starts using `studio\world-coordinates.js`, namespace IDs, and
compose the union boundary through the new public API. Reject ambiguity rather
than guessing a start or playing the first section.

Add a movement-only connected preview for both models, retaining the current
single-section path unchanged. Reuse artwork, collision helpers and renderers;
make Astraeum's occupancy sampling section-aware. Follow the world-coordinate
player with the saved gameplay zoom; do not clamp at interior section edges.
Capture editor pan, zoom, active section and selection before Play; restore
them exactly on Stop and startup failure. Simulation state must never enter
section documents, history, Save, or recovery data.

Acceptance gates at the time of this handoff (all then open): selected-level authored-start loading;
bidirectional seam crossing without reset/artificial wall; continuous floor
and camera; blockers on both sides and enforced outer boundary/holes; exact
Stop view/selection restoration; identical saved design before/after; existing
single-section behavior. Use the user's existing authored level only through
a disposable SQLite/assets snapshot, plus synthetic failure fixtures. Do not
repair saved starts, fill terrain, or change boundaries to make tests pass.

Execution evidence and the single browser-startup blocker are recorded in
`DEVELOPMENT.md`, Section 5. T042 remains open; no publication is implied.
