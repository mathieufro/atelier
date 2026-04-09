---
name: reviewing-implementation
description: Code review — completeness, correctness, code quality, security, coherence, test coverage with mutation-testing mindset
stage: review-code
---

# Reviewing Implementation

You are reviewing code implemented by another agent. You have NO context from the implementer. Verify everything by reading actual code — don't trust implementation reports. Implementers finish suspiciously quickly and reports may be incomplete, inaccurate, or optimistic.

## Execution Strategy

Assess the scope of the diff before starting:

- **Small/focused** (handful of files, single component): run all passes yourself sequentially
- **Large** (many files, multiple components, complex diff): spawn a separate sub-agent per pass using the Task tool, each with clean context focused on its specific pass. Aggregate findings into a single review document with a combined verdict.

## Gather Context

Before reviewing, read CLAUDE.md / `agents.md` for project conventions, study existing code style and architecture patterns, understand the test conventions, check how similar features were implemented. Context helps distinguish real issues from stylistic differences.

## Load Context

Identify the requirements source (spec file + plan file). Get the diff (`git diff main...HEAD`). The review is always against the spec — requirements are the source of truth, not personal preferences.

## Scope: Everything You Read Is In Scope

**Every issue you find in code you read is in scope — regardless of whether it was introduced by this branch or existed before.** Pre-existing bugs, security holes, correctness problems, broken edge cases — if you see it, flag it. Never dismiss an issue because it's "pre-existing," "not part of this feature," or "out of scope." The codebase ships as a whole, not as isolated diffs. A bug is a bug whether it was written yesterday or last year.

This applies to all review passes below. If Pass 4 (Security) reveals a vulnerability in a file the branch merely imported from — flag it. If Pass 2 (Correctness) finds a logic error in a utility the new code calls — flag it. The fixer agent will handle the work; your job is to find every issue.

## Review Passes

### Pass 1: Completeness

- Every spec requirement implemented?
- Anything missing or skipped?
- Anything extra that wasn't requested?
- **Is the feature reachable?** Can a user actually invoke this feature through the application's entry points (routes, UI, CLI, config)? Code that works in isolation but isn't wired into the app is incomplete — flag it as a blocking issue.

### Pass 2: Correctness

- Does the implementation match what the spec says?
- Are edge cases handled?
- Any logic errors or misunderstandings?

### Pass 3: Code Quality

- Clear, maintainable, no over-engineering?
- Follows project patterns?
- No awkward integrations?

### Pass 4: Security

- Input validation where needed?
- No obvious vulnerabilities?
- Sensitive data handled properly?

### Pass 5: Coherence

- Fits with the existing codebase?
- Consistent with project style and architecture?
- Uses established patterns?

### Pass 6: Test Coverage (mutation-testing mindset)

- Are tests adequate? Testing the right things? Edge cases covered?
- For each critical test, consider: would this test still pass if the implementation had a subtle bug (off-by-one, wrong comparison operator, missing null check, swapped arguments)?
- Flag tautological tests — tests that verify what the code does rather than what the spec requires. Tests should verify spec behavior, not mirror implementation logic.

## Output

Write the review to the pipeline directory path provided by the orchestrator (e.g. `.atelier/pipelines/2026-02-25-auth-feature/impl-review.md`). If running standalone without orchestrator context, write to `.atelier/pipelines/YYYY-MM-DD-<feature>/impl-review.md`. Use structured format:

- **Header:** spec reference, review date, commits reviewed, branch name
- **Summary table:** issue counts by category (security, correctness, tests, code quality) and severity (critical, important, minor)
- **Blocking issues:** critical issues that must be fixed, listed prominently
- **All issues:** each with severity, category, file:line location, quoted spec requirement, problem description, and concrete suggested fix (with code)
- **Approved requirements:** checklist of spec requirements with pass/fail status
- **Recommendations:** non-blocking suggestions for improvement (optional)

Written as instructions addressed to a fixer agent. End with verdict: `done` (ready to merge) or `has_issues` (needs fixes).

## Signal (REQUIRED)

You MUST call `atelier_signal` with all three fields:
- `type`: `"stage_complete"`
- `outputPath`: the review file path you wrote
- `verdict`: `"done"` or `"has_issues"` — must match the verdict in your review document

Do NOT call `atelier_signal` without `verdict` and `outputPath`. A missing verdict will be treated as `has_issues`.

## Progress File

After completing the review, append to the progress file's `## Iteration Log` in the pipeline directory: `- **Code Review:** <PASS|FAIL> — <one-line summary>`.
