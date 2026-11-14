# Packaged engine

This directory is not an engine backend or source checkout.
`developer-kit.lock.json` tracks the selected kit's provenance and local paths.
Ignored `kits\` contains immutable versioned distributions, installed dependency
directories, and retained earlier installations. The legacy 0.1.0 distribution
and its potentially edited sample remain directly under `kits\`; do not discard
them as cache. Ignored `archives\` holds original ZIPs and adjacent checksums.

`games\sample\node_modules` is a Windows junction to the selected dependency
directory. Setup refuses unexpected targets or ordinary dependency directories;
an explicit upgrade can switch only from the previously receipted target.
