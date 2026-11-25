# Packaged engine

This directory is not an engine backend or source checkout.
`developer-kit.lock.json` tracks the selected kit's provenance and local paths.
Ignored `kits\` contains immutable versioned distributions, installed dependency
directories, and retained earlier installations. The legacy 0.1.0 distribution
and its potentially edited sample remain directly under `kits\`; do not discard
them as cache. Ignored `archives\` holds original ZIPs and adjacent checksums.

`games\sample\node_modules` is a Windows junction or Unix symlink to the selected dependency
directory. Setup refuses unexpected targets or ordinary dependency directories;
an explicit upgrade can switch only from the previously receipted target.

The shared baseline versions the immutable 0.4.0 kit ZIP (1,757,632 bytes)
and SHA-256 sidecar in `artifacts\`. This export branch selects the 0.5.0
ZIP (1,765,105 bytes) and sidecar in the same directory. Setup checks the
archive against its sidecar, checks the kit inventory and compares the
resulting receipt with the selected lock.
The 0.4.0 starter snapshot does not match the 0.5.0 lock. See the root
[setup instructions](../README.md#prerequisites-and-setup) before setup or
restore. Registry access is required for Vite tooling. Neither kit is an
Astraeum server release.
