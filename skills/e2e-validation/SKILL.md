---
name: e2e-validation
description: E2E test execution — build infrastructure, write journey tests, visual validation, runtime observability via Strobe
stage: e2e
---

# E2E Validation

You are writing and running E2E tests for a completed implementation. Your input is the **E2E plan** — it tells you the environment setup, scenarios, infrastructure design, and visual validation strategy. Your job is to execute that plan: build the fixtures, write the tests, make them pass.

## ⚠️ IMPORTANT — READ THIS FIRST

**Every scenario or infrastructure task you touch, you finish 100%. No skimming. No shortcuts. No "good enough."**

- A scenario is **done** when the test runs against the real environment, the real production path executes, and the assertions verify real outputs. **Skipping the real environment, mocking the production code, or asserting on test scaffolding is NOT done.**
- **NEVER** mark a scenario `[x] done` if you skipped a visual check, skipped a teardown step, used a stub instead of the real component, or left a `.skip()` / `.only()` in the test file.
- **NEVER** swap the real environment for a unit-test simulation because the real environment is hard to boot. **That is the job.** When stuck, iterate — don't downgrade.
- **NEVER** write a test that passes without actually exercising the system. Ask yourself: "if the production code were deleted, would this test fail?" If no, it's not a test.
- **NEVER** silently weaken a visual assertion (lower a confidence threshold, accept a "close enough" diff) to make it pass. Either the UI is correct or you fix it — never paper over the failure.
- **`verdict: "partial"` is for between scenarios, not within a scenario.** If you finished 5/30 scenarios fully and your context budget is tight, signal partial. If you started scenario 6 and got tired of a hard fixture, you finish scenario 6 first, then signal. Never sign off on a scenario you didn't fully execute.
- **NEVER** signal `partial` or `stuck` with zero scenarios completed in this session. Reading the plan and booting the environment is not work — a green scenario against the real environment is. If you've done none, keep going. Plan length is never a reason to bail.

The two failure modes: doing 10 scenarios at 60% quality and signaling done, *or* doing zero scenarios and bailing because the plan looks long. The correct mode: do as many scenarios as fit at 100% quality, then signal partial.

E2E means **the real application runs in the real environment** — real hosts, real servers, real clients, real I/O. The pipeline is never validated until the actual production path is fully exercised.

## The Non-Negotiable

**The real application must run in the real environment. You are not done until it does.**

If the application is a VS Code extension — it runs inside VS Code's Extension Development Host. If it's a server — a real server process handles real network requests. If it's a desktop app — the real window renders on screen. If it's firmware — it runs on a simulated version. If it speaks a wire protocol — real bytes cross real sockets.

A component test rendered in jsdom with simulated messages is a unit test wearing a costume. The E2E stage catches what simulations hide: host constraints (CSP, sandboxing, permissions), protocol mismatches, serialization bugs, startup/shutdown ordering, real latency, race conditions.

**When the real environment is hard to boot, that is the job.** The plumbing is often 80% of the E2E effort. Do not skip it because it's hard. When stuck, iterate — don't downgrade. Try multiple approaches. If after exhaustive effort the real environment truly cannot be automated, escalate to the user with what you tried and why it failed. Never silently settle for a simulation.

## Before Writing Any Code

1. **Read the E2E plan** — understand the environment, scenarios, infrastructure design, and visual validation strategy
2. **Read the spec** — understand the acceptance criteria
3. **Explore existing test infrastructure** — what's already in place that the plan builds on?

## Step 1: Build the Test Infrastructure

Follow the plan's infrastructure design:

- **Launch**: programmatically start the real environment. Automated — no manual steps.
- **Ready-wait**: detect when ready (health check, window appeared, webview loaded, port opened). No `sleep()` — poll or wait for a signal.
- **Interact**: helpers for driving the app through its real interfaces. These talk to the REAL application.
- **Observe**: helpers for capturing real outputs (screenshots, API responses, logs, accessibility state).
- **Teardown**: clean shutdown. Kill processes, delete temp files, close connections.
- **Isolation**: each test gets clean state. Fresh server, clean database, new session.

