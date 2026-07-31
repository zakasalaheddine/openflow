# OpenFlow

**A local-first, open-source node editor for directing on-brand ad creative.**

Upload a product once and it becomes a node on the canvas. Wire it into as many shots as you like — images, and video clips that start from those images — each with its own prompt. Replace the product and every shot built from it goes stale, with a price tag attached before you commit to re-rendering.

> *Screenshot pending: the three-shot serum graph with per-node costs. Not shipped yet — see [`docs/phases/phase-3-video-export-ship.md`](./docs/phases/phase-3-video-export-ship.md).*

## Install

```bash
npx openflow-studio
```

Boots the server, creates the database, opens a browser, and asks for a fal key. An empty answer is a valid answer — the canvas opens and Run asks again when you need it.

**Node 22.16.0 or newer is required** (`.nvmrc` pins it). Older 22.x patch releases ship a `better-sqlite3` prebuild that segfaults on macOS arm64: you get exit code 139 and no error message, so the launcher refuses to start on one.

**ffmpeg** is needed for video and for exporting clips (`brew install ffmpeg` / `apt install ffmpeg`). Image-only flows work without it.

From a clone:

```bash
nvm use          # reads .nvmrc — do this first
npm install
npm test         # typecheck, lint, unit, browser — one command

# Run the demo graph against recorded fixtures. No fal key, no spend.
FAL_MODE=replay npm run -- run flows/demo.json

# Run it for real. Bring your own fal key; you pay fal directly, at cost.
FAL_KEY=... FAL_MODE=live npm run -- run flows/demo.json
```

Copy [`.env.example`](./.env.example) to `.env` and edit it — `next dev`, `next start`, `npx openflow-studio` and the headless runner all read it, so nothing has to be exported by hand. An exported variable still wins over the file, which is what keeps `FAL_MODE=off npm run …` honest.

Assets live on your machine. Set `CLOUDINARY_URL` and uploads and rendered frames are pushed to Cloudinary as well, and fal is handed a URL instead of the file inlined into its request — the difference between a reference that works and one refused for being over 12 MB. Local copies are kept regardless: `ffmpeg` and `sharp` read files, so export never depends on the network.

`FAL_MODE` is `live` by default and forced to `replay`/`off`/`stub` by the test configs, so a test run can never bill you. `DEMO=1` forces `replay`, pre-bakes the demo flow from recorded fixtures, and refuses every render request — that is the mode a public demo runs in. `OPENFLOW_DATA_DIR` moves the SQLite file and generated assets off `./data`; `OPENFLOW_EXPORTS_DIR` moves exported files off `./exports`.

## Non-Goals

Read these first. They are the immune system of this project.

- **Not a general AI workflow engine.** That's ComfyUI. Four node types in v1 — `source`, `image`, `video`, `export`. Adding a fifth requires a written case showing it can't be expressed by the existing four.
- **Not a SaaS.** No accounts, no cloud, no credit packs. The SQLite file, the generated assets, and your fal key stay on your machine.
- **No agent loop.** LLMs sit at the edges — brand profile, brief→flow — never in the execution path.
- **No markup.** Bring your own fal key and pay what the models cost. Per-node cost tracking is a headline feature, not a hidden one.
- **Not multi-provider in v1.** fal.ai only.

## Models are rows, not classes

Adding one is a pull request that edits [`src/models/registry.ts`](./src/models/registry.ts) and nothing else.

| Role | Image | Video |
|---|---|---|
| draft | `flux-2-pro` | `hailuo-2-3-pro` |
| hero | `nano-banana-pro` | `veo-3-1` |
| specialist | `recraft-v3` (text rendering) | `kling-3-pro` (start **and** end frame) |

Each row carries its capabilities and its price. Capabilities are enforced at wiring time, not at render time: a fifth reference into a model that honours four is refused when you draw the wire, because an ignored reference produces off-brand output that reads as a model quality problem and nobody ever learns why.

Prices are estimates from public pricing pages until a live call stamps `verifiedOn`.

## Architecture

```
┌──────────────────────────────────────────┐
│  Next.js — single process, :3000         │
│  /app     canvas GUI + API routes        │
│  /core    node types, executor, hashing  │  ← zero framework imports
│  /models  registry rows + fal adapter    │
│  /worker  claim loop, fal polling        │  ← in-process
└───────────────┬──────────────────────────┘
        ./data/app.db       SQLite, WAL
        ./data/assets/      generated files
        ./exports/          user-facing output
                │
           fal.ai API       (your own key)
```

`/core` imports no React and no Next. That boundary is what makes the headless runner — and a later MCP server — nearly free.

Every render is keyed by an input hash chained through the graph, so a second run costs $0 and a changed prompt invalidates exactly its descendants. Exports are matched on that same hash: a shot you edited but did not re-render is refused rather than shipped under its new prompt.

**Run all** renders the whole flow. Every generator card also carries its own **Run**, which renders that shot and whatever upstream it still needs — never the shot alone, because a clip whose start frame was never rendered would dispatch as text-to-video and be billed in full for an anchor it never saw. The spend cap is judged on that narrowed run, so pricing one shot is not a confirmation dialog about the graph beside it.

## Docs

| | |
|---|---|
| [`build-plan.md`](./build-plan.md) | Architecture, data model, execution, GUI, positioning |
| [`docs/phases/`](./docs/phases/) | Phase-by-phase execution with hard exit gates |
| [`docs/testing-strategy.md`](./docs/testing-strategy.md) | TDD loop, Playwright e2e, fal fixture seam, CI rule |

## Contributing

**Model rows are welcome** — add a row, note where the price came from, and say whether you have made a live call against the endpoint.

**Node types need a written case.** Four is the budget. Open an issue showing why the thing you want cannot be expressed by `source`, `image`, `video` and `export` before writing code.

Tests are cumulative: a change never edits an earlier phase's test to go green. If an old test is genuinely wrong, that is its own commit with a reason.

## License

MIT. Adoption is the point.
