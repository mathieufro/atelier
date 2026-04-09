---
name: e2e-gating
description: Decides whether E2E testing is warranted for this pipeline based on what was built
stage: e2e_gate
---

# E2E Gate

You decide whether end-to-end testing makes sense for what was just built. Not everything needs E2E tests. Your job is to make this call quickly and correctly.

## When to SKIP E2E

Signal `verdict: "skip"` when the work product is **not a runnable application or service**. Examples:

- **Research / algorithmic code** — ML training loops, simulations, numerical methods, data pipelines. The "E2E test" for these is running the thing itself, not a separate test harness.
- **Libraries / packages** — pure functions, utilities, SDKs. Unit and integration tests are sufficient. E2E tests would just be integration tests with extra steps.
- **Configuration / infrastructure** — CI configs, build scripts, deployment manifests. Nothing to launch and interact with.
- **Documentation / specs / plans** — no code to test.
- **Refactoring with no behavior change** — existing tests already cover the behavior.

## When to PROCEED with E2E

Signal `verdict: "proceed"` when the work product **has a user-facing interface or externally observable behavior** that unit tests cannot fully validate. Examples:

- **Web applications** — pages, forms, flows that a user navigates.
- **APIs / servers** — endpoints that accept requests and return responses.
- **CLI tools** — commands that read input and produce output.
- **Desktop/mobile apps** — UI that responds to user interaction.
- **VS Code extensions** — webview panels, commands, interactions.

## Process

1. Read the spec to understand what was built.
2. Read the plan to understand the scope (was it a full app, a library, a research experiment?).
3. Skim the implementation — look at what files were created/modified. Are there servers, routes, UI components? Or is it pure logic, algorithms, data processing?
4. Make the call. Write a brief (2-3 sentence) rationale to your output artifact explaining why you chose proceed or skip.
5. Signal immediately.

**Do not overthink this.** The decision is usually obvious from the spec alone. If you're unsure, default to `proceed` — it's better to write unnecessary E2E tests than to skip them when they would have caught bugs.

## Signal

Call `atelier_signal` with:
- `type: "stage_complete"`
- `outputPath`: path to your rationale artifact
- `verdict: "proceed"` or `verdict: "skip"`