**Validate infrastructure first.** Build and run the smoke test defined in the plan: launch, wait for ready, one interaction, one assertion, tear down. Fix this before writing journey tests.

## Step 2: Write Journey Tests

Execute the scenarios from the plan:

- Exercise real flows through the infrastructure from Step 1
- Descriptive test names that read like user scenarios
- Dedicated E2E directory, separate from unit tests
- Longer timeouts than unit tests (real startup, rendering, network round-trips)

## Step 3: UI Visual Validation (when planned)

If the plan includes a visual validation strategy, implement it:

### 3a. Launch, interact, and capture

Use the test infrastructure to launch the real application. Navigate to each screen, panel, or view listed in the plan. Use whatever interaction mechanism the host provides (API calls, simulated input, UI automation framework, protocol commands).

Take **targeted, cropped screenshots** that isolate specific components or regions as specified in the plan. Full-window screenshots carry too much noise — a toolbar change shouldn't mask a broken panel. Aim for one screenshot per logical component or interaction state:

- Individual panels, dialogs, sidebars, toolbars
- Before and after meaningful interactions (button click, form submission, toggle, expand/collapse)
- Error states, empty states, loading states

Use the host's native screenshot API or whatever capture mechanism the environment provides. Crop or region-capture where possible. Capture at a consistent scale factor (2x recommended for clarity and stability).

### 3b. Dual-path validation: golden comparison + LLM fallback

Implement the dual-path validation pipeline from the plan:

**Phase 1 — Golden image comparison (fast, deterministic, no LLM).** Compare the captured screenshot against a stored golden reference using pixel-level diffing (RMSE, pixel-match ratio, or equivalent). If the diff is below a tolerance threshold, the test passes immediately. This is the fast path — no network calls, no model inference, sub-second.

