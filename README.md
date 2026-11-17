# multiplayer-game-studio

Open the **inner Git root** in IntelliJ: `multiplayer-game-studio\multiplayer-game-studio`
relative to the parent of the outer workspace, not the outer scaffold folder.
The repository has not been renamed. Its outer IntelliJ/Java scaffold is
unchanged and is not Studio source.

## Repository layout

| Directory | Purpose |
| --- | --- |
| `engine\` | Packaged runtime/SDK, tracked `developer-kit.lock.json`, ignored versioned `kits\` and verified `archives\`. No backend/source checkout. |
| `studio\` | Local map editor and project-scoped SQLite design store. |
| `games\sample\` | Tracked editable Local Preview Sample and required tooling; not Anh's adapted game. |
| `games\astraeum-tower\` | Astraeum game code, assets, metadata and Floor 1 import template. Saved designs live in Studio's SQLite database. |
| `games\generic-grid-v1\` | Independent, versioned blank-grid model and public movement-preview adapter. New Game creates separate project directories; maps remain in SQLite. |
| `reference\` | Reserved for untouched original game sources when supplied; none supplied yet. |
| `data\` | Ignored future local databases/recovery files; Studio currently uses `studio\data\`. |
| `exports\` | Ignored generated exports; sample theme ZIPs are assets/manifests, not playable games. |
| `tools\` | Studio setup/upgrade script. |

Builds (`dist\`), dependency installations (`node_modules\`), local databases,
archives and generated exports are ignored. Directory READMEs and the kit
receipt remain tracked. Every prior kit installation was retained under
`engine\kits\`, including both versioned 0.2.0 distributions and the legacy
0.1.0 files/sample at that directory's top level. Do not treat potentially
edited legacy sample files as disposable cache.

## Local Developer Kit preview

The local Developer Kit provides an editable, single-player browser preview using
the bundled public game packages. It does not start the multiplayer backend or
require an engine checkout. The kit is kept under the ignored
`engine\kits\` directory and is not committed.

Kit 0.3.0 keeps immutable dependencies in a versioned subdirectory there and
editable files in `games\sample\`, outside the ignored kit directory. Previous
versioned installations are retained on upgrade. Run these commands from this
**Git root** (`multiplayer-game-studio\multiplayer-game-studio`), not its outer
IntelliJ folder:

```powershell
npm run setup -- --archive .\engine\archives\multiplayer-game-developer-kit-0.3.0-dca3ffc4561c.zip
npm run verify
npm run build
npm run preview
# With the preview running and a local Chrome DevTools endpoint at port 9223:
npm run browser:smoke
```

Keep the adjacent `.zip.sha256` file with the archive. Setup validates ZIP and
file checksums, writes `engine\developer-kit.lock.json` provenance and installs local
package tarballs. Registry access is needed for lockfile-pinned Vite tooling.
Rerunning setup reinstalls dependencies without replacing editable starter
files; changing kit selection requires an explicit reviewed upgrade:

```powershell
npm run setup -- --archive <reviewed-kit.zip> --upgrade
```

The sample's `node_modules\` junction targets the receipted dependency directory
under `engine\kits\`. Setup rejects ordinary directories and unexpected junction
targets (including dangling unexpected links) before modifying sample manifests
or installing dependencies. Only an explicit upgrade may switch from the
previously receipted target. Do not run `npm ci` directly in `games\sample\`;
use root setup to reinstall the packaged dependencies.

Open `http://127.0.0.1:5174`. Edit `games\sample\src\settings.js` (`moveDistance`,
`facingMovementBlend` 0-1, default 0.40) or module/map/skin files; Vite reloads
them. Choose Keyboard Only (WASD/arrow turning/Space), Keyboard + Mouse
(arrows/pointer/left click), or Game Controller (left/right sticks/right trigger)
and focus the map. East/west/Stop buttons remain available. Blur and controller
disconnect clear input. The sample's shot counter is not combat.
Controller simulation is automated; physical hardware remains unverified.
No preview runtime imports the engine checkout or starts its backend.

## Studio New Game and Open Game

