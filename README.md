# OpenFlow

**A local-first, open-source node editor for directing on-brand ad creative.**

Upload a product once and it becomes a node on the canvas. Wire it into as many shots as you like — images, and video clips that start from those images — each with its own prompt. Replace the product and every shot built from it goes stale, with a price tag attached before you commit to re-rendering.

> *Screenshot pending: the three-shot serum graph with per-node costs. Not shipped yet — see [`docs/phases/phase-3-video-export-ship.md`](./docs/phases/phase-3-video-export-ship.md).*

## Install

```bash
git clone https://github.com/zakasalaheddine/openflow.git
cd openflow
nvm use          # reads .nvmrc — do this first
npm install
npm run studio
```

`npm run studio` boots the server, builds on first run, creates the database, opens a browser, and asks for a fal key. An empty answer is a valid answer — the canvas opens and Run asks again when you need it.

Chat needs an OpenRouter key. Put `OPENROUTER_API_KEY` in `.env` and, if you want a different model, `OPENROUTER_MODEL` (default `anthropic/claude-opus-5`; anything on OpenRouter that supports tool use — the agent is nothing but tool calls). Without a key the panel says so and the canvas works as before. Recorded chat fixtures are keyed to the model that produced them, so the suites pin the default and swapping models never overwrites them.

**There is no `npx openflow-studio`, and this README used to claim otherwise.** A Next app cannot be built from inside a `node_modules` directory, which is all `npx` is; the details, and the two other ways it fails, are in [`docs/phases/phase-3-video-export-ship.md`](./docs/phases/phase-3-video-export-ship.md). Cloning is the path this project actually tests.

**Node 22.16.0 or newer is required** (`.nvmrc` pins it). Older 22.x patch releases ship a `better-sqlite3` prebuild that segfaults on macOS arm64: you get exit code 139 and no error message, so the launcher refuses to start on one.

**ffmpeg** is needed for video and for exporting clips (`brew install ffmpeg` / `apt install ffmpeg`). Image-only flows work without it.

Without the canvas:

```bash
npm test         # typecheck, lint, unit, browser — one command

# Run the demo graph against recorded fixtures. No fal key, no spend.
FAL_MODE=replay npm run -- run flows/demo.json

# Run it for real. Bring your own fal key; you pay fal directly, at cost.
FAL_KEY=... FAL_MODE=live npm run -- run flows/demo.json
```

Copy [`.env.example`](./.env.example) to `.env` and edit it — `next dev`, `next start`, `npm run studio` and the headless runner all read it, so nothing has to be exported by hand. An exported variable still wins over the file, which is what keeps `FAL_MODE=off npm run …` honest.

Assets live on your machine. Set `CLOUDINARY_URL` and uploads and rendered frames are pushed to Cloudinary as well, and fal is handed a URL instead of the file inlined into its request — the difference between a reference that works and one refused for being over 12 MB. Local copies are kept regardless: `ffmpeg` and `sharp` read files, so export never depends on the network.

`FAL_MODE` is `live` by default and forced to `replay`/`off`/`stub` by the test configs, so a test run can never bill you. `DEMO=1` forces `replay`, pre-bakes the demo flow from recorded fixtures, and refuses every render request — that is the mode a public demo runs in. `OPENFLOW_DATA_DIR` moves the SQLite file and generated assets off `./data`; `OPENFLOW_EXPORTS_DIR` moves exported files off `./exports`.

## One build per URL

Each build is a workspace with an address of its own — `/f/default`, `/f/9c1a4f0e` — so two of them are two browser tabs rather than two apps. Its canvas, its render history, its costs and its chat thread belong to it alone; open the switcher in the toolbar to make one, rename it, or delete it. `/` opens the default workspace, or the most recently touched one if you have deleted it.

The asset library, the brand profile and the spend cap are shared across all of them, deliberately: upload a product once and every campaign built on it goes stale together when you replace it. Deleting a workspace deletes its runs and its conversation, and keeps the files those runs paid for.

## Non-Goals

