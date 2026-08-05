# Agent core — a chat agent that authors the graph

**Date:** 2026-08-05
**Status:** design approved, awaiting spec review
**Scope:** sub-project 1 of 3

## Why

Today the only way to get a model to build a flow is the brief bar: one shot,
one template, no conversation. You cannot say "make shot 2 a 9:16 variant" or
"drop the third clip and add a close-up". Every correction is a full re-brief.

This replaces it with a chat agent that edits the graph incrementally through
tools, powered by OpenRouter via ai-sdk.

## Decomposition

This design covers sub-project 1 only. Each of the other two gets its own
spec → plan → implementation cycle.

| # | Sub-project | Ships |
|---|---|---|
| **1** | **Agent core** — OpenRouter via ai-sdk behind the existing `LLM_MODE` seam, tools over `/core`, chat loop, side panel | "add a hero shot of the serum on marble" builds real nodes |
| 2 | Skills — `flows/skills/*.md`, loaded by relevance | the agent writes model-aware prompts, not generic ones |
| 3 | Assets in chat — drop a file, vision pass, description stored on the source row | upload and it builds |

## Decisions

Each of these was chosen deliberately; the alternative is recorded so a future
reader knows it was considered.

### The agent authors. It never spends.

`README.md` lists **"No agent loop. LLMs sit at the edges — brand profile,
brief→flow — never in the execution path."** as a non-goal.

A chat agent that authors the graph stays inside that non-goal, because what the
non-goal protects is the invoice: the agent writes `graph_json` and nothing
else. Run remains a deliberate human click, and `previewRun` still shows the
per-node cost before you make it.

There is no `run_flow` tool. Not gated, not capped — absent.

### Free-form topology, templates as an opening move

`core/brief.ts` refuses arbitrary topology on purpose:

> *A model that can emit arbitrary graphs can emit a graph that renders forty
> video nodes at hero prices, and the first anyone hears of it is the invoice.*

The agent calling `add_node` and `wire` freely **is** arbitrary topology. The
trade is accepted, and the reason it is safe is the decision above: the cap
moves from authoring time (a fixed template set) to run time (the spend cap in
`/api/run`, plus the cost shown per node before you commit).

`flows/templates/` and `buildFlowFromBrief` survive as the `apply_template`
tool — a good opening move, no longer the only move.

### Incremental tool calls, not whole-graph proposals

The rejected alternative was one `propose_flow` tool returning a complete graph
for the user to accept as a diff. Atomic review, fewer tools — but every edit
re-emits the whole graph, so "tweak shot 2's prompt" becomes a full rewrite the
model can get wrong elsewhere.

The rejected alternative to *that* was building the Phase 4 MCP server first and
pointing a chat client at it. That is the same tool surface with an extra
process and a protocol hop, for no in-app benefit. MCP can wrap these same
`/core` functions later, free.

## Architecture

```
chat panel (client)  ──►  /api/chat  ──►  src/agent/
                                            loop.ts    streamText + stopWhen
                                            tools.ts   thin wrappers over /core
                                            prompt.ts  system prompt
                                              │
                              src/models/llm.ts  ← OpenRouter, off|replay|live
                                              │
                                            /core  (unchanged)
```

`/core` gains nothing. Every tool loads the graph, calls the existing core
function, and writes back through `saveGraph`. This is the rule
`docs/phases/phase-4-mcp.md` already sets for the MCP layer:

> *No new business logic in the MCP layer — if a tool needs behaviour `/core`
> lacks, add it to `/core` with a unit test and call it from both surfaces.*

Same rule, one more front door.

### Tools

| Tool | Wraps |
|---|---|
| `list_graph` | the read half of `/api/flow` GET — nodes, edges, sources, per-node estimate |
| `add_node` | `nodeSchema` validation + `freeSlot` from `src/app/slots.ts` |
| `update_node` | patch `prompt` / `label` / `modelRole` / `durationSec` / `formats` |
| `delete_node` | `removeNode` |
| `wire` | **`applyWire`** |
| `unwire` | `removeEdge` |
| `apply_template` | `buildFlowFromBrief` |
| `list_sources` | `listSources` |

`wire` calls `applyWire` directly — the same function `canvas.tsx` calls, not a
copy. `applyWire` is where `assertAnchorsSupported`, the single-start-frame
rule, and the cycle check live; a second implementation would drift and the two
surfaces would disagree about what is legal.

`src/app/slots.ts` imports only a type from `/core`, so `freeSlot` is safe to
call server-side. No new placement logic.

From the Phase 4 list, `run_flow` is deliberately absent (see above),
`create_flow` is unnecessary (one workspace, one flow), and `set_anchor` is
obsolete — anchors became wires in the canvas work.

### Deleted

- `@anthropic-ai/sdk` → `ai` + `@openrouter/ai-sdk-provider`. One client, not two.
- `briefPrompt()` in `core/brief.ts` — the agent's system prompt lists the
  templates itself. `loadTemplates`, `briefResponseSchema` and
  `buildFlowFromBrief` all stay, called by `apply_template`.
- `/api/brief` POST and `submitBrief()` in `src/app/state.ts`. GET and PATCH
  stay: the brand profile is still a field a human confirms.