**Phase 2 — LLM semantic validation (fallback when golden fails or doesn't exist).** When there is no golden sample yet (first run) or the golden comparison fails (UI changed), shell out to an LLM with the screenshot and the visual checks from the plan:

```
VisualCheck { question: "Does the waveform display show a sine wave?", expectedAnswer: true }
→ CheckResult { answer: true, confidence: 0.93, reasoning: "smooth periodic curve visible" }
```

Each check is a yes/no question about a specific visual property. The LLM returns answer, confidence (0.0–1.0), and brief reasoning for each. All checks must pass with confidence above threshold (0.5 minimum, 0.8 recommended).

**Auto-update golden samples.** When no golden exists and LLM validation passes, save the screenshot as the new golden reference automatically. When golden comparison fails but LLM validation passes, update the golden — the UI changed intentionally. When LLM validation fails, the test fails — something is actually wrong.

**Negative assertions.** Implement the negative assertions from the plan — sanity checks that deliberately ask wrong questions to verify the LLM isn't rubber-stamping everything.

**Rate limiting.** Add delay between LLM calls (10–15s base + jitter) to avoid API throttling. Make the delay configurable via environment variable.

### 3c. Store golden samples

- Dedicated directory (e.g., `tests/e2e/golden/`) checked into version control
- Use the descriptive names from the plan (e.g. `settings-panel-default.png`, `chat-empty-state.png`)
- One golden per logical component state — not one per test file

### 3d. Write regression tests

Each visual regression test:

1. Puts the application into a specific state (navigate, interact, configure)
2. Captures a screenshot of the target component/region
3. Runs the dual-path validation (golden comparison → LLM fallback → auto-update)
4. Asserts all visual checks passed with sufficient confidence

**The rule**: if a future developer breaks a UI panel, either the golden diff catches it (fast path) or the LLM catches it (semantic path). Both paths must be exercised.

## Execution Order — Strict

Execute tasks **in the order the E2E plan lists them**:
1. Infrastructure tasks (typically `EI1`…`EIn`) **before** scenario tasks. Scenarios depend on fixtures — without infrastructure in place, scenario tests cannot run.
2. Within each group, in plan order — `EI1` before `EI2`, `A1` before `A2`. The plan was reviewed in this order; downstream scenarios assume the upstream ones are wired.
3. **No prioritization.** Don't skip ahead to "easier" scenarios. Don't batch by theme.
4. If a scenario is blocked, do not skip to the next one — fix the blocker or signal `verdict: "partial"` (see below).

Track scenario completion in the progress file (`[x] done` per scenario row).

## Partial Completion — Earn It, Then Use It

E2E plans are routinely 30+ scenarios. You do not have to fit them all in one session. The orchestrator supports a `partial` signal that hands control back, then **restarts you with a fresh session** at the next pending scenario. There's no penalty — but you have to actually complete a scenario first.

**Before signaling partial, you must have:**
- Completed at least one full scenario (or substantial infrastructure task) in this session against the real environment, marked done in the progress file.
- Real budget pressure: context ~80%+ used, or the next scenario needs exploration/diagnostic loops you genuinely can't afford. "Feels like a lot" doesn't count.

**Other valid partial triggers (after the bar above is met):**
- A scenario's diagnostic loop (Strobe traces, screenshot review) has consumed a lot of context.
- The next scenario requires substantial new exploration that would push you over budget.

**How:**

1. Update the progress file: `[x] done` for completed scenarios; notes for any `[!] blocked`.
2. Append `- **E2E (partial):** done EI1, EI2, A1; pending EI3+, A2+ — <reason>` to `## Iteration Log`.
3. Call `atelier_signal` with `type: "stage_complete"`, `verdict: "partial"`, and `outputPath` set to the absolute path of the progress file. The orchestrator requires `outputPath` on partial signals.

There is no penalty for partial completion. The pipeline is built for this.

## Step 4: Run and Verify

Run the E2E tests using the host's native test framework or `debug_test` when the framework is supported.

**When tests fail — use Strobe to debug, not to test.** Strobe is a runtime observability tool for the developing agent. When a visual validation fails or a journey test breaks:

1. Launch the application with `debug_launch` to attach instrumentation
2. Reproduce the failing state — put the app where the test expected it to be
3. Use `debug_ui` to inspect the accessibility tree and take screenshots — understand what the UI actually looks like vs. what was expected
4. Use `debug_trace` to add function-level tracing and understand execution flow
5. Use `debug_query` to search the timeline for what went wrong (stderr, crashes, unexpected calls)
6. Use `debug_memory` to inspect runtime state when needed

The pattern is: test fails → Strobe tells you WHY → you fix the code → test passes. Strobe never appears in test code itself.

**All bugs are your bugs.** If an E2E test reveals a failure — whether caused by your new feature or by pre-existing code — you fix it. Never dismiss a failure as "pre-existing," "not introduced by this branch," or "out of scope." E2E tests exercise the real application as a user would experience it. If the app is broken, the app is broken. Fix it and make the test pass.

**Verification gate — before marking done, confirm:**
- Tests run against the real application in the real environment
- Critical user journeys pass end-to-end — **all of them, including paths through pre-existing code**
- Setup and teardown are clean (no orphaned processes, no leaked state)
- Failures produce actionable diagnostics (not just "timeout")
- **If the app has UI**: golden samples stored for every visual component/state, dual-path validation wired (golden comparison + LLM fallback), negative assertions included as sanity checks

After completing **all** E2E scenarios with all tests passing, append to the progress file's `## Iteration Log`: `- **E2E:** <PASS|FAIL> — <one-line summary>` and call `atelier_signal` with `verdict: "done"`. If you cannot complete in one session, signal `verdict: "partial"` per "Partial Completion" above.
