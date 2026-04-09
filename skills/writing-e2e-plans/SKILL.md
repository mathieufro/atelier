---
name: writing-e2e-plans
description: E2E test planning — environment research, scenario design, infrastructure architecture, visual validation strategy
stage: write-e2e-plan
---

# Writing E2E Plans

You are planning the E2E test strategy for a completed implementation. The plan must be detailed enough that the E2E implementer can execute with confidence — environment setup, scenario list, infrastructure design, and visual validation approach all decided here.

E2E means **the real application runs in the real environment**. A component test rendered in jsdom with simulated messages is a unit test wearing a costume. Your plan must target the actual production path.

## Before Writing Anything

1. **Read the spec** — understand what was built and what the acceptance criteria are
2. **Read the implementation** — understand the actual code, not just what the spec describes
3. **Explore the test infrastructure** — what E2E tooling already exists in this project? Existing fixtures, helpers, test runners?

## Step 1: Research the Real Environment

Answer: **how do I programmatically launch, drive, and observe the real application?**

Use web search, read documentation, study how similar projects write E2E tests. Check whether the host provides official test utilities (VS Code has `@vscode/test-electron`, Electron has Playwright, web apps have Playwright/Cypress, Go has `httptest`, etc.).

Document in the plan:
- **Launch**: how to programmatically start the real environment (command, API, test runner)
- **Interact**: how tests drive the application (API calls, UI automation, IPC, stdin/stdout)
- **Observe**: how tests verify results (responses, UI state, file artifacts, stdout/stderr, accessibility queries)
- **Dependencies**: what needs to be installed (packages, tools, runtimes)
- **Constraints**: known challenges (timing, cleanup, flakiness, CI limitations)

**Verify claims.** Read actual library docs and types. If you say "@vscode/test-electron provides `runTests()`" — confirm the function exists with the assumed signature. Every technical assertion must be traced to its source.

If research reveals the planned approach won't work, surface it in the plan as a constraint — don't hide it.

### External dependencies

Some dependencies are genuinely impractical to run in tests (paid APIs with no free tier, proprietary hardware, third-party SaaS). For these **only**:

1. Document why mocking is necessary (not just convenient)
2. Plan the mock at the outermost boundary (fake HTTP server, not a fake client)
3. Plan to use recorded real responses whenever possible
4. Mark these scenarios for future upgrade when the dependency becomes available

"It's complicated" is not impractical. "It costs money per call with no free tier and no local alternative" is.

## Step 2: Design Scenarios from the Spec

Decide WHAT to test. Each scenario = a spec requirement exercised through the actual production path.

- What journeys need testing beyond TDD unit tests?
- Focus on: full request/response cycles through real I/O, multi-process coordination, startup/shutdown, error recovery
- Consider all I/O surfaces: UI interactions, CLI commands, API endpoints, IPC, WebSockets, file operations, device protocols

**Scope to high-value journeys.** E2E tests are expensive. Test the critical paths that, if broken, mean the application doesn't work. Don't test what unit tests already cover.

For each scenario, document:
- **Name**: descriptive, reads like a user story (e.g. "User opens settings panel and changes theme")
- **Preconditions**: what state the app must be in before the test starts
- **Steps**: concrete interaction sequence
- **Expected outcome**: what to assert (response, UI state, file output, log message)
- **Spec requirement**: which spec item this scenario validates

**Assertion depth rule.** Every expected outcome must assert on *observable user-visible behavior*, not internal state or existence checks. "The server responds with 200" is not E2E — "the server responds with the created resource including the auto-generated ID, and a subsequent GET returns the same resource" is. Each scenario must have at least one assertion that would catch a real regression: data corruption, wrong routing, missing side effects, broken state transitions.

**Real-usage grounding.** Before finalizing scenarios, ask: "If this test passes but the feature is actually broken, what did I miss?" Every scenario must exercise a path that a real user would hit in their first 5 minutes of using the feature. If you can't describe the human action that triggers this path, the scenario is disconnected from real usage.

## Step 3: Design Test Infrastructure

Plan the fixture architecture:

- **Launch helper**: how tests start the real environment. Automated — no manual steps.
- **Ready-wait strategy**: how to detect readiness (health check, window appeared, webview loaded, port opened). No `sleep()` — poll or wait for a signal. Specify the signal.
- **Interaction helpers**: what helper functions/utilities tests need for driving the app through its real interfaces.
- **Observation helpers**: how tests capture real outputs (screenshots, API responses, logs, accessibility state).
- **Teardown strategy**: clean shutdown plan. Kill processes, delete temp files, close connections.
- **Isolation approach**: how each test gets clean state. Fresh server, clean database, new session.

**Specify a smoke test.** The first thing the E2E implementer should build: launch → wait for ready → one interaction → one assertion → tear down. Define it concretely.

## Step 4: Visual Validation Strategy (when app has a UI)

If the application has any visual interface, plan the visual validation approach:

- **Which components/states need visual validation** — list each screen, panel, or view that was created or modified
- **Capture strategy** — targeted, cropped screenshots per component (not full-window). Specify region/crop approach and scale factor (2x recommended).
- **Golden sample inventory** — list every golden sample needed with descriptive names (e.g. `settings-panel-default.png`, `chat-empty-state.png`)
- **Dual-path validation design** — golden image comparison (fast path) + LLM semantic validation (fallback). Specify:
  - Pixel diff method and tolerance threshold
  - Visual checks per component (yes/no questions about specific visual properties)
  - Negative assertions (known-false questions to verify LLM isn't rubber-stamping)
  - Auto-update policy for golden samples
  - Rate limiting for LLM calls (10–15s base + jitter)

If the application has no visual interface, state this explicitly and skip.

## Plan Output

Write the plan to the pipeline directory path provided by the orchestrator (e.g. `.atelier/pipelines/2026-02-25-auth-feature/e2e-plan.md`). If running standalone without orchestrator context, write to `.atelier/pipelines/YYYY-MM-DD-<feature>/e2e-plan.md`.

**Structure:**

```
# E2E Test Plan: <feature>

## Environment
[Launch, interact, observe, dependencies, constraints from Step 1]

## Scenarios
[Scenario list from Step 2, each with name/preconditions/steps/expected/spec-ref]

## Infrastructure
[Fixture architecture from Step 3, including smoke test definition]

## Visual Validation (if applicable)
[Strategy from Step 4]
```

## Progress File

After writing the plan, update the progress file in the pipeline directory (`progress.md`):

1. Populate the `## Tasks` table with one row per scenario (all `[ ] pending`), plus infrastructure tasks (smoke test, fixture setup)
2. Update the `## Summary` counts to match
3. Append to `## Iteration Log`: `- **E2E Plan:** wrote <path>, N scenarios`

If the progress file doesn't exist (standalone use), create it with the bare structure (`# Progress`, `## Summary`, `## Tasks`, `## Iteration Log`).
