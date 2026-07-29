# OpenFlow

**A local-first, open-source node editor for directing on-brand ad creative.**

Upload a product once and it becomes an *anchor*. Build a graph of shots — images, and video clips branching off those images — each with its own prompt and creative direction. The anchor keeps the product identical across every output. Change the product, bump the anchor version, and every downstream shot goes stale with a price tag attached.

> **Status: pre-code.** The build plan and phase docs are written; implementation starts at Phase 0. Nothing installs yet.

## Non-Goals

Read these first. They are the immune system of this project.

- **Not a general AI workflow engine.** That's ComfyUI. Four node types in v1 — `source`, `image`, `video`, `export`. Adding a fifth requires a written case showing it can't be expressed by the existing four.
- **Not a SaaS.** No accounts, no cloud, no credit packs. The SQLite file, the generated assets, and your fal key stay on your machine.
- **No agent loop.** LLMs sit at the edges — brand profile, brief→flow — never in the execution path.
- **No markup.** Bring your own fal key and pay what the models cost. Per-node cost tracking is a headline feature, not a hidden one.
- **Not multi-provider in v1.** fal.ai only.

Models are rows in a registry, never classes — adding one is a config edit.

## Docs

| | |
|---|---|
| [`build-plan.md`](./build-plan.md) | Architecture, data model, execution, GUI, positioning |
| [`docs/phases/`](./docs/phases/) | Phase-by-phase execution with hard exit gates |
| [`docs/testing-strategy.md`](./docs/testing-strategy.md) | TDD loop, Playwright e2e, fal fixture seam, CI rule |

## License

MIT. Adoption is the point.
