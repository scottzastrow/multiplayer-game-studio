# Developer handoff - 2026-11-18

Branch: `handoff/astraeum-developer-2026-11-18`, for review against `main`.
No merge, deployment, server game installation or T042 closure is authorized
or implied. The PR commit list is the publication record.

## Source and review scope

| Commit | Scope |
| --- | --- |
| `10cc7d5e8b15108338196483efcc4ea56a4e7eac` | Completed Astraeum progression, pickups/chest tiers and cached opened-chest rendering; behavior-first Inspector, empty-level/section drafts, Save errors, focused tests and original artwork provenance |
| `701a4a11e16b5bc0a0eb190cf05a74136dff25bd` | Pinned downloadable kit, curated starter data, safe bootstrap/restore, isolated startup/safety tests and internal Dots fixture package builder |

These extend source HEAD `83d9c92efe235d0ecc9d17761212f4401a83359a`.
The base already has 17 relevant Studio/game commits beyond remote `main`
`a4ca8557595652f034f1de02cd1184d29d22419d`; they are retained rather than
squashed or rewritten. This document and the authoritative onboarding guides
are committed separately from executable source/data.

Read-only review covered gameplay/progression, the cached chest renderer,
empty drafts, persistence, Inspector and tests. It found an unfinished
Astraeum export action/adapter inconsistent with kit 0.4.0. That draft was
excluded from this branch; only the internal, tested Dots fixture builder
remains. Stale E/controller-X prompts were corrected to automatic rune entry
and nearby chest opening. The Fill controller test fixture was brought up to
date with the existing history and diagnostic dependencies.

The original checkout remains on `feature/game-export-contract` with its
uncommitted work, generated Gopher game, original reference copy and IDE files
untouched. No live Vite-served source was edited, browser tab driven, dirty
draft saved/discarded/reloaded, or original Studio process restarted/stopped.
The draft is preserved in place; this does not claim a new browser draft
export or autosave. All implementation and verification used separate
worktree/clone directories.

## Consistent live-data comparison

The pre-start backup `pre-kit-040-upgrade-20261117.sqlite` and active
`studio.sqlite` were opened with SQLite `mode=ro` connections and copied using
the online backup API. Integrity checks passed on both consistent snapshots.
Schema and every logical Astraeum row in all 14 project-owned tables were
compared, including deleted maps, archived sections, revisions, timestamps,
save receipts, World records and migration/backups. JSON columns were decoded
before comparison; BLOBs were represented by length and SHA-256.

**Result: zero added, removed or changed Astraeum records.** No logical
Astraeum change attributable to the accidental startup was found. The
canonical logical SHA-256 was identical:
`0d818c17a7c9f1f68a6d0b9fae8ebb0f355546ecb24e4c9a8a31b79ba90c1284`.
This is not a SQLite-file checksum or a claim about unrelated projects.
Byte equality was neither required nor used for the active WAL database.
No live database, WAL/SHM, comparison snapshots or recovery/diagnostic output
is included in the branch.

Every retained starter row in maps, level membership/sets, starting-level and
asset/project tables was also compared with that consistent live snapshot.
They match exactly; filtering removed only the documented excluded records.

## Downloadable artifacts and provenance

Both payloads are ordinary files in this public repository, small enough for
Git; no Git LFS, private disk path, separate release or Engine checkout is
needed. Use the handoff branch until it is reviewed and merged by the owner.

