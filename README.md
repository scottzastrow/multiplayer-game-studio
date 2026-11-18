# Multiplayer Game Studio

Local browser authoring for Anh's game: edit saved designs, import artwork,
and try single-player Play/Stop using the packaged public Engine APIs.
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

Use Windows PowerShell, Git, **Node.js 24.x** and **npm 11.x**. Use a modern
Canvas-capable browser for Studio. Chrome/CDP is needed only for separately
authorized browser checks, not to start Studio. An IDE debugger is optional.
Commands run from the Git root containing this `package.json`, not an outer
IDE/scaffold folder.

```powershell
git clone --branch handoff/astraeum-developer-2026-11-18 https://github.com/scottzastrow/multiplayer-game-studio.git
Set-Location .\multiplayer-game-studio
node --version
npm --version
```

The pinned Engine kit is supplied as a downloadable repository artifact:
[kit 0.4.0 ZIP](engine/artifacts/multiplayer-game-developer-kit-0.4.0-6cd1d52906da.zip)
and [SHA-256 sidecar](engine/artifacts/multiplayer-game-developer-kit-0.4.0-6cd1d52906da.zip.sha256).
The lock file is authoritative; verify the artifact before installing:

```powershell
Get-FileHash .\engine\artifacts\multiplayer-game-developer-kit-0.4.0-6cd1d52906da.zip -Algorithm SHA256
npm run bootstrap -- --archive .\engine\artifacts\multiplayer-game-developer-kit-0.4.0-6cd1d52906da.zip
node .\engine\kits\0.4.0-6cd1d52906da\tools\checksums.mjs
npm run studio:dev
```

`bootstrap` installs the locked kit and Vite dependencies, then restores the
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

The restore command refuses to replace an existing database or colliding
imported assets. For an intentional restore over existing local data, first
Save, stop Studio, then make the choice explicit:

```powershell
npm run bootstrap -- --archive .\engine\artifacts\multiplayer-game-developer-kit-0.4.0-6cd1d52906da.zip --replace-existing
```

Before replacement it creates a consistent SQLite backup and preserves
colliding asset files under ignored
`studio\data\starter-restore-backups\<timestamp>\`. `npm run starter:restore`
restores data only; it does not install a kit or import a complete game package
into an authoritative server. A source-game ZIP is a separate, assistant-guided
adaptation workflow. Both payloads are ordinary Git files in the handoff branch
(kit ZIP: 1,757,632 bytes; starter SQLite: 995,328 bytes), not Git LFS pointers
or machine-local dependencies. No separate Release download is required.

Open **http://127.0.0.1:4173**; the loopback API/SQLite service uses **4179**.
Setup installs the packaged dependencies and Vite through the receipted
`games\sample\node_modules` junction. Do not run root `npm install` or
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

**Compatibility/evidence:** kit **0.4.0**, Theme SDK **0.2.0**, Protocol and
Local Preview **0.1.0**, Engine revision
`6cd1d52906da084a8c3bc92ca006cf1e6288b326`. The lock file records archive
hashes and companion Git provenance. The committed-checkout verification
commands are `npm run starter:test` and `npm run studio:handoff:test` after
bootstrap. The latter uses an explicit working directory, disposable
ports/storage and checks that read-only startup does not change logical
records. This is separate from browser
acceptance; see the
[evidence/status guide](studio/README.md#evidence-and-unfinished-features) for
manual confirmations, focused checks and browser gaps. Saved designs normally
live in ignored SQLite storage; the curated onboarding snapshot is the
documented starter-data exception, not the Floor 1 source template.
**T042 remains open.**

Publication evidence, data comparison, exact source/artifact provenance and
remaining gates are recorded in the
[developer handoff](studio/docs/DEVELOPER-HANDOFF-2026-11-18.md).
