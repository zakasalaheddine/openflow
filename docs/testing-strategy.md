# Testing Strategy

The goal of this document is one sentence: **a new feature cannot ship if it breaks an old one, and CI is what enforces that — not discipline.**

Everything below serves that. Read this before Phase 1.

---

## 1. The testing ladder

The build plan makes Phase 1 headless — there is no browser to drive until Phase 2. So "e2e from the start" does not mean "Playwright specs in week one". It means the *harness* exists from the start and every phase adds specs to it, never replaces it.

| Phase | Unit (Vitest) | Acceptance | Playwright e2e |
|---|---|---|---|
| **0 — Spike** | none | none | none |
| **1 — Core, headless** | `hash`, `graph`, `registry`, executor cache logic | CLI runs against replayed fal fixtures | installed + CI-wired, **zero specs** |
| **2 — Canvas** | + inspector/state reducers | unchanged, still green | first specs: wiring, anchors, stale propagation |
| **3 — Video, export, ship** | + spec validation, format math | + manifest integrity | + video wiring, export, brief→flow |
| **4 — MCP (optional)** | + tool argument validation | MCP tools drive the same `/core` acceptance suite | unchanged |

**Phase 0 is deliberately untested.** It is a throwaway `spike.ts` whose only output is `FINDINGS.md`. Do not TDD a spike; you would be testing fal, not your code.

---

## 2. TDD loop

Red → green → refactor, per unit of behaviour, for every phase from 1 onward.

1. Write the failing test naming the behaviour (`hash changes when an anchor version bumps`).
2. Run it. **See it fail for the right reason** — a test that passes before the code exists is testing nothing.
3. Write the minimum code to pass.
4. Refactor with the test green.

Where TDD is mandatory: `/core` and `/models`. These are pure functions with no framework imports (§3 of the build plan enforces this with an eslint boundary rule), which makes them the cheapest and highest-value things in the repo to test.

Where TDD is optional: React components with no logic, styling, layout. Cover those with Playwright at the behaviour level instead of shallow-rendering them.

---

## 3. Two infrastructure rules that must land in Phase 1

Both are cheap now and painful to retrofit. Neither is negotiable.

### 3.1 Tests never call fal

Every fal call costs real money; a hero video run is ~$38. A test suite that hits the network is a suite you stop running.

The seam already exists in the architecture: **one generic fal adapter** (§7) and a `DEMO=1` mode that serves pre-baked runs as cache hits (§10). Tests reuse that same seam — they do not get a parallel mock system.

```
FAL_MODE=live     real calls          (dev + you, deliberately)
FAL_MODE=replay   fixtures from disk  (all tests, CI, DEMO=1)
FAL_MODE=off      throws on any call  (guard for suites that must not dispatch)
```

Fixtures live in `test/fixtures/fal/<endpoint>/<hash>.json` plus the small asset files they reference. Record them once with a live run; commit them. A CI job that finds `FAL_MODE=live` fails.

Building this in Phase 1, when the models are cheap images, is the entire point. Retrofitting it in Phase 3 against video pricing is where this goes wrong.

### 3.2 Data directory is env-overridable

The plan hardcodes `./data/app.db`. A Playwright run against a 2-second-tick worker will stomp your real project state and delete assets you paid for.

```
OPENFLOW_DATA_DIR   defaults to ./data
```

Every test file gets a fresh temp directory, migrated from scratch, torn down after. No test shares a database with another test or with the dev environment.

---

## 4. Playwright conventions

- **One server per run.** `webServer` in `playwright.config.ts` boots the app with `FAL_MODE=replay` and a temp `OPENFLOW_DATA_DIR`. No manually started dev server.
- **Seed by fixture, not by clicking.** A spec that tests export should not spend forty steps building a graph first. Seed the DB with a known flow, then test the one thing. Exception: the Phase 2 gate spec, whose *entire point* is building a graph from empty.
- **Locate by role and label**, never by CSS class. Class-based selectors turn a restyle into a red suite, which trains people to ignore red.
- **No arbitrary waits.** Await a visible state — a node's status chip reading `succeeded`, the toolbar count updating. The worker is polled and async; assert on the outcome.
- **Traces on failure only.** `trace: 'retain-on-failure'`.

---

## 5. Regression rule

This is the mechanism behind the request, stated plainly:

1. Every phase's tests are **cumulative**. Phase 3 does not get to modify or delete a Phase 1 acceptance test to make its feature pass. If a Phase 1 test is genuinely wrong, changing it is a decision that gets its own commit and a reason in the message.
2. **One command runs everything:** `npm test` → typecheck, lint (including the `/core` boundary rule), Vitest, then Playwright.
3. **CI runs that command on every push and PR.** A red build blocks merge. Without this, "don't break old features" is an aspiration.

```yaml
# .github/workflows/ci.yml — add at the end of Phase 1
name: ci
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    env:
      FAL_MODE: replay
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npm test
      - uses: actions/upload-artifact@v4
        if: failure()
        with: { name: playwright-report, path: playwright-report/ }
```

---

## 6. What is not tested

Stated so nobody adds it later out of a sense of symmetry:

- **fal's own behaviour.** Fixtures assert *our* handling of a response shape. If fal changes that shape, `verifiedOn` in the registry and a live smoke run catch it — not the unit suite.
- **Generation quality.** No test asserts an image looks right. That is what Phase 0 and human review are for.
- **Coverage thresholds.** A number that gets gamed. The acceptance tests are the real gate.
