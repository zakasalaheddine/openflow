# Phase 4 — MCP Server *(optional)*

**Reference:** build-plan §8 week 4.

Only start this after Phase 3 has shipped. It is a bonus, not a dependency.

Thin tools over `/core`. If Phase 1's eslint boundary rule held, this phase is nearly free — that rule was paying for this all along.

## Build

- [ ] `create_flow`, `set_anchor`, `add_node`, `wire`, `run_flow`, `list_outputs`
- [ ] Each tool wraps an existing `/core` function. **No new business logic in the MCP layer** — if a tool needs behaviour `/core` lacks, add it to `/core` with a unit test and call it from both surfaces.

## TDD units

**`test/unit/mcp-tools.test.ts`**
- each tool validates its arguments and rejects malformed input with a usable error
- `wire` enforces the same capability gating as the canvas — one gate function, two callers, so the two surfaces cannot diverge
- `add_node` rejects a node type outside the four
- `run_flow` respects the spend cap

## Acceptance

**`test/acceptance/mcp-authoring.test.ts`**
- a sequence of tool calls builds a flow identical to one built through the canvas
- that flow runs through the same executor and produces the same `input_hash` values

That last assertion is the whole point: same core, two front doors. If the hashes differ, the MCP layer has grown logic it shouldn't have.

## Gate

Claude authors a valid multi-node flow end to end through the tools, and it runs.

Language for structure, eyes for judgment — MCP is an **authoring** surface, not a review surface. Do not add tools that ask Claude to evaluate output quality.
