# Multiplayer Game Studio

Local browser authoring for Anh's game: edit saved designs, import artwork,
try single-player Play/Stop, and export saved Astraeum campaigns using the
selected public Engine APIs.
This is **not** a multiplayer server, universal source-game importer, or
complete-game publishing pipeline.

## Start here

- [Studio user guide and "How do I...?"](studio/README.md): actual controls,
  Astraeum combat/runes, Save and recovery.
- [Developer guide](studio/docs/DEVELOPMENT.md): setup, source/data ownership,
  assistant workflow, adaptation, tests and Wednesday delivery checklist.
- [Enhancement register](studio/docs/ENHANCEMENTS.md): game-specific work,
  reusable prototypes and Engine promotion.
- [Assistant entry points](AGENTS.md) / [Claude](CLAUDE.md).

## Prerequisites and setup

Use Git, **Node.js 24.x**, **npm 11.x**, and a modern browser. On Windows,
open PowerShell. On macOS, open Terminal and ensure `unzip` is available.
An IDE is optional. Run setup from the repository root.

For a fresh checkout, run these commands on either platform:

```sh
git clone --branch main https://github.com/scottzastrow/multiplayer-game-studio.git
cd multiplayer-game-studio
node --version
npm --version
```

### Shared 0.4.0 starter baseline

The shared `main` baseline supplies its Engine kit as a repository artifact:
[kit 0.4.0 ZIP](engine/artifacts/multiplayer-game-developer-kit-0.4.0-6cd1d52906da.zip)
and [SHA-256 sidecar](engine/artifacts/multiplayer-game-developer-kit-0.4.0-6cd1d52906da.zip.sha256).
On a checkout of `main` whose lock selects 0.4.0, bootstrap verifies the ZIP
and uses Windows PowerShell or `unzip` on macOS/Linux. These commands apply
to that baseline, **not to this 0.5.0 export branch**:

```sh
npm run bootstrap -- --archive ./engine/artifacts/multiplayer-game-developer-kit-0.4.0-6cd1d52906da.zip
npm run studio:dev
```

On that baseline, `bootstrap` installs the locked kit and Vite dependencies, then restores the
curated Astraeum editor database from the
[starter-data manifest](starter-data/astraeum/manifest.json). Open **Open Game
> Astraeum Tower** in Studio and continue in its saved levels; do not create a
replacement game or re-import the source game. The starter snapshot
contains 3 active levels and 5 active sections. The current database has no
project-imported artwork rows, so there are no imported asset bytes to include;
the built-in asset catalog/artwork remains in the checked-out game source.
The manifest records source commit `83d9c92efe235d0ecc9d17761212f4401a83359a`,
the dirty working-tree state at capture, Engine kit 0.4.0/revision
`6cd1d52906da084a8c3bc92ca006cf1e6288b326`, kit SHA-256
`62b4b582eee4913277ac9729349f6620e316539ce9056a73bfb98f48aa0cb233`, and
starter-data SHA-256
`a4f53230f2c871818b938c7423f633745a0209b8a0b99fc67546af649620bf89`.

Restore refuses to replace an existing database or colliding imported assets.
On the matching 0.4.0 baseline only, for an intentional replacement, first
Save, stop Studio, and make the choice explicit:

```sh
npm run bootstrap -- --archive ./engine/artifacts/multiplayer-game-developer-kit-0.4.0-6cd1d52906da.zip --replace-existing
```

Before replacement it creates a consistent SQLite backup and preserves
colliding asset files under ignored
`studio\data\starter-restore-backups\<timestamp>\`. `npm run starter:restore`
restores data only; it does not install a kit or import a complete game package
into an authoritative server. A source-game ZIP is a separate, assistant-guided
adaptation workflow. Both payloads are ordinary Git files on `main`
(kit ZIP: 1,757,632 bytes; starter SQLite: 995,328 bytes), not Git LFS pointers
or machine-local dependencies. No separate Release download is required.

### Selected 0.5.0 export kit

This branch's lock and sample dependencies select kit **0.5.0**, Theme SDK
**0.3.0**, Engine revision `d0f46931f56b90298b3209010581a0ffd7f79561`,
archive SHA-256
`e8ce6ecea7da50db34610ee4c54e7a56480c57a1b2ac505dc5c73afb9370d2d1`.
The exact archive and sidecar are supplied as repository artifacts in
`engine/artifacts/`. In a fresh checkout, install the kit and restore the
curated starter with:

```sh
npm run bootstrap -- --archive ./engine/artifacts/multiplayer-game-developer-kit-0.5.0-d0f46931f56b.zip
npm run studio:dev
```

The supplied starter was captured with **0.4.0**; its manifest separately
records **0.5.0** as the verified restore kit. Restore checks that kit's
version, archive hash and Engine revision. The database and original capture
provenance are unchanged. Existing saves are not replaced without an explicit
choice and backup. A previous local
0.5.0 snapshot named a different revision (`1140bd5b4bea432f74f0292c18408441a8ebfd7d`)
and hash (`d165707ec5015fe3617b93158505b756acd9b21bb51a17868b233b117f39bb79`);
it is not the supplied 0.4.0 snapshot or the selected 0.5.0 kit.

Open **http://127.0.0.1:4173**; the loopback API/SQLite service uses **4179**.
Setup installs the packaged dependencies and Vite through the receipted
`games/sample/node_modules` link. Do not run root `npm install` or
`npm ci` in `games\sample`; use setup. Changing kit selection requires a
reviewed, explicit `--upgrade`, not a routine reinstall.

Future changes belong on descriptive feature branches, not directly on `main`.
Preserve the current game, dirty drafts, uncommitted edits and unrelated local
data before switching branches or replacing local data.

**Stop:** first Save and confirm **Saved**, or preserve a dirty draft if Save
fails; then press **Ctrl+C in the terminal that owns `studio:dev`**. The
launcher handles SIGINT/SIGTERM and stops both children. Studio's **Stop**
button only ends Play. Never stop an unknown process or reload a dirty tab.
Preserve drafts before source edits that Vite may reload, too.

| Optional preview (from Git root) | URL | Scope |
| --- | --- | --- |
| `npm run preview` | `http://127.0.0.1:5174` | Editable public-kit sample, not Anh's game |
| `npm run astraeum:dev -- --port 5180 --strictPort` | `http://127.0.0.1:5180` | Standalone first-floor encounter; Studio owns level routing |

End an owned preview with Ctrl+C. Port overrides and restart safety are in
the [setup guide](studio/docs/DEVELOPMENT.md#1-fresh-machine-setup).

**Export status:** the local 0.5.0 implementation exports saved Astraeum
campaigns, not executable game code. A prior endpoint test using a disposable
copy rejected the saved campaign: Level 2 has no authored exit to Level 3.
Explicit rune destinations, not level-list order, determine progression.
The intended destination must be authored and saved deliberately; no saved
campaign ZIP, server import, multiplayer or browser acceptance is established.
See the [export handoff](studio/docs/GAME-EXPORT-HANDOFF.md).

The 0.4.0 committed-checkout evidence in the
[developer handoff](studio/docs/DEVELOPER-HANDOFF-2026-11-18.md) is historical
and does not verify this merged worktree. CI's runtime job installs the selected
0.5.0 artifact and verifies its checksum and kit inventory. Saved designs
normally live in ignored SQLite storage;
the curated onboarding snapshot is a separate, tracked exception.
**T042 remains open.**

Publication evidence, data comparison, exact source/artifact provenance and
remaining gates are recorded in the
[developer handoff](studio/docs/DEVELOPER-HANDOFF-2026-11-18.md).