Run `npm run studio:dev`, then open `http://127.0.0.1:4173`.
**New Game** beside **Open Game** collects the game name and author/credits;
every new game starts with a fixed 2048 x 2048 pixel world. It creates a blank
Generic Grid v1 game with two safe player starts, primitive
placement tools and a simple public-runtime movement preview, not a copy of
Astraeum. Gameplay camera zoom is saved with each level and independent of the
editor zoom; at its default 1.0, Generic Play follows the player at 1:1
world-to-CSS-pixel scale. Duplicate names are rejected and
unsaved edits are protected.
Save/Ctrl+S writes the selected map to SQLite; Open Game reopens it after
restart. The workbench **Levels** panel lists only the selected game's levels:
open, add blank, duplicate, rename, choose the starting level, and confirm
soft-delete with recovery. Switching protects unsaved edits. At least one
active level must remain; deleting the start requires a replacement in the
same game. Blank levels use the existing model, assets and settings, never a
copy of Floor 1. Play includes unsaved edits from the selected level and Stop
returns without saving movement. Multi-section levels use the public connected
runtime for keyboard movement, camera and collision; existing single-section
gameplay remains unchanged. Native-browser connected acceptance is still
blocked at startup; see `studio/docs/DEVELOPMENT.md` for current evidence.
Generated `games/<project-id>/` directories contain code, assets and metadata,
not duplicate maps. **Import Assets** accepts PNGs and PixelLab ZIPs into
project-scoped catalogs; source bytes and credits are preserved, and imported
artwork remains visual-only. Imported pixels map one-to-one to world pixels;
transparent margins can make the visible artwork look smaller than its placed
bounds. Game export and PixelLab API integration remain separate milestones.
See `studio/README.md` for safety limits and verification details. T042 stays
open.

`npm run studio:levels:smoke` verifies level management through the actual UI
using direct CDP, disposable SQLite/files and its own Chrome profile; it does
not require an IDE debugger. Level transitions, generation, area-fill tools,
audio and shared libraries remain future work.

### Kit provenance and controller support

The supplied ZIP SHA-256 is
`afd63a865a23b60183d7be89c15811f68438a0186638caa509fb541bc3492517`.
In `kit.json`, `engineRevision` (`dca3ffc4561c14e0e83968afceabf0e85cddc565`)
identifies the exact committed engine revision used to build the kit.
`engineSource.state` is `committed`, and `changedInputs` is empty; the manifest
records SHA-256 hashes for the tracked package, sample, and builder inputs.
The kit is version 0.3.0; its included public npm packages remain version 0.1.0.

The included `@multiplayer-game/theme-sdk` package actually exports
`readStandardGamepad`; it accepts connected standard-mapped pads, reads left
stick axes 0/1 for movement and right stick axes 2/3 for aim, applies a 0.15
radial deadzone, and reads right trigger button 7 for fire (pressed or value at
least 0.5). The sample's Game Controller mode uses that adapter and the public
`MovementController`. Keyboard and mouse modes are sample-skin behavior, not
additional gamepad SDK APIs. Browser smoke testing simulates a standard pad and
checks movement magnitude/steering, aim/fire, disconnect neutralization, and
focus-loss handling; this does not verify physical hardware.

Requires Node.js 24 LTS and npm 11. The retained **legacy 0.1.0** sample remains
available separately (its editable files were inside the ignored kit):

```powershell
node .\engine\kits\tools\checksums.mjs
Set-Location .\engine\kits\sample
npm ci --no-audit --no-fund
npm run verify
npm run build
```

Start the playable preview from the sample directory:

```powershell
npm run dev -- --port 5174 --strictPort
```

Open `http://127.0.0.1:5174`. The sample supports east/west movement and Stop;
the wall blocks eastward travel. Edit `src\game.js` (for example,
`SPEED_MULTIPLIER`) to customize gameplay; Vite reloads changes. Map, settings,
and skin are also editable. `npm ci` uses the kit's local package tarballs and
the lockfile-pinned Vite tooling (which requires npm registry access).

The preview is for local development only, not a deployed or authoritative
multiplayer game. T031 and T042 remain open.