- The Brief chip and its dialog in `src/app/canvas.tsx` (`openBrief`,
  `runBrief`, the `brief` state). The dialog's brand-profile textarea moves to a
  collapsible field at the top of the chat panel, still calling `fetchBrief` and
  `saveBrandProfile` — the profile is written by a person, never by the model,
  and that does not change.

### Added

`src/agent/loop.ts`, `src/agent/tools.ts`, `src/agent/prompt.ts`,
`src/app/api/chat/route.ts`, a chat panel component, and one `messages` table in
`src/db/index.ts`'s DDL (`id`, `flow_id`, `role`, `content` JSON, `created_at`).

## Data flow

1. You type. `POST /api/chat` with the message.
2. The thread loads from `messages`. The system prompt is rebuilt each turn:
   brand profile, the four node types, the registry rows with their prices and
   capabilities, the wiring rules, and a `list_graph` summary.
3. `streamText({ model, tools, stopWhen: stepCountIs(12) })`. Text streams to
   the panel; tool calls execute server-side against SQLite.
4. Each mutating tool writes through `saveGraph`. The stream emits a
   `graph-changed` data part.
5. The panel sees it and calls the existing `fetchFlow()`. Nodes appear on the
   canvas mid-conversation.
6. Nothing is dispatched.

`graph_json` stays the single source of truth. Chat is a third writer alongside
the canvas and `/api/flow` PATCH — same `saveGraph`, no second path.

## The fixture seam

`models/llm.ts` today keys fixtures on a single string:

```ts
export const fixtureKey = (prompt: string) =>
  createHash('sha256').update(prompt).digest('hex').slice(0, 32)
```

A multi-turn conversation with tool results breaks this silently: two different
turns of the same conversation hash to the same key, so `replay` returns some
other turn's answer and the test still passes.

The key must cover the whole request:

```ts
sha256(JSON.stringify({ messages, tools, model }))
```

Every step of a conversation then gets its own fixture, and a changed system
prompt surfaces as `MissingLlmFixtureError` rather than a wrong answer.

Replay is built on ai-sdk's own test doubles — a mock language model
constructed from the fixture JSON, and its stream simulation helper — rather
than hand-written stream faking. The exact export names are verified against the
installed `ai` version as the first step of implementation; if they have moved,
the fallback is a hand-rolled `LanguageModelV2` returning the fixture's parts,
which is a dozen lines.

Modes keep their current meanings:

| Mode | Behaviour |
|---|---|
| `off` | throws `LlmDisabledError` — suites that must not spend |
| `replay` | fixtures from `test/fixtures/llm`, forced by the test configs and `DEMO=1` |
| `live` | OpenRouter. `OPENFLOW_RECORD_LLM=1` writes fixtures as it goes |

`/api/chat` returns 403 under `isDemo()`, matching `/api/brief` POST. Without
that gate, a public demo is a free OpenRouter proxy on the operator's key.

## Configuration

`.env` and `.env.example` gain:

```
OPENROUTER_API_KEY=
OPENROUTER_MODEL=anthropic/claude-opus-5
```

`env.ts` resolves both, as it does every other environment read. No picker in
the UI: changing model is one line in a file you already edit.

`ANTHROPIC_API_KEY` comes out of `.env.example` with the SDK.

## Error handling

Tool failures are **results, not exceptions**. A `WiringError` returns to the
model as a tool result and it retries or explains. `applyWire`'s messages are
already written for a human — *"That wire would create a cycle."*, *"`img2`
already has a start frame."* — so they need no translation.

What refuses hard:

- **Invalid node** — `nodeSchema` rejects it and the tool result says why. A
  fifth node type is impossible by construction.
- **Missing key** — `LlmDisabledError`; the panel says to set
  `OPENROUTER_API_KEY` or `LLM_MODE=replay`.
- **Missing fixture** — loud in replay. Never a silent wrong answer.
- **Step cap** — `stopWhen: stepCountIs(12)`. The panel says it stopped after 12
  steps and the graph keeps whatever was written. No runaway loop.
- **Stream dies mid-turn** — completed tool calls are already persisted; the
  partial assistant message is not saved. A retry replays the same request, so
  the fixture key is stable.

No rollback. Each tool is one small mutation and the canvas already has undo.

## Testing

**`test/unit/agent-tools.test.ts`**
- each tool rejects malformed arguments with a usable message
- `wire` refuses a capability violation — proving it calls `applyWire` rather
  than a copy
- `add_node` rejects a type outside the four
- `delete_node` takes its edges with it

**`test/unit/llm-fixture-key.test.ts`**
- two different message histories produce different keys
- an added system-prompt line changes the key

**`test/acceptance/chat-authoring.test.ts`**
- a fixture-replayed conversation builds a flow whose `input_hash` values are
  identical to the canvas-built equivalent

That last one is Phase 4's own gate, and it is the check that matters: same
core, two front doors. If the hashes differ, logic has leaked into the agent
layer.

**`e2e/chat.spec.ts`**
- under `LLM_MODE=replay`: send a message, nodes appear on the canvas, the brief
  bar is gone

## Out of scope

Skills loading, chat file upload, vision descriptions, a model picker,
multi-flow, and any agent-initiated run. The first two have their own
sub-projects; the rest are not planned.