| Artifact at immutable commit `701a4a11e16b5bc0a0eb190cf05a74136dff25bd` | Bytes | SHA-256 |
| --- | ---: | --- |
| [Kit ZIP](https://raw.githubusercontent.com/scottzastrow/multiplayer-game-studio/701a4a11e16b5bc0a0eb190cf05a74136dff25bd/engine/artifacts/multiplayer-game-developer-kit-0.4.0-6cd1d52906da.zip) | 1757632 | `62b4b582eee4913277ac9729349f6620e316539ce9056a73bfb98f48aa0cb233` |
| [Starter SQLite](https://raw.githubusercontent.com/scottzastrow/multiplayer-game-studio/701a4a11e16b5bc0a0eb190cf05a74136dff25bd/starter-data/astraeum/studio.sqlite) | 995328 | `f010460fff94961b87be7810a91542a39c4069356f6a1b32f8867a339aa4b1bb` |

The kit [sidecar](../../engine/artifacts/multiplayer-game-developer-kit-0.4.0-6cd1d52906da.zip.sha256),
[receipt](../../engine/developer-kit.lock.json) and 50 internal checksums
identify kit 0.4.0 / Theme SDK 0.2.0 / Protocol and Local Preview 0.1.0,
Engine `6cd1d52906da084a8c3bc92ca006cf1e6288b326`, source state `committed`.
Companion tooling provenance remains
`scottzastrow/multiplayer-game-themes@778319f578b25081420e3334e1e68fa4de7540ec`;
reused tooling was not rebuilt from an unavailable companion checkout.

The starter [manifest](../../starter-data/astraeum/manifest.json) records the
actual dirty-tree capture at source HEAD `83d9c92efe235d0ecc9d17761212f4401a83359a`,
not the later commit containing the completed implementation. Its canonical
database-plus-imported-assets hash is
`a4f53230f2c871818b938c7423f633745a0209b8a0b99fc67546af649620bf89`.
It contains 3 active levels, 5 section documents, saved starting-level
metadata, no imported assets and no fabricated project/author row. It was
filtered/vacuumed before hashing. See the [payload notes](../../starter-data/astraeum/README.md).

All 17 built-in PNG hashes were checked against both the versioned files and
their original embedded bytes. Original supplied source document:
`reference\astraeum-tower-original\dungeon\index.html`, 1,000,112 bytes,
SHA-256 `ea6d26341cbdf71a80980b846c24fb649512cbabd63e7295e70a3a74a38e9d27`.
The untouched reference is retained locally, not distributed or required at
runtime. [Artwork provenance](../../games/astraeum-tower/assets/provenance.json)
retains Anh Nguyen (PixelLab), the project credit, source locations and every
per-file hash without transforming the artwork.

## Committed fresh-checkout verification

Executable source/data commit `701a4a11e16b5bc0a0eb190cf05a74136dff25bd` was
cloned with `git clone --no-local` into a separate Git repository. It did not
copy the working tree, ignored dependency junctions or live storage.
Node 24.11.0 / npm 11.6.1 ran the documented bootstrap from an explicit
checkout-root working directory. All 50 kit checksums and starter checksums
passed.

`npm run studio:handoff:test` started its own API and Vite processes with
explicit cwd, API port **51473**, web port **51474**, and
`studio\data\handoff-test-y2r3DW\` database/games storage in that fresh clone.
It checked the UI, proxy, browser module, chest PNG, only Astraeum's
3 active levels / 5 sections and saved start, and unchanged logical database
records after read-only startup. Both owned processes and disposable startup
storage were cleaned up. The original ports 4173/4179 were not used.

Passed from that committed fresh clone:

```powershell
npm run starter:test
npm run studio:handoff:test
npm run astraeum:combat:test
npm run astraeum:progression:test
npm run astraeum:interactions:test
npm run studio:connected-play:test
npm run studio:apply:test
npm run studio:persistence:test
npm run studio:boundaries:test
npm run studio:paint:test
npm run studio:runtime-sections:test
npm run studio:game-package:test
node studio\scripts\fill-test.mjs
node studio\scripts\world-terrain-test.mjs
npm run verify
npm run build
node games\sample\node_modules\vite\bin\vite.js build --config studio\vite.config.js --outDir ..\studio\data\handoff-build
```

Git-normalized tracked content was unchanged after setup/tests. On Windows,
setup can rewrite the receipt/sample JSON files with LF rather than checkout
CRLF, producing status-only line-ending notices but no content diff.
Vite's Zod annotation warnings and Node's experimental SQLite warning were
non-fatal. Build output and all test evidence remain ignored/unpublished.

For Anh's exact clone/bootstrap/open steps, use the [root guide](../../README.md#prerequisites-and-setup).
For another disposable verification, run `starter:test` and
`studio:handoff:test` immediately after bootstrap in a fresh checkout; do not
aim it at an existing user's working database. Existing-data replacement
requires Save, stop and the explicit restore choice; it makes a consistent
backup first.

## Remaining limitations

The legacy `studio:world:test` CDP flow was attempted only in the isolated
candidate with its own ports/profile/storage; it timed out on the retired
`#worlds-button`. It is not a browser-acceptance pass and was not retried.
`studio:assets:test` was blocked by the absent external `STUDIO_GOPHER_ZIP`
fixture. That unrelated game/fixture is not bundled into this handoff.
These are distinct from the passing focused persistence, runtime and event
tests above.

Native-browser connected Play/progression acceptance, physical-controller
hardware, complete Astraeum game export/import, package media resolution,
authoritative campaign transitions, two-client multiplayer and deployment
remain unverified or unsupported as documented in the
[Engine contract handoff](GAME-EXPORT-HANDOFF.md).
An HTTP startup test, successful build or local preview does not satisfy those
gates. **T042 stays open.**
