# OpenFlow

**A local-first, open-source node editor for directing on-brand ad creative.**

Upload a product once and it becomes an *anchor*. Build a graph of shots — images, and video clips branching off those images — each with its own prompt and creative direction. The anchor keeps the product identical across every output. Change the product, bump the anchor version, and every downstream shot goes stale with a price tag attached.

> **Status: Phase 1 (core, headless) complete.** No canvas yet — that's Phase 2. The headless runner works today.

## Running it

**Node 22.16.0 or newer is required** (`.nvmrc` pins it). Older 22.x patch releases ship a `better-sqlite3` prebuild that segfaults on macOS arm64 — you get exit code 139 and no error message.

```bash
nvm use          # or any Node >= 22.16.0
npm install
npm test         # typecheck, lint, unit, e2e — one command

# Run the demo graph against recorded fixtures. No fal key, no spend.
FAL_MODE=replay npm run -- run flows/demo.json

# Run it for real. Bring your own fal key; you pay fal directly, at cost.
FAL_KEY=... FAL_MODE=live npm run -- run flows/demo.json
```

`FAL_MODE` is `live` by default and forced to `replay`/`off` by the test configs, so a test run can never bill you. `OPENFLOW_DATA_DIR` moves the SQLite file and generated assets off `./data`.

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
