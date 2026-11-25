# Studio user guide

For Anh and assistants helping her use Studio or develop Astraeum.
This is the authoritative operating guide for the current editor.
[Root setup/start/stop](../README.md) |
[Developer guide and evidence](docs/DEVELOPMENT.md) |
[Enhancement register](docs/ENHANCEMENTS.md).

The [2026-11-18 developer handoff](docs/DEVELOPER-HANDOFF-2026-11-18.md)
records the earlier shared 0.4.0 baseline, not acceptance of this branch.

## How do I...?

| Task | Instructions |
| --- | --- |
| Install, start or safely stop Studio? | [Root quick start](../README.md#prerequisites-and-setup) |
| Set up the kit or restore Astraeum data? | [Kit setup and starter-data status](../README.md#prerequisites-and-setup) |
| Open/create a game or another level? | [Games and levels](#games-and-levels) |
| Make the same level larger? | [Sections and dimensions](#sections-and-dimensions) |
| Import PNG/PixelLab artwork? | [Assets](#assets) |
| Import an entire source game ZIP? | [Assistant-guided adaptation](docs/DEVELOPMENT.md#source-game-import-and-adaptation) |
| Select/move objects or unlock terrain? | [Layers, selection and editing](#layers-selection-and-editing) |
| Paint sparse props or change brush size? | [Paint](#paint) |
| Fill a rectangle or add a decorative border? | [Rectangle Fill](#rectangle-fill) |
| Limit the playable area? | [Boundaries](#boundaries) |
| Change camera scale or controls? | [Camera and Player Settings](#camera-and-player-settings) |
| Collect items/use herbs/open chests, fight slimes or connect levels? | [Play, combat and rune destinations](#play-combat-and-rune-destinations) |
| Recover from a failed Save or Play? | [Save and error recovery](#save-and-error-recovery) |
| Add gameplay or configure match rules? | [Reuse-first development](docs/DEVELOPMENT.md#4-claude-reuse-first-workflow) |
| Decide multiplayer game rules with Claude? | [Optional baseline and decisions](#choosing-multiplayer-rules-with-claude) |
| Export a saved Astraeum campaign ZIP? | [Export status and required authoring](#evidence-and-unfinished-features) |
| Upload/deploy/play online? | [Actual status](#evidence-and-unfinished-features) |
| How does the ZIP map to the Engine contract? | [Inspected contracts and Engine handoff](docs/GAME-EXPORT-HANDOFF.md) |
| Prepare Wednesday's handoff? | [Delivery checklist](docs/DEVELOPMENT.md#wednesday-delivery-checklist) |

## First checkout: restore Astraeum

The selected Engine kit is 0.5.0, but the supplied starter-data manifest pins
the shared 0.4.0 kit. Therefore the documented
`bootstrap` currently cannot finish its restore; do not restore or replace
existing data to work around that mismatch. Once the starter-data pin is
reconciled, open the existing game with **Open Game > Astraeum Tower** and
continue in its saved levels. Do not choose **New Game**, recreate Floor 1, or
re-import the original source game. Starter-data restoration is not an import
of a complete Engine game package or a server deployment. An existing database
is never overwritten silently.

## Games and levels

**New Game** creates an independent **Generic Grid v1** project with a name,
author/credits, one 2048 x 2048 section and two safe player starts. It does
not copy Astraeum or add combat. Names/credits must be nonblank; normalized
duplicate game names are rejected. **Open Game** opens a saved project's
designated starting level. Use **Current level** in the left panel for other
levels of that game.

The compact **Level** menu acts on the current level:

| Action | Result |
| --- | --- |
| Add Level | Separate blank level: one empty 2048 x 2048 section, no copied or generated terrain, props, enemies, pickups, exits or starts; place required starts before Play |
| Duplicate | Independent copy of the saved design; Save first to include dirty changes |
| Rename | Changes the name, not stable identity |
| Set as start | Changes the game's saved starting level; Play still tests the currently selected level |
| Delete | Confirmation required; the last active level cannot be deleted; deleting the start requires a replacement in this game |
| Deleted levels (recover) | Restores a soft-deleted level's identity/content, without changing the current start |

Game/level switching and relevant actions protect dirty changes with
Save/Discard/Cancel. Cancel or a failed operation retains the current draft.
Level lifecycle operations persist separately; **Add/Remove Section** are
draft edits until Save. Existing saved maps keep their own dimensions.
Unsupported models cannot be opened/overwritten. A compatible legacy
untyped Astraeum document requires explicit **Assign Astraeum and Open**;
do not use that to convert arbitrary games.

## Sections and dimensions

A **level** is a stage; its **sections** form one continuous world. To expand
that world, choose **Selected section** (or click its canvas area), **Add
Section**, then an available **North/East/South/West** preview and **Confirm
Add Section**. Cancel makes no changes. The new section is empty; it never
copies starts or clears existing content. Addition preserves pan/zoom and is
one undoable draft edit. Save the initial template before adding sections.
At most 16 active sections are supported.

**Remove Section** previews identity, position and object count. Review start
and boundary warnings before confirming. Other sections are not moved.
At least one must remain; edit/reset a custom boundary first if it includes
the section. Removal is undoable, including after Save in the same session.
Up to 16 removed sections are retained, not evicted. Reopening retains archive
data but does not restore Undo history; there is no general archive-browser
restore workflow. See [developer invariants](docs/DEVELOPMENT.md#2-building-in-web-studio).

The Inspector's **Map Width/Map Height > Apply expansion** expands the
selected section's existing smaller map in 32-pixel increments up to 2048
per axis. Expansion is explicit and undoable; it adds empty space without
moving/scaling existing objects. There is no contraction control. Use a
boundary for a smaller playable region, or Add Section for another full area.

Astraeum's original Floor 1 footprint requires floor for walkability; an
empty section is not a promise of traversable terrain. Paint the intended
floor route, place starts on it and test both directions across a seam.
Objects cannot be moved across section ownership seams; place them in the
target section instead. The old standalone World workspace is retired;
its stored records remain separate and are not automatically attached.

## Assets

The bottom **Asset palette** is model-specific. Click a card to arm placement
and click the map, or drag it onto the canvas. Green/red previews show valid
placement or the reason for rejection. **Large/Medium/Small/List** changes
palette presentation only, remembered in this browser.

**Import Assets** accepts an individual PNG or a supported **PixelLab ZIP**.
Select the file, inspect its preview, enter asset name, type (**Prop artwork**,
**Character artwork**, **Item artwork**), artist and source/license credit,
then Import. Each declared static direction becomes a palette asset.
Animation exports are rejected, not converted. Import writes project-scoped
assets/catalog records; Save then persists placements in the level.

Source PNG/ZIP metadata bytes and credit/hash records are preserved.
Artwork is visual-only: a picture of a character, door or rune does not gain
AI, animation, collision, combat or exit behavior. Use built-in Aries/slime
spawns and the canonical stairs rune for supported gameplay. Imported prop
artwork can use static Paint/Fill; character/item artwork remains single-place.
Image pixels retain their world size; transparent margins can make visible
art look smaller than its placed bounds. Thumbnails do not define world size.

Limits: ZIP <=16 MiB, <=40 entries, <=16 MiB uncompressed total; PNG <=4 MiB,
dimensions <=2048 x 2048; <=32 images. ZIPs accept only PNGs and
`metadata.json` (metadata limit 1,000,000 bytes). Unsafe paths, duplicates,
unreferenced images and invalid dimensions/data are rejected. Identical images
in a project are rejected without overwriting existing files.
This is **asset import, not universal source-game ZIP import**.

## Layers, selection and editing

**Layers** has visibility and lock toggles; terrain starts locked. Show and
unlock the target layer before selecting, painting or filling. Visibility
affects editor presentation, not a way to delete runtime content. Layer/type
and draw order are model-defined; moving an object retains them.

Use **Select**, then click on the canvas or hierarchy; Shift-click toggles,
empty-canvas drag makes a marquee, and Ctrl+A with the canvas focused selects
visible/unlocked objects in the active section. Hierarchy layer headings
expand/collapse. Inspector transforms refer to the asset pivot in world
pixels, not necessarily its top-left corner. It shows common/mixed values
for multiple selections and supports shared offsets/compatible collision.

Drag, nudge, **Duplicate**/Ctrl+D, Delete or Inspector edits use Undo/Redo
(Ctrl+Z / Ctrl+Y). Arrow nudges are normally 5 world pixels, but a selection
containing forced-grid assets nudges by 32. **Snap** controls supported
transforms; terrain, spawns and stairs always obey their required alignment.
**Grid** visibility is independent.

**Clear Level Contents** previews category counts and skipped locked content;
choose categories and confirm. Hidden layers are included, locked layers
preserved. One Undo restores the operation. Empty/start-free drafts can be
saved, but Play fails explicitly until required starts are restored.

An **Unresolved collision** from a historical migration remains a real
invisible blocker in Play. Use **Review next**, then **Assign artwork**,
**Keep as collision box**, or **Delete (removes collision)** after reviewing
the stated outcome. These actions are undoable; migration history is not a
command to erase original backups.

## Paint

Choose **Tool > Paint**, explicitly choose an eligible asset in the palette,
then drag. The Paint panel names the current asset:

| Setting | Meaning |
| --- | --- |
| Brush size | 1 x 1, 2 x 2, 4 x 4 or 8 x 8 cells: 32, 64, 128 or 256 world pixels per side, not artwork scaling |
| Density (%) | Integer 1-100; default 100. Placement probability, not opacity or image size |
| Minimum spacing | Integer 0-2048 world-pixel gap between same-layer footprints; default 0. Floor on another layer does not exclude props |

Terrain, opted-in walls/static props and imported prop artwork are brush
eligible. Spawns, characters, items, unique gameplay objects, stairs and
collision boxes remain single-place. Unsupported brush controls explain why
they are disabled; palette click/drag placement still works.

The cursor outline is the brush influence area; artwork previews show actual
footprints, which can extend beyond it. Density is stable during a stroke:
retracing does not reroll or stack. Spacing checks neighboring sections too.
Fast strokes cover intermediate cells. At 100% density/zero spacing, floor
terrain uses continuous cell replacement; identical cells are no-ops.
Static copies retain footprint, pivot and collision defaults.

Green previews are valid; red rejects the whole stroke for locks, hidden
layers, missing bounds or capacity. A static footprint straddling a seam is
skipped/countable, never split or resized. The brush itself must stay within
existing sections even at low density. Escape cancels. One Undo covers a
committed stroke across the supported working set (at most two sections).
Save is still required.

## Rectangle Fill

Choose **Tool > Rectangle Fill**, select an eligible palette asset, drag the
rectangle, review the preview/counts, then **Apply fill** or **Cancel fill**.
Choosing an asset in Fill selects it without placing a stray object; no
default asset is silently chosen. Cancel/Escape returns to Select.

Fill repeats terrain, walls and static props at their configured footprint.
Horizontal/vertical gaps are integers 0-2048 world pixels. **Skip overlaps**
preserves same-layer objects; **Allow overlaps** keeps both. Other layers do
not block object fill. Optional collision can be enabled on new copies;
required collision stays required and existing objects are not overwritten.
Terrain instead replaces cells.

**Generate border** is off by default. Choose a separate 32 x 32 terrain/wall
asset for a one-cell ring **inside** the rectangle. Unlock/show both target
layers. There is no internal border at section seams. This decorative ring
does not define a playable boundary; Astraeum's Wang autotile edges are also
not newly generated collision.

Partial edge footprints and seam-straddling object slots are left empty and
counted. Preview reports targets, borders and skipped/allowed overlaps.
Apply revalidates locks, bounds, capacity and stale previews atomically;
one Undo covers changed sections (at most two per working set). Pending
Fill blocks conflicting edits, Save and Play until Apply/Cancel.

## Boundaries

Choose **Tool > Boundary**, then **Grid area** or **Lasso polygon**. Drag a
grid rectangle or trace a closed polygon; points snap to the 32-pixel grid.
Review the playable-cell preview, then **Apply boundary**, **Cancel preview**
or **Reset to default**. Escape cancels the draft.

The default playable area follows the active-section union; custom boundaries
restrict it, including holes. Boundaries are root-owned and enforced in Play,
separate from decorative floor/wall borders. Applying/resetting uses history
and remains draft-only until Save. Repair an invalid boundary/start rather
than expecting Play to relocate the player.

## Camera and Player Settings

Middle-drag or Space-drag pans the editor; wheel and +/- change editor zoom.
These do not resize artwork or change gameplay camera settings.

**Player Settings > Gameplay camera zoom** is 0.5-2.0 in 0.1 steps (default
1.0), saved with the level. Change it in Edit mode and Save. Larger values
show less world at larger apparent size; smaller values show more. Play
follows the player, clamps to world bounds and centers a world smaller than
the viewport, without automatic fit-to-window scaling. Connected Play uses
the level root's camera zoom, not whichever section happens to be selected.

Astraeum's **Control mode** is a local browser preference, not per-character
or server match configuration. Opening settings clears held input.

| Astraeum mode | Controls |
| --- | --- |
| Keyboard Only | WASD move; arrows dodge; Space attacks; H uses a healing herb |
| Keyboard + Mouse | Arrows move; pointer aims; left click attacks; hold right mouse + arrow to dodge; H uses a herb |
| Game Controller | Standard pad: left stick moves; right stick aims; RT attacks; B/Circle + direction dodges; Y uses a herb |

Focus/click the Play canvas. Blur/disconnect clears input; after transitions,
release held controls to neutral before continuing. Physical controller
hardware remains unverified. Generic Grid supports WASD/arrows movement;
choosing a Tower mode does not give it Tower combat/controller gameplay.
Chests open automatically once when a player approaches within 46 world pixels;
no chest Interact key or controller button is used.

## Choosing multiplayer rules with Claude

Before implementing rules, discuss cooperative versus competitive play,
unlimited versus limited lives, respawn delay/safety, completion conditions,
shared versus individual progression, scoring/rewards/HUD, and player-start
assignment/maximum players with Claude.

An **optional Dots and Squares baseline** is to clear all enemies, advance
together, increase difficulty, respawn after a configurable delay, and show
player/team stats. Claude should explain the tradeoffs and actual support,
recommend a coherent starting point, and let **you decide before changes**.
This is not an Astraeum requirement or a ready-made Studio mode.

See the [decision guide and source-confirmed support](docs/DEVELOPMENT.md#multiplayer-game-rule-discussion-with-anh).
Some protocol settings exist, but game code must consume them; Player Settings
does not configure multiplayer rules. Current local Play is not verified
multiplayer, and two authored starts do not prove two-player support.

## Play, combat and rune destinations

**Play** uses the selected level, including unsaved edits and **all active
sections**, not just the selected section or the game's designated start.
Generic is movement/camera/collision only. Astraeum uses its combat, dodge,
lighting, Halberd and authored slimes. Aries starts with 500 HP/100 stamina;
slimes have 36 HP. Inspector combat values are **read-only**, fixed in the
Tower module; positioning/removing starts/spawns is authored, per-character
stats, AI, weapons and match rules are not.
An empty Add Level draft has no player starts; Play reports the missing start
instead of generating one. Astraeum needs an Aries start; Generic Grid needs
both player starts.

Play's lighting controls adjust ambient brightness, player light radius,
intensity/softness and **Fully lit** for that mounted preview. They are not
per-character stats or saved level-light authoring controls.

Astraeum's built-in herbs, glowcaps and gems auto-collect once when nearby.
Herbs add one inventory item; H uses one to restore up to 30 HP, but does not
consume it at full health. Glowcaps and gems are tracked in the original run
inventory; no mushroom use, crafting or shop is implemented. Approaching within
46 world pixels opens a closed chest once and spills pickups; no Interact input
is required. The Inspector selects **Normal** (2-4 items) or **Treasure** (4-6 items). Normal
rewards choose herb twice-weighted, mushroom, amethyst twice-weighted, sapphire,
ruby or emerald, plus 10-16 Floor 1 baseline gold. Treasure rewards choose
herb, sapphire, ruby, emerald, mana crystal twice-weighted or amethyst, plus
24-39 gold. New chests default to Normal. Barrels, crates and pots remain
decorative because the original defines no attack durability or drops.
Collected/opened state and run inventory persist across connected level
transitions and revisits in the same Play run; Stop or a new Play resets them.
They are runtime-only and never change the editor draft or saved design.
The existing opened-chest renderer caches the filtered artwork instead of
applying a Canvas filter every frame; preserve this fix when changing skin
rendering. Its focused checks are recorded in the
[developer guide](docs/DEVELOPMENT.md#astraeum-collectible-and-chest-interactions-current-implementation).

To connect Astraeum levels:

1. Prepare and Save the destination in the same game, with exactly one active
   Aries start on safe walkable ground.
2. Select the built-in **Stairs rune** on the canvas/hierarchy (unlock its
   layer if needed). In the behavior-first Inspector choose **Destination
   level (this game)**, then **Arrival player start (active section)**.
   Choosing the level clears the old start; it does not choose one for you.
3. Check the validation message and Save the source level. Play may also test
   an unsaved source reference; other destination levels load their saved
   complete active sections.

The violet rune, not a decorative/generated door, is the exit. Every living
authored slime across active sections keeps it locked; archived sections do
not contribute. Nearby prompt: **Defeat N remaining slimes**. Once unlocked:
**Enter the rune to continue**. Entering strictly within 40 world pixels
activates automatically; if already there when the last slime dies, it
activates then. **No E/X/Square Interact is required.** The Inspector and
help describe automatic entry.

One attempt per entry prevents duplicate requests. A destination spawn already
inside a rune does not bounce: leave and re-enter to arm it. Missing/deleted
destinations, blocked/missing/ambiguous starts and invalid worlds show specific
errors. A failed load retains the source encounter and visible error; it
does **not** retry every tick. Leave/re-enter to retry, or Stop and repair.
No fallback arrival tile is invented.

Transitions preserve HP, stamina and facing, reset held/combat transient state,
and create a fresh authored encounter. Revisiting the original level uses
the captured unsaved source draft; gameplay does not save progress.
**Stop** (or Escape during active Play) restores the original editor draft,
active section, selection, pan/zoom, history and saved baselines, even after
visiting another level. Stop also cancels an in-flight load.

## Save and error recovery

**Save / Ctrl+S** persists the complete selected level: active/archive
membership and documents atomically to the local SQLite store. It is not a
Git commit, export or upload. Confirm **Saved** before leaving. Undo/Redo
history is session-local; saved state and a browser preference are different.
Draft edits are not a durable autosave/recovery guarantee.

| Symptom | Safe response |
| --- | --- |
| **Save failed - unsaved** and alert | Read/capture the specific HTTP/network error; the draft/history remain. A refresh of other UI must not hide this failure |
| Lost response/network/5xx uncertainty | Retry Save to reconcile the same pending operation; edits made meanwhile remain dirty. Do not undo/remove an uncertain newly added section first |
| HTTP 409 conflict | Do not overwrite revisions, discard or reload. Preserve the draft/request and error, compare the current server baseline with developer help, then reconcile intentionally |
| HTTP 400 validation | Repair the named field/object. If a valid current document is rejected by an older running API, preserve it before arranging an authorized API restart |
| Play fails to start | Read the visible Play error, return to editing, repair starts/floor/collisions/boundary/capacity and try again |
| Exit error | Keep the source encounter; leave/re-enter for a deliberate retry or Stop to repair. Do not re-save a destination already confirmed saved as a generic cure |
| Blank/loading tab or busy port | Preserve a dirty draft first; inspect web/API logs, network errors and owning process. Do not start browser retry loops or kill/restart someone else's service |

There is no general UI "download dirty draft" feature. If Save cannot succeed,
keep the tab alive and have an assistant preserve the **exact** pending level
payload/documents, membership/revisions and identity to a separate recovery
artifact, verify it, and arrange a consistent database backup before a risky
reload/restart. A screenshot or a stale checked-in template is not the draft.
Do not post credentials or unrelated private data with diagnostics. Vite can
reload served-source edits too: preserve first, not only before manual reload.

Migration backups are SQLite-owned; use consistent SQLite backup procedures
(accounting for WAL), not live-file replacement. Unknown/failed migrations
must remain explicit errors, never silently rewritten. Detailed recovery
evidence in the developer guide is historical, not an instruction to replay
an old Save against the current database.

## Evidence and unfinished features

**Confirmed implementation** means source/controller/public-contract inspection.
**Focused-test evidence** means only the tested runtime/event/API behavior;
substituted DOM/Canvas I/O is not native-browser visual acceptance.
**Manual verification** means the user's specifically recorded observation.
**Unfinished** is not a claim that no supporting public API exists.

| Capability | Current scope and evidence |
| --- | --- |
| Editor, levels, assets, Paint/Fill, boundaries and Save | Implemented; focused checks and historical segmented browser evidence in [DEVELOPMENT.md Section 5](docs/DEVELOPMENT.md#5-verification), not a fresh full acceptance pass |
| Section movement/camera/collision, explicit-Save section edits, asset painting | Separate user manual confirmations recorded; do not broaden them to every feature |
| Automatic Astraeum progression and exact Stop restoration | Focused disposable real-runtime/registered-input fixtures passed; native-browser acceptance not established |
| Connected native-browser acceptance | Still open; recorded startup attempts blocked at **Opening Floor 1...**. Do not relaunch loops or call this passed |
| Arbitrary source-game ZIP adaptation | Assistant-guided inspection/extraction/porting, not an implemented universal importer |
| Complete-game export | Export Game is available for a saved Astraeum campaign, using the 0.5.0 package contract. The focused package test passes. A disposable copy of the saved campaign is rejected because active Level2 has no authored exit to Level3; level-list ordering is not the cause. Add the intended explicit rune destination in the Inspector and Save. No saved-campaign ZIP has been produced; see the [Engine handoff](docs/GAME-EXPORT-HANDOFF.md) |
| Server upload / deployment | No Studio upload/publish workflow or verified Astraeum server installation; theme-package support in Engine is not evidence this game can upload |
| Multiplayer / online play | No established Astraeum multiplayer, authoritative-server, online lobby or collaborative editing support. Local preview proves none of these |
| Configurable match rules | No Studio match-rule authoring or Tower consumption of generic protocol defaults; Player Settings is controls/camera, not rounds, teams, wins or lobby settings |
| Other gameplay/tooling | Astraeum's source-backed pickups and chest loot are implemented game-specifically; imported animation/AI, player death/respawn, other enemies, spells, crafting/shops, procedural generation, audio authoring, shared gameplay libraries and PixelLab API integration remain unfinished here |

**Engine web-client release (2026-11-18):** Engine
[PR #8](https://github.com/scottzastrow/multiplayer-game-engine/pull/8)
updates the production host's session-creation selector; it does not change
the public SDK or Developer Kit. Studio remains pinned to kit 0.5.0 at Engine
revision `d0f46931f56b90298b3209010581a0ffd7f79561`; no kit upgrade or Studio
application change is part of this release. The Engine's authenticated deployed
browser acceptance is still pending, and this note does not claim Studio or
multiplayer acceptance.

The [Wednesday checklist](docs/DEVELOPMENT.md#wednesday-delivery-checklist)
separates demo evidence from delivery promises. **T042 stays open.**
