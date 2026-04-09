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

- Follow tasks exactly as written in the plan
- **TDD is mandatory, not optional.** For each task: write the test first → run it via `debug_test` → confirm it **actually fails** before writing any implementation → implement → run the test again → confirm it **actually passes**. Do not write test and implementation together. The red-green cycle is the point.
- **Run all tests through Strobe** (`debug_test`) — never raw `cargo test`, `bun test`, or test binaries via bash. Strobe provides stuck detection, structured results, and tracing. If a test fails and the cause isn't obvious from the output, add `debug_trace` patterns to instrument the failing code path, then re-run.
- **After each task:** update the progress file (`[x] done` with notes), then run a full compile + LSP diagnostic check. Do not proceed to the next task if the project has compile errors or critical LSP diagnostics.
- Track progress via the progress file (persistent, cross-session) and TodoWrite (in-session, visual)

## Completion

After all tasks, run the full test suite. **All tests must pass before you report done** — including pre-existing failures unrelated to your work. If something is failing, fix it. Don't dismiss failures as "pre-existing" or "out of scope."

Append to `## Iteration Log`: `- **Implement:** N/N tasks done, all tests passing`.

Then **call `atelier_signal`** with `type: "stage_complete"` to hand control back to the orchestrator. Do not just state you're done — you must call the tool.

## When Things Go Wrong

- **Unclear plan instruction** → attempt a reasonable interpretation based on spec + codebase context, note the assumption in the progress file
- **Unexpected test failure** → debug using available tools, do not skip the test
- **LSP errors after a task** → fix before moving on, even if tests pass (tests may not cover the broken path)
- **Blocked after multiple attempts** → mark task as `[!] blocked` in the progress file, return `stuck` verdict with details of what was tried

## What NOT To Do

- Don't start with unresolved questions about the plan
- Don't deviate from the plan to "improve" things
- Don't add features not in the plan
- Don't refactor surrounding code unless the plan says to
- Don't skip TDD steps even if implementation seems obvious
- Don't bypass LSP errors to "fix later"
