# Astraeum developer starter data

This is a curated editor-data snapshot, not a live database, source template,
complete-game ZIP or server import. Restore it with the root
[bootstrap instructions](../../README.md#prerequisites-and-setup), then choose
**Open Game > Astraeum Tower**. Do not recreate or re-import the game.

`manifest.json` records the actual capture: source HEAD
`83d9c92efe235d0ecc9d17761212f4401a83359a`, branch
`feature/game-export-contract`, with uncommitted changes present. That is
capture provenance, not the commit containing the completed source.
The [handoff](../../studio/docs/DEVELOPER-HANDOFF-2026-11-18.md) identifies the
subsequent source commits and verification.

| Payload | Bytes | SHA-256 |
| --- | ---: | --- |
| `studio.sqlite` | 995328 | `f010460fff94961b87be7810a91542a39c4069356f6a1b32f8867a339aa4b1bb` |
| Canonical database + asset payload | | `a4f53230f2c871818b938c7423f633745a0209b8a0b99fc67546af649620bf89` |

The canonical hash is SHA-256 of sorted `path + NUL + file SHA-256 + LF`
records for the database and declared imported asset files, not a ZIP hash.
The database contains 3 active levels, 5 section documents, their membership
and saved starting level. Retained rows were compared against a consistent
online backup of the live database. No project name/author record was
fabricated: the source has no Astraeum `projects` row.

There are no imported asset/catalog rows in this capture. The 17 required
built-in PNGs and their original credits/hashes are already versioned under
`games\astraeum-tower\assets\`; no local reference folder is required to run.
Other projects, deleted levels, section archives, World workspace records,
save receipts, migrations, diagnostics and recovery backups are excluded.
The filtered copy was vacuumed before hashing.

`npm run starter:test` covers a fresh restore, exact checksums, refusal to
overwrite existing data/sidecars, explicit replacement with a consistent
backup, and rejection of corruption before touching existing storage.
Replacement is only supported after saving and stopping Studio.
