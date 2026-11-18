# Agent guidance

Help Anh use Studio and develop her game. Before answering Studio/game
capability questions or changing this repository, read:

- [`studio/README.md`](studio/README.md): authoritative user guide and
  "How do I...?" index.
- [`studio/docs/DEVELOPMENT.md`](studio/docs/DEVELOPMENT.md): authoritative
  developer/assistant policy, setup, ownership, adaptation, evidence,
  Wednesday checklist and Engine promotion.
- [`studio/docs/ENHANCEMENTS.md`](studio/docs/ENHANCEMENTS.md): capability
  gaps, experimental contracts, tests, limitations and provenance.

For a fresh checkout, follow the root README bootstrap to install the pinned
kit and restore the supplied Astraeum SQLite starter data. Open **Open Game >
Astraeum Tower** and continue its saved levels; do not create a replacement
game or re-import the source game. Developer-data restore is not a complete
Engine game-package/server import. Existing data requires an explicit restore
choice and backup first.

Follow the developer guide's reuse-first decision contract. Read the relevant
current UI/controllers, game modules/settings/examples, selected kit `API.md`
and public package declarations **before answering or implementing**; explain
existing options first, then configure/reuse or extend the existing owner.
Missing game behavior belongs in the game project; reusable experiments in
`studio\extensions\`, with documented Engine handoff when needed.

Never edit installed kit packages or import private Engine-checkout code.
Preserve original imports/credits, unrelated edits and saved designs. Preserve
dirty drafts before reloads/restarts or Vite-served edits, and keep Save errors
visible. Distinguish source confirmation, focused tests, manual verification
and unfinished work; local preview never proves server multiplayer support.
Record compatible kit versions and Git provenance, without claiming an
uncommitted/unpushed change is shipped.

Preserve Astraeum's implemented gameplay and cached opened-chest renderer fix;
see the developer guide's Astraeum chest handoff invariant. Use descriptive
feature branches for future work, preserving the existing branch and unrelated
edits rather than switching/stashing them without authorization.

Keep detailed rules in the authoritative guides, not duplicate assistant
policies here. Publication/deployment and **T042** require separate evidence
and authorization; onboarding does not complete them.
