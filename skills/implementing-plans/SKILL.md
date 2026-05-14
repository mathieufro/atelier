---
name: implementing-plans
description: Executes implementation plans — TDD cycle, progress tracking, LSP validation, blocker handling
stage: implement
---

# Implementing Plans

You are implementing a plan on a feature branch. Follow the plan exactly — your job is execution, not design.

## ⚠️ IMPORTANT — READ THIS FIRST

**Every task you touch, you finish 100%. No skimming. No shortcuts. No "good enough." And you do not hand off before completing at least one task — plan length is never a reason to bail.**

- A task is **done** when its test is written, run, **observed to fail**, then implementation is written, the test runs **green**, and the full suite passes. Anything less is **not done**.
- **NEVER** mark a task `[x] done` if you skipped writing the test, skipped running it, skipped a TDD step, or left an LSP error / lint error / type error behind. Half-finished work in the progress file is worse than no work.
- **NEVER** apply a shortcut "for now" and plan to come back. You will not come back. The next session will trust the progress file.
- **NEVER** implement multiple tasks at once with a single shared test, or a single combined commit, or a "I'll write tests after" deferment. One task = one full TDD cycle = one verified completion.
- **NEVER** write a test that doesn't actually exercise the production code path you implemented. Read your own assertion and ask: "if I deleted my implementation, would this fail?" If no, the test is broken.
- **NEVER** signal `partial` or `stuck` with zero tasks completed in this session. Reading the plan and exploring code is not work — shipping a green test + implementation is. If you've done none, keep going.
- **`verdict: "partial"` is for between tasks, not within a task.** If you started a task and got tired, finish it first, then signal.

The two failure modes: doing 5 tasks at 60% quality and signaling done, *or* doing 0 tasks and bailing because the plan looks big. The correct mode: do as many tasks as fit at 100% quality, then signal partial.

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

## Partial Completion — Earn It, Then Use It

Large plans do not have to fit in one session. The orchestrator supports a `partial` signal that hands control back and **restarts you with a fresh session** at the next pending task. There's no penalty for partial completion — but you have to actually complete something first.

**Before signaling partial, you must have:**
- Completed at least one full task in this session (red → green → suite passing → `[x] done` in the progress file).
- Real budget pressure: context ~80%+ used, or the next task requires exploration you genuinely can't afford. "Feels like a lot" doesn't count.

**How to signal partial:**

1. Make sure the progress file accurately reflects what's done (`[x] done` with notes) and what's pending.
2. Append a one-line entry to `## Iteration Log`: `- **Implement (partial):** N/M tasks done — <one-line summary of what's left>`.
3. Call `atelier_signal` with `type: "stage_complete"`, `verdict: "partial"`, and `outputPath` set to the absolute path of the progress file.
4. The orchestrator will spawn a fresh session that resumes at the next pending task.

**Your default is to spend context, not conserve it.** Execute tasks until the budget is actually tight — not until the plan starts feeling big. Plan length is the orchestrator's problem.

## Completion

After all tasks, run the full test suite. **All tests must pass before you report done** — including pre-existing failures unrelated to your work. If something is failing, fix it. Don't dismiss failures as "pre-existing" or "out of scope."

Append to `## Iteration Log`: `- **Implement:** N/N tasks done, all tests passing`.

Then **call `atelier_signal`** with `type: "stage_complete"` and `verdict: "done"` to hand control back to the orchestrator. Do not just state you're done — you must call the tool.

## When Things Go Wrong

- **Unclear plan instruction** → attempt a reasonable interpretation based on spec + codebase context, note the assumption in the progress file. Do not skip to a later task.
- **Unexpected test failure** → debug using available tools, do not skip the test
- **LSP errors after a task** → fix before moving on, even if tests pass (tests may not cover the broken path)
- **Blocked after multiple attempts on a single task** → if you've already completed an earlier task this session, mark it `[!] blocked` and signal `partial`. If you haven't completed anything yet, keep attacking — read more code, instrument with Strobe, try a different angle.
- **Truly stuck** (plan is internally inconsistent or contradicts the codebase) → signal `verdict: "stuck"` with a paragraph in `## Iteration Log` explaining the specific contradiction. Plan size or complexity is never a stuck condition.

## What NOT To Do

- Don't start with unresolved questions about the plan
- Don't deviate from the plan to "improve" things
- Don't add features not in the plan
- Don't refactor surrounding code unless the plan says to
- Don't skip TDD steps even if implementation seems obvious
- Don't bypass LSP errors to "fix later"
- **Don't skip ahead to later tasks** when an earlier one is blocked — debug it, or (after at least one task done) signal partial
- **Don't signal partial or stuck before completing at least one task this session.** Reading and exploring don't count.
- **Don't read the plan, decide it's "too big," and bail.** Execute tasks until context is actually tight.
