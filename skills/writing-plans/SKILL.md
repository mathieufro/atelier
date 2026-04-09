---
name: writing-plans
description: Creates implementation plans from specs — TDD task breakdown, edge case coverage, zero ambiguity, progress file task population
stage: write-plan
---

# Writing Plans

You are creating an implementation plan from a finalized spec. The plan must be detailed enough that the implementer can execute with minimum codebase context and zero design decisions — everything is decided here.

## Core Principles

**TDD. YAGNI. DRY.** Every task follows test-driven development. Build only what the spec requires. Don't repeat yourself.

## Codebase Exploration

Before writing anything, deeply explore the codebase areas that will be modified. Study existing code, understand current architecture, check `docs/` for relevant documentation, understand the test setup and conventions.

**Match the codebase's patterns.** Find similar features already implemented and study how they're structured — file organization, naming conventions, error handling style, how modules communicate, how tests are written. The plan should prescribe code that looks like it belongs in this codebase, not code that works but feels foreign.

The more context you absorb, the more precise and idiomatic the plan. Don't write generic plans — write plans that fit THIS codebase.

## Plan Structure

Write the plan to the pipeline directory path provided by the orchestrator (e.g. `.atelier/pipelines/2026-02-25-auth-feature/plan.md`). If running standalone without orchestrator context, write to `.atelier/pipelines/YYYY-MM-DD-<feature>/plan.md`.

**Header:**

- Goal (one sentence)
- Spec reference (path to the spec file in the pipeline directory)
- Architecture approach (2-3 sentences)
- Tech stack (key technologies/libraries)

**Body:** Serial ordered task list.

## Task Format (TDD)

Each task = one logical unit following TDD.

For each task:

1. **Files:** exact paths (create/modify/test) with line ranges for modifications
2. **Write the failing test** — exact test code
3. **Run test via Strobe `debug_test` — verify it fails** — expected error
4. **Write minimal implementation** — exact code
5. **Run test via Strobe `debug_test` — verify it passes**
6. **Checkpoint:** what should work after this task

### What Makes a Good Test

**Test observable behavior, not implementation details.** A test should break only when the system's contract changes, never when internals are refactored. Assert on outputs, side effects, and state transitions — not on which internal methods were called or in what order.

**Every assertion must be specific and falsifiable.** Ban vacuous assertions — "is defined", "is truthy", "is not null" — as primary checks. If a test can't fail due to a real bug, it's noise. Each test must assert a concrete value, state change, or behavioral outcome.

**Don't duplicate the type system.** If the language's type system (static types, traits, interfaces) already enforces a contract at compile time, don't retest it at runtime. Test the *behavior* that uses the contract, not the contract's shape. A test that assigns a value and asserts it equals itself is worthless.

**Mock at boundaries, not internally.** Mock external systems (network, filesystem, hardware, time, random) — never mock the unit under test or its direct collaborators. When the codebase provides real test infrastructure (temp dirs, in-memory stores, test fixtures), prefer it over mocks. Over-mocking produces tests that pass while the real system is broken.

**One behavior per test, multiple inputs welcome.** Each test targets one behavioral aspect but should exercise it thoroughly. Use parameterized/table-driven tests when verifying the same logic across multiple inputs — don't copy-paste the same test body with different values.

### Edge Cases

Don't just cover the happy path. Think adversarially for each task:

- **Boundaries:** empty/zero, one, maximum, off-by-one, overflow/wraparound
- **Invalid input:** malformed data, wrong types (in dynamic languages), out-of-range values
- **Error paths:** network failures, corrupt state, permission denied, resource exhaustion
- **Concurrency:** race conditions, reentrant calls, out-of-order events
- **State transitions:** initial state, already-in-target-state, invalid transitions
- **Security:** injection, path traversal, untrusted input at system boundaries

Each task gets a dedicated "Edge cases" subsection listing which of these the tests cover and why they matter.

### Zero Ambiguity

Complete code snippets, not "add validation". Exact test commands with expected output. The implementer should not need to make any design decisions — every decision is made in the plan.

### Integration Tests

Unit tests verify each module in isolation. Integration tests verify that modules work together across boundaries. **The plan must include integration tests for tasks that wire modules together.**

When a task connects two or more components built in this plan (or connects new code to existing systems), that task's tests should exercise the data flow across the seam — not re-test internal logic. Feed realistic input at one end, assert on the output or side effect at the other end.

Integration tests belong on wiring tasks, not on every task. Typical triggers:
- A new module is registered with a framework or router
- Two components built in separate tasks now communicate (events, callbacks, IPC, protocol messages)
- New code reads/writes shared state (files, databases, shared memory)

Keep integration tests focused on the contract at the boundary: correct data format in, correct behavior out, and error propagation across the seam.

## Task Ordering

- Group tasks touching the same modules together
- Order for minimal context switching — finish one area before moving to the next
- **The final task(s) must wire the feature into the application.** Register routes, mount components, update configs, add menu items — whatever makes the feature reachable through the app's existing entry points. A plan that builds working components but never connects them to the app ships dead code.

## Progress File

After writing the plan, update the progress file in the pipeline directory (`progress.md`):

1. Populate the `## Tasks` table with one row per task from the plan, all set to `[ ] pending`
2. Update the `## Summary` counts to match
3. Append to `## Iteration Log`: `- **Plan:** wrote <path>, N tasks`

If the progress file doesn't exist (standalone use), create it with the bare structure (`# Progress`, `## Summary`, `## Tasks`, `## Iteration Log`).

Call `atelier_signal` with `type: "stage_complete"` and `outputPath` set to the plan file path.
