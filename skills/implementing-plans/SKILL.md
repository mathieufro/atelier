---
name: implementing-plans
description: Executes implementation plans — TDD cycle, progress tracking, LSP validation, blocker handling
stage: implement
---

# Implementing Plans

You are implementing a plan on a feature branch. Follow the plan exactly — your job is execution, not design.

## Before Starting

- Read the entire plan critically — identify any questions or concerns before touching code
- Read the progress file to see what's already done (critical for re-runs and crash recovery)
- Explore the codebase areas being modified — the plan provides steps, but context helps implement idiomatically
- Skip tasks already marked `[x] done` in the progress file

**Don't start implementing with unresolved questions about the plan.**

## Execution

- **Execute tasks in plan order, top to bottom.** Task 1, then Task 2, then Task 3. No prioritization. No batching by theme. No "I'll do the easy ones first." The plan was reviewed in this order; your job is to execute in this order.
- If Task N is blocked, **do not skip ahead** to Task N+1. Either resolve the blocker (debug it, read the relevant code, instrument with Strobe) or signal `verdict: "partial"` (see below). Out-of-order execution breaks downstream task assumptions and is the single most common cause of plan-drift.
- **TDD is mandatory, not optional.** For each task: write the test first → run it via `debug_test` → confirm it **actually fails** before writing any implementation → implement → run the test again → confirm it **actually passes**. Do not write test and implementation together. The red-green cycle is the point.
- **Run all tests through Strobe** (`debug_test`) — never raw `cargo test`, `bun test`, or test binaries via bash. Strobe provides stuck detection, structured results, and tracing. If a test fails and the cause isn't obvious from the output, add `debug_trace` patterns to instrument the failing code path, then re-run.
- **After each task:** update the progress file (`[x] done` with notes), then run a full compile + LSP diagnostic check. Do not proceed to the next task if the project has compile errors or critical LSP diagnostics.
- Track progress via the progress file (persistent, cross-session) and TodoWrite (in-session, visual)

## Partial Completion — Use It Freely

Large plans do not have to fit in one session. The orchestrator supports a "partial" signal that hands control back, then **restarts you with a fresh session** so you can continue from where the progress file left off. There is **no penalty** for partial completion — it is the expected path on multi-task plans.

**Signal partial when any of these is true:**
- Your context budget is approaching ~70% used.
- You have completed at least one task and feel reluctance to continue (this reluctance is laziness — interpret it as a signal to hand off).
- The next task requires extensive new exploration that would push you over budget.
- You hit a blocker on the current task and need a fresh session to attack it differently.

**How to signal partial:**

1. Make sure the progress file accurately reflects what's done (`[x] done` with notes) and what's pending. The next session reads this file as its source of truth.
2. Append a one-line entry to `## Iteration Log`: `- **Implement (partial):** N/M tasks done — <one-line summary of what's left>`.
3. Call `atelier_signal` with `type: "stage_complete"`, `verdict: "partial"`, and `outputPath` set to the absolute path of the progress file. The orchestrator requires `outputPath` on partial signals.
4. The orchestrator will spawn a fresh session that reads the same plan + progress file and resumes at the next pending task.

**Do not** try to push through a 30-task plan in one session by skipping TDD, batching tests, or rushing. Signal partial and restart fresh.

## Completion

After all tasks, run the full test suite. **All tests must pass before you report done** — including pre-existing failures unrelated to your work. If something is failing, fix it. Don't dismiss failures as "pre-existing" or "out of scope."

Append to `## Iteration Log`: `- **Implement:** N/N tasks done, all tests passing`.

Then **call `atelier_signal`** with `type: "stage_complete"` and `verdict: "done"` to hand control back to the orchestrator. Do not just state you're done — you must call the tool.

## When Things Go Wrong

- **Unclear plan instruction** → attempt a reasonable interpretation based on spec + codebase context, note the assumption in the progress file. Do not skip to a later task.
- **Unexpected test failure** → debug using available tools, do not skip the test
- **LSP errors after a task** → fix before moving on, even if tests pass (tests may not cover the broken path)
- **Blocked after multiple attempts on a single task** → mark task as `[!] blocked` in the progress file and signal `verdict: "partial"`. The next session may have a different angle.
- **Truly stuck** (entire plan is unworkable, not a single-task block) → signal `verdict: "stuck"` with a paragraph in `## Iteration Log` explaining why. This pauses the pipeline for user intervention. Reserve for actual dead-ends — partial is the right tool for "ran out of budget."

## What NOT To Do

- Don't start with unresolved questions about the plan
- Don't deviate from the plan to "improve" things
- Don't add features not in the plan
- Don't refactor surrounding code unless the plan says to
- Don't skip TDD steps even if implementation seems obvious
- Don't bypass LSP errors to "fix later"
- **Don't skip ahead to later tasks** when an earlier one is blocked — signal partial instead
- **Don't try to one-shot a large plan.** Partial signals exist for a reason. Use them.