Read these first. They are the immune system of this project.

- **Not a general AI workflow engine.** That's ComfyUI. Four node types in v1 — `source`, `image`, `video`, `export`. Adding a fifth requires a written case showing it can't be expressed by the existing four.
- **Not a SaaS.** No accounts, no cloud, no credit packs. The SQLite file, the generated assets, and your fal key stay on your machine.
- **No agent in the execution path.** The chat agent authors the graph — it adds nodes, wires them, rewords prompts. It has no way to render anything: there is no run tool, and Run is a button a person presses after reading the price.
- **No markup.** Bring your own fal key and pay what the models cost. Per-node cost tracking is a headline feature, not a hidden one.
- **Not multi-provider in v1.** fal.ai only.

## Models are rows in a file you edit

The catalog is `models.json` in your data dir, seeded on first boot from the six rows that ship. To add more, run:

```bash
npm run models:add
```

The first run writes `models.txt` beside the catalog and stops. Put fal model ids in it, one per line, and run it again.

Everything else comes from fal: the medium from its category, the capabilities from its OpenAPI input schema, the price from the sentence on its model page. Where fal declares that a model takes reference images but not how many, the row gets 1 and the command says so — raise `caps.refImages` yourself, because the wiring gate enforces whatever the file says. Ids you already have are skipped, so the file is a list you keep rather than a queue you clear. You can also just edit `models.json` by hand — the command writes the same rows you would.

**Every row that lands has a price.** Most come from fal. A few models it prices per token instead — `openai/gpt-image-2` publishes `$30 per 1M image tokens` and no per-image figure anywhere, and no arithmetic turns one into the other without a token count nobody publishes. Those are refused rather than added unpriced, and the refusal names the line that fixes it:

```
openai/gpt-image-2  0.12/image
```

fal's own price always wins over yours when it has one, so a stale number in the list file cannot quietly override what you are actually charged. Every row keeps `pricingNote`, the sentence its price was read out of, because fal's prose carries conditions a regex cannot ("4K outputs are charged at double").

A price can still be blank if you hand-edit `models.json` — such a row is selectable, comparable, and refused at Run by name. Never zero: a zero quotes $0.00 and the spend cap approves an invoice it never saw.

| Image | Video |
|---|---|
| `flux-2-pro` (default) | `hailuo-2-3-pro` (default) |
| `nano-banana-pro` | `veo-3-1` |
| `recraft-v3` (text rendering) | `kling-3-pro` (start **and** end frame) |

**Every node names its own model.** Three shots wired to one product photo can run three different models, priced separately on their own cards — which is how you find out which model is worth paying for. Nothing overrides that choice.

Capabilities are enforced when you draw the wire and when you change the model, not at render time: a fifth reference into a model that honours four is refused, and switching a wired shot onto a model that honours none is refused with the reason. An ignored reference produces off-brand output that reads as a model quality problem, and nobody ever learns why.

Prices are estimates from public pricing pages until a live call stamps `verifiedOn` — fal returns no price with a result, so the number in the file is the number the ledger uses.

Upgrading a database written before per-node models: `npm run migrate:model-ids`, once. It re-points the runs that paid for your existing renders so they are not billed again.

## Architecture

```
┌──────────────────────────────────────────┐
│  Next.js — single process, :3000         │
│  /app     canvas GUI + API routes        │
│  /core    node types, executor, hashing  │  ← zero framework imports
│  /models  catalog + rules + fal adapter  │
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

**Model rows are welcome.** A row you add to your own `models.json` needs nothing from anyone; to ship one as a default, add it to `SEED` in [`src/models/registry.ts`](./src/models/registry.ts), note where the price came from, and say whether you have made a live call against the endpoint.

**Node types need a written case.** Four is the budget. Open an issue showing why the thing you want cannot be expressed by `source`, `image`, `video` and `export` before writing code.

Tests are cumulative: a change never edits an earlier phase's test to go green. If an old test is genuinely wrong, that is its own commit with a reason.

## License

MIT. Adoption is the point.
