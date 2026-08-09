# Multiple workspaces, addressable by URL

Status: **approach A shipped.** The three approaches and the reasoning behind the
choice are kept below, because the next person to want per-client spend caps
needs to know that B was considered and why A came first.

## What is already true

The core is already parameterized. Every function that matters —
`planRun`, `previewRun`, `enqueueRun`, `exportFlow`, `saveGraph`, `createOps`,
`loadThread`, `staleForSource` — takes a `flowId` or `projectId` argument today.
The schema already has `projects` and `flows` as separate tables with a real
foreign key and cascade.

The only thing pinning the app to one canvas is `ensureWorkspace()`, which
returns two hardcoded constants (`project:default`, `flow:default`), called from
six route handlers:

| Route | Needs |
|---|---|
| `api/flow` GET/PATCH | `projectId` + `flowId` |
| `api/run` POST | `flowId` |
| `api/export` POST | `flowId` |
| `api/chat` GET/POST/DELETE | `projectId` + `flowId` |
| `api/sources` GET/POST/PATCH/DELETE | `projectId` |
| `api/brief` GET/PATCH | `projectId` |

So this feature is **not** a data-model change. It is: decide the scope, resolve
ids from the URL instead of from constants, and plumb the id through
`src/app/state.ts`.

## The actual decision

URL shape is cosmetic. The decision is **what a workspace scopes**.

- Project-scoped state: `sources` (asset library), `projects.brandProfile`, `projects.settings` (spend cap, formats, fps, concurrency).
- Flow-scoped state: `flows.graphJson`, `nodeRuns`, `messages` (chat thread), `exports`.

The question that picks the approach: **do your multiple builds share one asset
library and one brand profile, or does each build get its own?**

---

## Approach A — many flows, one project (`/f/[flowId]`)

A workspace is a *build*: its own canvas, own runs, own chat thread, own
exports. All builds share the asset library, the brand profile, and the spend
cap.

**Shape**
- `app/f/[id]/page.tsx` renders `<Canvas flowId={id} />`; `/` redirects to `flow:default` when it exists, most-recently-updated otherwise (`ensureWorkspace` keeps creating the default on an empty database).
- Routes take the id as a query param (`/api/flow?flow=<id>`) or a path segment; either way `ensureWorkspace(db)` becomes `resolveFlow(db, id)` that 404s on an unknown id and falls back to the default when absent.
- A flow switcher in the toolbar: list, new, rename, delete.

**Pros**
- Matches what the schema was designed for. `sources` carries the comment *"Project-level rather than per-flow, which is what lets one product be referenced from several campaigns"* — approach A is that sentence shipped.
- `staleForSource` already walks **every flow in the project** and the blast-radius dialog already reports `flowCount`. That number is permanently 1 today. Under A it becomes real: replace a product, see "18 nodes across 2 campaigns" — the exact scenario the code comments describe.
- `src/worker/loop.ts:51` (`projectSettings` = first project wins) stays *correct*. No worker change at all.
- `messages.flowId` gives each build its own chat thread for free — no schema change, no migration.
- Two tabs on two flows never contend: they touch different `graph_json` rows, and the existing `updatedAt` optimistic-concurrency guard already handles two tabs on the *same* flow.
- Smallest diff. `api/sources` and `api/brief` don't change at all.

**Cons**
- One spend cap and one brand profile for everything. Two unrelated clients would share a cap.
- No way to keep two clients' asset libraries apart. Asset menu lists everything.
- `projects` stays a single-row table — visible dead weight until a second project has a reason to exist.

---

## Approach B — projects *and* flows in the URL (`/p/[projectId]/f/[flowId]`)

Both levels are addressable. A project owns a library, a brand, a cap; it holds
many flows.

**Shape**
- `app/p/[pid]/f/[fid]/page.tsx`; `/p/[pid]` lists that project's flows; `/` redirects to last-used.
- Every route takes both ids and must verify `flow.projectId === pid` — otherwise a mismatched pair reads one project's brand into another's run.
- Two switchers, or one two-level picker.

**Pros**
- The complete model. Client isolation *and* shared products within a client.
- Per-project spend caps, formats, brand profiles — all already supported by `ProjectSettings`, nothing new needed in core.
- Blast radius stays meaningful and correctly bounded per project.

**Cons**
- Breaks `src/worker/loop.ts:51` on day one. `projectSettings` does `.limit(1).get()` — the worker would read concurrency from an arbitrary project. Needs a join through `flows`, which the comment there already anticipates. (`executor.ts:62` already joins correctly; only the worker read is wrong.)
- Most surface area for a request that asked for "multiple builds": project CRUD, flow CRUD, two nav levels, cross-id validation on every route.
- Two ids to keep in sync in every client fetch, every e2e helper, every link.
- Nothing in the current UI has a place for a project concept. It has to be invented alongside.

---

## Approach C — workspace = project, one canvas each (`/w/[id]`)

