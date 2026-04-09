# Testing Guide

## Architecture

Three test suites at different layers:

| Suite | Location | Speed | CI | Coverage |
|---|---|---|---|---|
| Unit + Integration | `tests/integration/`, `packages/*/tests/`, `server/tests/`, `extension/tests/` | Fast (~10s) | Always | Event flow, edge cases, pipeline, stores, components |
| Visual | `tests/visual/` | Medium (~30s) | Always | Component rendering, animations |
| E2E | `tests/e2e/scenarios/` | Slow (~5min) | Nightly/manual | Real agents, both backends |

## Running Tests

```bash
bun run test               # Unit + integration (vitest)
bun run test:integration   # Integration only
bun run test:visual        # Visual regression (Playwright)
bun run test:visual --update-snapshots  # Regenerate goldens
bun run test:e2e           # E2E (requires running backends)
```

## Adding Tests

### Integration Test
1. Create scenario steps using `emit()`, `pause()`, `wait()` from `test-agent-engine.ts`
2. Use factories from `factories.ts` for event data
3. Create harness with `createTestHarness(steps)`
4. Step through scenario, assert on `harness.events`
5. Always clean up with `harness.teardown()`

### Visual Regression Test
1. Prerequisite: `bun run build:ui && bun run build:css`
2. Inject state using helpers from `helpers/inject.ts`
3. Wait for render with `waitForRender(page)`
4. Use `toHaveScreenshot()` for golden comparison
5. Generate initial goldens: `npx playwright test --update-snapshots`

### E2E Scenario
1. Create workspace with `createWorkspace(name, files)`
2. Start server + connect SSE via `createE2EHarness(workspace)`
3. Wait for backend ready with `harness.waitForReady()`
4. Send messages, wait for events
5. Assert on SSE events + file system state
6. Parameterize with `getAvailableBackends()`

## Edge Case Catalog

All 59 edge case scenarios from the spec are covered across integration test files:
- Cases 1-36: `tests/integration/edge-cases.test.ts` — message lifecycle, streaming, tools, permissions, connection, EventMerger
- Cases 37-39: `tests/integration/multi-session.test.ts` — session switching, background events, concurrent sessions
- Cases 40-43: `tests/integration/pipeline.test.ts` — stage transitions, fix cycles, abort, concurrent pipelines
- Cases 44-46: `extension/tests/rpc-edge-cases.test.ts` — RPC timeout, concurrent, mismatch
- Cases 47-55: `tests/integration/store-edge-cases.test.ts` — optimistic messages, windowed loading, skill badges
- Cases 56-57: `tests/integration/edge-cases.test.ts` — SSE heartbeat
- Cases 58-59: `tests/integration/edge-cases.test.ts` — auto-intervention

## Golden Management
- Goldens committed to git as binary (`__goldens__/` dirs)
- Review diffs in CI artifacts when tests fail
- Update intentionally: `--update-snapshots`
- `.gitattributes` marks goldens as binary

## CI Configuration

| Suite | Trigger | Timeout | Artifacts |
|---|---|---|---|
| `test` | Every push, every PR | 60s | — |
| `test:visual` | Every push, every PR | 120s | Diff PNGs on failure |
| `test:e2e` | Nightly schedule, manual dispatch | 10min | Screenshots, event logs on failure |

**Failure handling:**
- Unit/integration/visual failures block merge
- E2E failures create an issue but don't block (nightly only)
- On golden mismatch: CI uploads the diff image as a build artifact for visual review

## Known Limitations

- Visual regression uses snapshot capture (generate → compare), not failing-test-driven TDD. First-capture goldens can bake in existing bugs. Review initial goldens carefully before committing.
- E2E tests require both Claude Code and OpenCode backends to be authenticated and available on the machine.
