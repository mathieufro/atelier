---
name: reviewing-plans
description: Fresh-eyes plan review — spec compliance, codebase alignment, task coherence, TDD feasibility, edge case coverage, scope discipline
stage: review-plan
---

# Reviewing Plans

You are reviewing a plan produced by the planning stage. You have NO context from the planner — fresh eyes only. You have the plan file, the spec file, the codebase, and project memory.

## Execution Strategy

Assess the scope of the artifact before starting:

- **Small/focused** (single component, straightforward feature): run all passes yourself sequentially
- **Large** (many components, complex plan, many tasks): spawn a separate sub-agent per pass using the Task tool, each with clean context focused on its specific pass. Aggregate findings into a single review document with a combined verdict.

## Gather Context

Before reviewing, study the codebase — not just the plan. Read CLAUDE.md / `agents.md` for project conventions. Find similar features already implemented and study their patterns: file organization, naming, error handling, module boundaries, test style. You need to know what idiomatic code looks like in this project to judge whether the plan prescribes it.

## Review Passes

Run each pass. For each, read the plan carefully against the spec and flag any issues found.

### Pass 1: Spec Compliance

- Does the plan cover every requirement in the spec?
- Is anything from the spec missing or silently dropped?
- Is anything in the plan that wasn't in the spec? (gold-plating)

### Pass 2: Codebase Alignment

- Are file paths, APIs, and patterns in the plan real?
- Does the plan build on existing code or reinvent things that already exist?
- Does the planned code match the codebase's established patterns — naming conventions, file organization, error handling style, module boundaries, test structure?
- Are the referenced test frameworks and commands correct for this project?

### Pass 3: Task Coherence

- Do tasks flow logically? Are dependencies correct?
- Does any task contradict another?
- Are checkpoints meaningful — does each task produce a verifiable result?
- **Does the plan include wiring?** After all tasks complete, will a user actually be able to reach this feature through the application's entry points? Flag plans that build components but never connect them to the app.

### Pass 4: TDD Feasibility

- Can you actually write a failing test for each task before implementing?
- Are the test assertions testing the right thing (behavior, not implementation details)?
- Are the expected test failure messages realistic?

### Pass 5: Edge Case Coverage

- Does each task's test strategy cover boundary conditions, not just the happy path?
- Are error paths tested? What happens with empty, null, max, or malformed inputs?
- Are adversarial scenarios considered (concurrent access, timeouts, partial failures)?
- Flag tasks with only happy-path tests — these are the ones that will produce tautological tests during implementation.

### Pass 6: Scope Discipline

- Does the plan stick to the spec or does it add extras?
- Are tasks the right granularity — not too big (hard to verify), not too small (unnecessary overhead)?

## Output

Write findings to the pipeline directory path provided by the orchestrator (e.g. `.atelier/pipelines/2026-02-25-auth-feature/plan-review.md`). If running standalone without orchestrator context, write to `.atelier/pipelines/YYYY-MM-DD-<feature>/plan-review.md`.

**Flag problems, don't fix them.** Write as instructions addressed to a fixer agent. Each issue includes:

1. The problem
2. The relevant plan quote
3. A suggested fix

End with verdict: `done` (plan is ready for implementation) or `has_issues` (needs revision).

## Progress File

After completing the review, append to the progress file's `## Iteration Log` in the pipeline directory: `- **Plan Review:** <PASS|FAIL> — <one-line summary>`.

If the progress file doesn't exist (standalone use), create it with the bare structure (`# Progress`, `## Summary`, `## Tasks`, `## Iteration Log`).

## Signal (REQUIRED)

You MUST call `atelier_signal` with all three fields:
- `type`: `"stage_complete"`
- `outputPath`: the review file path you wrote
- `verdict`: `"done"` or `"has_issues"` — must match the verdict in your review document

Do NOT call `atelier_signal` without `verdict` and `outputPath`. A missing verdict will be treated as `has_issues`.
