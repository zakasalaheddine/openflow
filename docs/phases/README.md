# Phases

Execution order for [`build-plan.md`](../build-plan.md). One document per phase; each is a checklist with a hard exit gate.

Read [`../testing-strategy.md`](../testing-strategy.md) first — it defines the TDD loop, the fal fixture seam, and the CI rule that keeps earlier phases from breaking.

| Phase | Doc | Gate |
|---|---|---|
| 0 | [Validation spike](./phase-0-spike.md) | ≥70% anchor consistency, written into `FINDINGS.md` |
| 1 | [Core, headless](./phase-1-core.md) | JSON graph → images on disk; re-run costs $0; survives a kill |
| 2 | [Canvas](./phase-2-canvas.md) | Build the 3-image → 9-video serum graph from empty, no JSON |
| 3 | [Video, export, ship](./phase-3-video-export-ship.md) | Repo is public |
| 4 | [MCP server](./phase-4-mcp.md) *(optional)* | Claude authors a valid flow end to end |

## Rules

**Gates are binary.** A phase is not done because its checklist is ticked; it is done when its gate test passes in CI. The gates are lifted verbatim from the build plan's "Done when" lines and exist here as named, executable specs.

**Tests are cumulative.** Phase N never edits Phase N-1's tests to go green. If an old test is genuinely wrong, that is its own commit with a reason.

**Phase 0 gates the rest.** If anchor consistency lands below 40%, stop — the product changes shape (§2 of the build plan). Do not start Phase 1 on hope.

**Week 3 ships regardless.** Public at the end of Phase 3, finished or not. If Phase 1 slips, cut a node type; do not extend the schedule.
