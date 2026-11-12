# multiplayer-game-studio

## Local Developer Kit preview

The local Developer Kit provides an editable, single-player browser preview using
the bundled public game packages. It does not start the multiplayer backend or
require an engine checkout. The kit is kept under the ignored
`var\developer-kit\` directory and is not committed.

Kit 0.2.0 keeps immutable dependencies in a versioned subdirectory there and
editable files in `starter\`, outside the ignored kit directory. Previous
versioned installations are retained on upgrade. Run these commands from this
**Git root** (`multiplayer-game-studio\multiplayer-game-studio`), not its outer
IntelliJ folder:

```powershell
npm run setup -- --archive <path-to-kit-0.2.0.zip>
npm run verify
npm run build
npm run preview
```

Keep the adjacent `.zip.sha256` file with the archive. Setup validates ZIP and
file checksums, writes `developer-kit.lock.json` provenance and installs local
package tarballs. Registry access is needed for lockfile-pinned Vite tooling.
Rerunning setup reinstalls dependencies without replacing editable starter
files; changing kit selection requires an explicit reviewed upgrade.

Open `http://127.0.0.1:5174`. Edit `starter\src\settings.js` (`moveDistance`,
`facingMovementBlend` 0-1, default 0.40) or module/map/skin files; Vite reloads
them. Choose Keyboard Only (WASD/arrow turning/Space), Keyboard + Mouse
(arrows/pointer/left click), or Game Controller (left/right sticks/right trigger)
and focus the map. East/west/Stop buttons remain available. Blur and controller
disconnect clear input. The sample's shot counter is not combat.
Controller simulation is automated; physical hardware remains unverified.
No preview runtime imports the engine checkout or starts its backend.

### Kit provenance and controller support

The supplied ZIP SHA-256 is
`dd5a978c54dc951dd48d767379482f8a28dbbdb0318866c73a7527459281218d`.
In `kit.json`, `engineRevision` (`2717a9bc86c2b8db0865a2e37cffa609b0f8a208`)
identifies the exact committed engine revision used to build the kit.
`engineSource.state` is `committed`, and `changedInputs` is empty; the manifest
records SHA-256 hashes for the tracked package, sample, and builder inputs.
The kit is version 0.2.0; its included public npm packages are version 0.1.0.

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
node .\var\developer-kit\tools\checksums.mjs
Set-Location .\var\developer-kit\sample
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
