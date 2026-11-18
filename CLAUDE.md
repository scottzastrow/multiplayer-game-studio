# Claude

Read and follow [`AGENTS.md`](AGENTS.md) before answering Studio/game
questions or making changes. It is the compatible assistant entry point;
there is no separate Claude implementation policy.

For a fresh checkout, use the root README bootstrap to install the pinned kit
and restore the supplied Astraeum SQLite starter data. Open the existing game
through **Open Game > Astraeum Tower**; do not recreate or re-import it.
Developer-data restoration is separate from importing a complete Engine game
package into a server. Existing local data must be explicitly backed up before
an intentional replacement.

Use [`studio/README.md`](studio/README.md) for Anh's "How do I...?" questions
and [`studio/docs/DEVELOPMENT.md`](studio/docs/DEVELOPMENT.md) for development,
API reuse, adaptation, evidence, data safety and Wednesday delivery.
Inspect the relevant implementation, settings/examples and the selected kit's
public API/declarations before explaining availability or coding. Explain
supported options first; follow the shared supported/partial/missing decision
contract and track API gaps in
[`ENHANCEMENTS.md`](studio/docs/ENHANCEMENTS.md).

For onboarding rule choices, use the shared
[multiplayer decision discussion](studio/docs/DEVELOPMENT.md#multiplayer-game-rule-discussion-with-anh):
explain support and tradeoffs, offer the optional Dots and Squares baseline,
and let Anh decide before implementing; do not impose it on Astraeum.

Preserve Astraeum's current gameplay and cached opened-chest rendering fix.
Future work belongs on descriptive feature branches; do not switch away from
existing edits or user data. Follow the detailed chest and Git handoff rules
in the developer guide.

Keep these guides authoritative rather than inventing parallel instructions.
Do not edit installed Engine packages, lose dirty drafts/original credits,
hide Save failures, or describe local preview as proven multiplayer/export/
server delivery. Preserve existing work and leave T042 open unless separately
authorized and actually verified.