Collapse the distinction. Each workspace is a project holding exactly one flow:
own canvas, own asset library, own brand, own cap. Full isolation.

**Shape**
- `app/w/[id]/page.tsx`, where `id` is the project id; the flow is looked up as that project's only flow.
- All six routes resolve `{projectId, flowId}` from the one id.
- One switcher. Conceptually the simplest thing on screen.

**Pros**
- Cleanest mental model: a workspace is a sealed box. Nothing leaks between clients.
- One id in the URL, one id in every fetch — less plumbing than B.
- Per-workspace spend cap, which is the honest answer if you run two clients' budgets.

**Cons**
- Contradicts the schema's stated intent and permanently pins `blastRadius.flowCount` at 1. One product referenced from several campaigns becomes impossible — you'd re-upload the same product per workspace.
- Same worker break as B (`projectSettings` first-project-wins goes wrong).
- Re-uploading a product per workspace also duplicates the files on disk, and `assets` has no project column at all — there is no key to list or clean assets per workspace.
- The `flows` table becomes a table with a one-row-per-project constraint nobody enforces. Either drop it (destructive migration touching `nodeRuns`, `messages`, `exports`) or leave it as a lie.

---

**Rejected without a section:** a SQLite file per workspace. Fragments the shared
asset library, kills cross-flow blast radius entirely, and multiplies the
launcher's database setup by N. Local-first does not mean file-per-thing.

---

## Recommendation: A

It is the feature you asked for — multiple builds, each with its own URL, its
own canvas, its own chat, all open in the same session — and it is the one the
existing code was written expecting. It turns `flowCount` in the blast-radius
dialog from a constant into a real number. It touches the worker not at all.

If per-client spend caps or separate asset libraries turn out to matter, A
upgrades to B without a migration: the `projects` table and every core signature
are already there. C is the only one that closes a door.

## What implementing A actually involves

Ordered roughly by size.

1. **`src/app/state.ts` is the bulk of the diff, not routing.** Eleven fetch
   helpers take no id today: `fetchFlow`, `saveGraph`, `startRun`, `startExport`,
   `fetchBrief`, `saveBrandProfile`, `fetchChat`, `sendChat`, `clearChat`,
   `uploadFile`/`createTextSource`, `previewReplace`/`replaceSource`. The
   flow-scoped ones need the id threaded from the route param. The
   project-scoped ones (sources, brief) do not change under A.
2. **`resolveFlow(db, id?)` replaces `ensureWorkspace(db)`** in
   `src/core/workspace.ts` — 404 on unknown, default when absent. Plus
   `listFlows` / `createFlow` / `renameFlow` / `deleteFlow`, and an
   `/api/flows` route for the switcher.
3. **`/` must still resolve to `flow:default` when it exists.** `src/core/demo.ts`
   imports the demo graph *into* `DEFAULT_FLOW_ID` precisely because "the canvas
   opens onto the default flow." A plain most-recently-updated redirect breaks
   `DEMO=1` the moment a second flow exists, so default-first is the rule and
   most-recent is only the fallback.
4. **Id-in-URL form.** Ids are prefixed (`flow:default`) and a colon needs
   `%3A` in a path. `demo.ts` already does `DEFAULT_FLOW_ID.replace(/^flow:/, '')`,
   so the suffix-in-URL convention is half-established — pick it and apply it
   consistently, or stop prefixing new ids.
5. **Delete needs orphan cleanup.** `projects → flows` and `projects → sources`
   cascade; `flows → nodeRuns / messages / exports` does **not** — those carry
   `flow_id` as a bare text column with no foreign key. Deleting a build either
   adds those FKs (a migration) or deletes the rows explicitly. Leaving them
   is worse than it sounds: `nodeRuns` rows are the cost ledger, and an orphan
   is not merely invisible. Every total is scoped `where(flowId = …)`, so an
   orphan counts toward nothing — until an id is reused. `newId` already
   recycles freed node-id suffixes, and `api/flow/route.ts` carries a comment
   about a stale run resurfacing under a new node with the same id; a reused
   *flow* id does the same thing one level up, resurfacing a deleted build's
   renders, costs and errors on a fresh canvas.
6. **e2e churn is a design lever, decide it deliberately.** `e2e/helpers.ts`
   `setGraph` PATCHes bare `/api/flow` and sixteen spec files sit on it. An
   **optional** id that defaults to the current flow means near-zero spec churn.
   Moving to a required `/api/flows/[id]/...` shape means the helper changes
   once but every spec must seed and carry an id. Recommendation: optional id,
   default preserved.
7. **Switcher UI** in the toolbar: list, new, rename, delete-with-confirm.
   Delete is the only destructive one and it destroys a paid cost ledger — it
   should name what it is deleting and how much was spent on it.
8. **One new e2e spec**: two flows, edit one, assert the other is untouched and
   that its chat thread is separate.

## Explicitly out of scope

Per-flow spend caps, project CRUD, moving a flow between projects, duplicating a
flow, archiving. None are needed to open two builds in two tabs.
