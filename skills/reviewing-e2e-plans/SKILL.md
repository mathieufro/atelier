---
name: reviewing-e2e-plans
description: Fresh-eyes E2E plan review — environment feasibility, scenario coverage, infrastructure soundness, visual validation strategy, scope discipline
stage: review-e2e-plan
---

# Reviewing E2E Plans

You are reviewing an E2E test plan produced by the E2E planning stage. You have NO context from the planner — fresh eyes only. You have the E2E plan file, the spec file, the codebase, and project memory.

## Execution Strategy

Assess the scope of the plan before starting:

- **Small** (few scenarios, straightforward environment): run all passes yourself sequentially
- **Large** (many scenarios, complex environment, visual validation): spawn a separate sub-agent per pass using the Task tool, each with clean context focused on its specific pass. Aggregate findings into a single review document with a combined verdict.

## Gather Context

Before reviewing, study the codebase. Read CLAUDE.md / `agents.md` for project conventions. Find existing E2E tests in the project and study their patterns: how they launch the environment, how they interact with the app, how they assert results, how they clean up. You need to know what working E2E infrastructure looks like in this project.

Also read the spec thoroughly — you need it to judge whether the scenarios cover the right things.

## Review Passes

Run each pass. For each, read the plan carefully against the spec and flag any issues found.

### Pass 1: Environment Feasibility

- Is the proposed launch mechanism real? Does the library/tool actually exist with the assumed API?
- Is the interaction approach realistic for this host? (e.g. you can't use Playwright to drive a VS Code Extension Development Host)
- Is the observation strategy sound? Can you actually capture the proposed outputs?
- Are dependencies accurate and installable?
- Are known constraints acknowledged honestly, or are hard problems glossed over?

### Pass 2: Scenario Coverage

- Do scenarios cover every spec requirement that warrants E2E testing?
- Are critical paths covered? (The ones that, if broken, mean the app doesn't work)
- Are scenarios genuinely E2E, or are some just unit tests in disguise? (Testing a function in isolation is not E2E, even if the plan calls it one)
- Are error/failure scenarios included? (Connection drops, invalid input, timeouts, process crashes)
- Is anything tested that unit tests already cover? (Wasted E2E budget)
- Is anything missing that only E2E can catch? (Protocol mismatches, startup ordering, real latency, host constraints)

### Pass 3: Infrastructure Soundness

- Will the proposed fixture architecture actually work?
- Is the ready-wait strategy reliable? (No `sleep()` — signals or polls with timeouts)
- Is teardown thorough? (No orphaned processes, no leaked state between tests)
- Is isolation real? (Each test gets genuinely clean state, not just "we hope the previous test cleaned up")
- Is the smoke test concrete and minimal? (One launch, one interaction, one assertion — not a full journey masquerading as a smoke test)

### Pass 4: Visual Validation Strategy (if applicable)

- If the app has a UI and the plan has no visual validation — flag it as missing
- Are all visual components/states that were created or modified covered?
- Is the dual-path approach planned? (Golden comparison + LLM fallback — not just one or the other)
- Are negative assertions included? (Sanity checks against LLM rubber-stamping)
- Are golden sample names descriptive and scoped per component state?
- Is the capture strategy specific? (Cropped/region screenshots, not just full-window)

### Pass 5: Scope Discipline

- Are scenarios focused on high-value journeys, or is the plan testing everything?
- Is the plan realistic for the E2E stage's time budget?
- Are there scenarios that should be unit tests instead?
- Is anything overengineered? (Complex infrastructure for simple validation)

## Output

Write findings to the pipeline directory path provided by the orchestrator (e.g. `.atelier/pipelines/2026-02-25-auth-feature/e2e-plan-review.md`). If running standalone without orchestrator context, write to `.atelier/pipelines/YYYY-MM-DD-<feature>/e2e-plan-review.md`.

**Flag problems, don't fix them.** Write as instructions addressed to a fixer agent. Each issue includes:

1. The problem
2. The relevant plan quote
3. A suggested fix

End with verdict: `done` (plan is ready for E2E implementation) or `has_issues` (needs revision).

## Signal (REQUIRED)

You MUST call `atelier_signal` with all three fields:
- `type`: `"stage_complete"`
- `outputPath`: the review file path you wrote
- `verdict`: `"done"` or `"has_issues"` — must match the verdict in your review document

Do NOT call `atelier_signal` without `verdict` and `outputPath`. A missing verdict will be treated as `has_issues`.
