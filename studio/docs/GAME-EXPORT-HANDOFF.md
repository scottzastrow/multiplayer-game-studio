# Complete-game export: Engine contract handoff

**Status, 2026-11-17: Studio selects Engine kit 0.4.0 and has an internal
package builder; saved-project export is not available.** Do not
substitute an editor backup, a Vite/local-preview bundle, or the existing
media-only theme ZIP. T042 remains open.

The [developer handoff](DEVELOPER-HANDOFF-2026-11-18.md) versions the selected
kit and tested internal Dots builder. The unfinished Astraeum package adapter,
export API and Export Game dialog were deliberately excluded: declaring an
adapter locally does not register it in the pinned Engine. The historical
uncommitted status below describes the original investigation, not the
published developer-handoff branch.

## Kit 0.4.0 contract and upgrade preflight

The verified local kit is 0.4.0, Engine revision
`6cd1d52906da084a8c3bc92ca006cf1e6288b326` (manifest source state `committed`),
with Theme SDK 0.2.0 and Protocol/Local Preview 0.1.0. The archive and its
sidecar are retained under `engine\archives\`; the ZIP SHA-256 is
`62b4b582eee4913277ac9729349f6620e316539ce9056a73bfb98f48aa0cb233`.
Setup with `--upgrade` and all 50 distributed checksums passed in an isolated
copy. Sample verify/build and the runtime-sections, connected Play, Astraeum
progression and interaction tests passed there. After the draft was saved and
Studio stopped, the same setup command selected the verified kit in the
working checkout. The receipt and sample dependency junction were verified;
the prior kit and dependency directory were retained. A consistent SQLite
backup was taken into ignored storage before startup.

```powershell
npm run setup -- --archive .\engine\archives\multiplayer-game-developer-kit-0.4.0-6cd1d52906da.zip --upgrade
```

- **Available:** `GamePackageManifestSchema` in the Node-only SDK `/package`
  entrypoint, and `validateGameCampaign` and `campaignStartingMap` in the
  root SDK. The two-level Dots and Squares fixture passed public SDK
  validation, campaign/media hashes, canonical digest, starting-map resolution
  and dangling-exit rejection. This was not an import or server launch.
- **Documented Engine support:** the existing upload route accepts version-1
  campaign JSON plus declared media for the registered
  `dots-and-squares@1.0.0` adapter. The authoritative session starts in the
  designated section. Digest-pinned asset delivery endpoints exist; the
  browser is not yet wired to resolve package assets through them.
- **Still missing:** no Astraeum adapter or compatible registered Tower
  module/skin, no uploaded executable code, no authoritative campaign exit or
  cross-section/level transition, and no Studio saved-snapshot exporter.
  Custom modules and skins require a separate reviewed Engine build. Do not
  assign the Dots and Squares adapter to Generic or Tower by default.

The next compatible Studio exporter must target a reviewed, registered
adapter and the shipped package contract, preserving the saved-snapshot
requirements below. Verify the exact ZIP through Engine import and server
initialization before offering it for download. Browser asset integration and
two-client progression remain separate gates.

The internal Node builder in `studio\extensions\game-package.mjs` accepts
already adapted campaign data and an explicit map of declared media bytes.
It assembles the v1 ZIP using the installed SDK validators, binds the payload
and credits to the manifest digest, and rejects Studio model IDs without a
registered adapter. `npm run studio:game-package:test` rebuilds the official
Dots and Squares fixture in memory and checks the round-trip and rejection
cases. This is not Engine import evidence, does not read Studio's database,
and deliberately exposes no Export Game download.

The pinned v1 manifest has Project/Author credits but no per-asset provenance
field. Keep Astraeum artwork attribution and source hashes in
`games\astraeum-tower\assets\provenance.json`; do not add unsupported manifest
keys. A future complete-game contract still needs a reviewed way to carry that
asset-level provenance.

## Historical kit 0.3.0 baseline and ownership

The original audit used kit 0.3.0, public packages 0.1.0, Engine revision
`dca3ffc4561c14e0e83968afceabf0e85cddc565` through
`engine\developer-kit.lock.json`. The locally available sibling Engine
checkout had that HEAD on `001-multiplayer-engine` with unrelated dirty
changes. Its importer, loaders, storage and server/client contracts were read
directly; it was not added as a Studio dependency or modified. A fresh Studio
clone does not include that sibling checkout.

Studio investigation/handoff work is uncommitted on
`feature/game-export-contract`. Existing onboarding, chest/interaction,
progression, recovery and other working-tree edits were retained. No Engine
change, kit rebuild, deployment, commit, push or regular-service restart was
performed. No browser was started and no saved game/database was exported.

## Actual import boundary and reusable pieces

Paths in the Engine column are relative to the **Engine repository**, not
private modules Studio may import.

| Inspected owner/source | Confirmed behavior and consequence |
| --- | --- |
| Engine `packages\theme-sdk\src\package.ts:18-109`; `src\index.ts:60-103` | Public `ThemePackageManifestSchema` is a strict theme definition plus required project/author, optional course and required/optional asset maps. It contains theme/module/skin/state/settings versions, `engineApiMajor`, asset SHA-256 values and a canonical manifest digest. There is no package-schema/SDK requirement or campaign/starting-level contract. Reuse credits, hashes and canonical digest rather than inventing alternatives. |
| Engine `apps\server\src\themes\packages.ts:610-747` | `validateAndInstallThemePackage` extracts to staging, validates CRC, paths, byte/image budgets, media formats, manifest, hashes and registered code compatibility, then promotes files and registers the revision transactionally. A registry conflict removes promoted files. Reuse this validation/install pipeline, including rollback; do not weaken the existing media-only path. |
| Engine `apps\server\src\themes\packages.ts:500-540,561-590` | Non-manifest JSON and JavaScript are not allowed asset types. Module and renderer metadata must already be registered. A new exporter cannot add game files or register code by renaming it to an image. |
| Engine `apps\server\src\themes\routes.ts:81-130` | The real upload endpoint is operator-only `POST /api/v1/admin/themes/upload`, with same-origin checks, `application/zip`, size limit and importer error reporting. This is theme import, not a complete-game endpoint. Keep its authorization and failure semantics. |
| Engine `apps\server\src\themes\builtins.ts:62-186`; `apps\client\src\themes.ts:15-56`; `tools\install-theme-code.ts:16-92` | Server and client use compiled registrations; neither loads module/skin code from an uploaded ZIP. The code-registration CLI resolves an allowlist of reviewed default factories, not arbitrary package entrypoints, and does not install a Studio game into both running registries. Upload success alone is not playable-code installation. |
| Engine `apps\client\src\game.ts:61-73`; `src\skin-host.ts:57-60` | Live game mounting does not supply a package asset resolver; its default image/audio loader throws. Importer storage of a PNG does not prove that a custom skin can load it. A package-digest-scoped delivery/resolution contract is needed, not Studio's loopback asset URLs. |
| Engine `apps\server\src\runtime\session-lifecycle.ts:88-153,332-409,452-522` | Authoritative startup selects a single `createInitialMap`/generated map and constructs one-map geometry/navigation. The context does not populate `connectedMap`/`connectedMapSpawns`. Startup requires reconnect presence; progression/results require the current level/phase/standings protocol. There is no package-backed campaign catalog or authored exit loader. Local Preview's connected-world option does not establish server support. |
| Engine `apps\server\src\runtime\session-lifecycle.ts:284`; public protocol `GameSettingsSchema` | Match startup parses the Engine's settings schema. Theme manifest JSON settings/defaults are not automatically a game-specific configuration/persistence channel. Tower requires `playerSpeed` and has its own state/results, without that server lifecycle/presence integration. Merely registering its metadata would not make it compatible. |
| Studio `games\sample\.kit-tools\theme_export.mjs` | Existing public-kit consumer exports only `theme.json` and declared media, rejects JSON/JS asset paths, computes hashes/digest and writes a new ZIP exclusively. Reuse after an approved public contract exists; it cannot export saved Studio games now. |
| Studio `studio\server.mjs:603-686`; `src\main.js:1007-1047` | `levelList`/`levelSectionPayload` own independent levels, starting-level identity, active/archive membership, revisions and root metadata; `loadExitLevel`/`exitPreview` validate local destinations and resolved safe arrival. These are existing owners to extend, not filesystem level authorities. Current per-level HTTP calls are not a project-wide consistent snapshot API. |
| Studio `studio\server.mjs:85-143,395-429,535-588`; `games\astraeum-tower\src\design-render.js:23-50` | SQLite owns saved documents, start selection, imported catalogs/credits/hashes; project asset files own imported bytes. Generated `project.json.mapIds` is only a creation receipt. Tower also requires built-in sprite/terrain/prop artwork, source modules/helpers and `assets\provenance.json`; its renderer uses source-relative URLs. Copying a generated project folder alone omits required data/code. |

`settingsDefaults` can contain arbitrary JSON values, but hiding a campaign or
base64 code in that dictionary is **not** a supported workaround: there is no
registered consumer, reference validation, asset/code loader or transactional
campaign installation for it. No new Engine capability is claimed from those
permissive JSON values.

## Original blockers at kit 0.3.0

The current import contract cannot represent and load all active levels and
sections, the designated starting level, boundaries, authored exit references,
game-owned settings and their runtime adapter as one installed revision.
It also cannot install the compatible module/skin code requested in a game ZIP.
Existing `engineApiMajor` and theme/module versions do not express a
package-schema or required SDK version. These are independent blockers even
if all artwork fits the existing media budgets.

For Astraeum specifically, local progression is coordinated by Studio's
controller and `connected-play.js`, not by a portable campaign module.
`src\game.js` owns the current encounter/settings/state/results and
`src\skin.js` owns its HUD/input. Porting them requires game-owned adaptation
to the approved server contract; do not change its chest fixes, rules,
inventory semantics or source/artist credits as a side effect of export.

## Original scoped Engine handoff

Extend/version the **existing theme package family** and public SDK in Engine.
Do not implement a competing Studio-only ZIP format. Engine owns the exact
schema names, entrypoints, authority and code-trust decision. The minimum
handoff acceptance is:

1. Publish a versioned package/campaign schema and validators, with required
   Engine API/SDK compatibility, game/module/skin/state/settings identity and
   checksums covering every declared payload. Preserve legacy media-package
   import behavior. Specify budgets for campaigns, sections, media and code,
   migration/rejection rules and exact actionable errors.
2. Define campaign data and its game-owned document/adapter boundary: stable
   active level/section IDs, signed origins, starting-level ID, root-owned
   boundary/camera metadata, exit destination level/section/start IDs,
   validated gameplay settings, required asset mappings and public credits/
   provenance. Publish a fixture with at least two levels and multiple
   sections, including an archived-root boundary-owner case. Import must
   validate the complete graph and safe starts before installation.
3. Define a reviewed/trusted module and skin artifact installation contract
   for server **and** browser, including dependencies restricted to public
   supported imports. Keep code inert until the Engine-owned review/trust/
   compatibility gate passes; do not simply permit arbitrary uploaded JS in
   the current asset extractor. Preinstalled-code/media-only mode may remain
   supported, but does not fulfill code-in-game-ZIP delivery by itself.
4. Publish revision/digest-scoped asset delivery and `AssetLoader` resolution,
   preserving bytes, credits, hash checks and failure reporting. A registered
   skin must resolve required media without Studio, source checkout paths,
   loopback endpoints or a Vite dev server.
5. Supply a package-backed campaign resolver and authoritative connected-world
   startup/transition contract, retaining section limits, stable world
   coordinates, boundaries and navigation. Specify roster/start assignment,
   input/presence/reconnect, snapshot/version, completion/results and
   transition atomicity. Keep Anh's game-rule decisions separate from these
   hosting contracts; no forced Dots and Squares rules.
6. Atomically stage/validate/install the campaign, assets, credits and approved
   code registration. Test failures before and after promotion so existing
   registry rows, files and runnable revisions survive. Ship public docs,
   declarations and an executable external-consumer fixture in a separately
   authorized versioned kit; Studio must not patch installed packages.

## Studio integration after that contract ships

Extend the existing service/controllers/model adapters, not a parallel backup
exporter. This is a work specification, **not implemented behavior**:

- Add an obvious **Export Game** action. Require Edit mode and resolve
  pending tool gestures/uncertain saves first. Offer **Save then export** or
  **Cancel** for dirty drafts; a failed/conflicting Save blocks export and
  retains its visible error. Do not silently include unsaved edits or discard
  them. Explicitly label the result as the saved project snapshot, not the
  current Play state.
- Capture project identity/credits, designated start, every active independent
  level, active sections, revisions, settings and catalog references in one
  SQLite read transaction. Use `levelList`/`levelSectionPayload` semantics,
  not `project.json.mapIds` or a series of unguarded HTTP reads. Read and
  verify the allowlisted asset bytes against that snapshot's hashes; abort
  on a missing/changed file rather than mixing revisions or yielding a
  partial archive.
- Serialize only active level/section content. Root boundary/camera values
  are level metadata even when the owner section has been removed; preserve
  those required values without exporting that archived section's objects
  or document. Exclude deleted levels, archived sections, old World records,
  databases/WAL/backups/recovery artifacts, secrets, dependencies, installed
  kits, diagnostics, unrelated files and Play-run state. Never ZIP a directory
  recursively to discover content.
- Validate all models/documents, identities, section/world capacities,
  boundaries, required starts, asset/code dependency closure and credits.
  Resolve every exit within the same active campaign to an active section
  and unique safe player start, using the existing destination/geometry
  checks through a headless shared owner rather than creating browser Play.
  Reject dangling/deleted/archived/cross-project or blocked destinations
  before writing ZIP bytes. Include module-required artwork, not just placed
  palette assets; retain the chest-tier and other authored properties.
- Use only the approved public package exporter/schema/checksum contracts
  and compatible game module/skin artifacts. Adapt Tower/Generic under
  `games\<game>\`; place reusable Studio integration under
  `studio\extensions\`. Surface level/section/object/asset-specific errors.
  Do not advertise a downloadable complete game until actual import passes.

## Executed evidence and remaining gates

On 2026-11-17, from the sibling Engine checkout:

```powershell
npm test -- tests\theme-packages.test.ts tests\integration\theme-install.test.ts
```

**11 tests passed across 2 files.** These exercised the actual importer and
in-process upload route using disposable storage, including credited media,
rejected assets/code/registrations, compatibility and install failure cleanup.
They did not start a regular service or test Studio game export.

A separate disposable session probe called the **unchanged installed-kit
`exportTheme`** and passed its exact output to Engine source
`validateAndInstallThemePackage`. **18 checks passed:** exact manifest/required
PNG bytes and credits; asset SHA-256/canonical digest; missing/hash-mismatched
assets; blank credits; incompatible Engine major; unknown module/renderer;
JS/level JSON rejection; unsupported campaign/version root fields; registry
conflict after promotion with registry/files preserved and staging cleaned;
actual sample-module registration rejection; and exporter refusal of JS/JSON
before ZIP creation. It used synthetic fixture credits, a disposable copy of
the Tower herb PNG, and compiled default module/skin metadata, **not a saved
game**. An absent optional asset was correctly omitted.

The media probe ZIP SHA-256 was
`df522de2e78c758f1d4ea1a8ff124975963f691cc5558d836657b44989f0c3f5`;
its canonical `assetsDigest` was
`a25c8c0d69740a7666d550207930b1345b1e6db88a1e987c5b02410cb5503fd8`.
The probe script and JSON result are session artifacts named
`game-export-import-probe.mjs` and `game-export-contract-evidence.json`, not
Studio dependencies; disposable ZIPs/database/installed files were removed.
Initial probe harness attempts required correcting Windows loader URI and
ESM-only public-export resolution before the successful run; no packages were
installed or rebuilt.

**Not verified:** saved-game level/section equality, starting-level/boundary/
exit/settings/code import, asset completeness for a complete game, and
complete-game rollback. There is no supported package representing those
inputs to import. Required next contract tests must round-trip a disposable
two-level/multi-section fixture and compare every active document/identity,
origins, boundary, exits, destination starts, settings, chest tier, asset byte/
credit/hash and code version; inject incompatible versions, dangling exits,
missing assets and post-promotion failures; assert no old state changes.

See the kit 0.4.0 preflight above for which parts of this original handoff
are now available. No local preview, theme-import pass or handoff closes T042.
