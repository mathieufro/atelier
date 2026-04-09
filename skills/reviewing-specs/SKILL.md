---
name: reviewing-specs
description: Fresh-eyes spec review — internal consistency, completeness, codebase alignment, scope clarity, conditional SOTA validation
stage: review-spec
---

# Reviewing Specs

You are reviewing a spec produced by the brainstorm stage. You have NO context from the brainstorm — you see only the spec file, the codebase, and project memory. This is deliberate: fresh eyes catch what context-fatigued agents miss.

## Execution Strategy

Assess the scope of the artifact before starting:

- **Small/focused** (single component, straightforward feature): run all passes yourself sequentially
- **Large** (many components, complex architecture, large spec): spawn a separate sub-agent per pass using the Task tool, each with clean context focused on its specific pass. Aggregate findings into a single review document with a combined verdict.

## Gather Context

Before reviewing, explore the codebase. Read CLAUDE.md / `agents.md` for project conventions. Study the existing architecture, patterns, and integration points relevant to the spec's scope. You need codebase context to judge whether the spec's proposed architecture is realistic and aligned with what exists.

## Review Passes

Run each pass. For each, read the spec carefully and flag any issues found.

### Pass 1: Internal Consistency

- Does the spec contradict itself anywhere?
- Are terms used consistently throughout?
- Do the architecture decisions align with the stated goals?

### Pass 2: Completeness

- Are there gaps that would leave a planner guessing?
- Are edge cases addressed or explicitly deferred?
- Are error handling expectations clear?
- Are success criteria concrete and testable?
- If the spec's scope is large (multiple subsystems, independent components), is it detailed enough to phase from? All components, interfaces, and integration points should be described well enough that someone could draw phase boundaries. (This does not mean the spec must contain phases — phasing happens in a separate roadmap brainstorm — but the spec must be complete enough to support phasing.)

### Pass 3: Codebase Alignment

- Do referenced APIs, modules, and files actually exist?
- Does the spec respect existing architecture patterns?
- Are integration points with existing code realistic?
- Does it build on what exists or fight against it?

### Pass 4: Scope Clarity

- Is the boundary between in-scope and out-of-scope unambiguous?
- Could a planner reasonably disagree about what's included?

### Pass 5: SOTA Validation (conditional)

**Only run this pass when** the spec introduces a new technology, pattern, or domain that doesn't already exist in the codebase.

**Skip for** incremental feature work on established stack.

- Web research: look up best practices, common pitfalls, and industry-standard approaches for the new element
- Flag if the spec's approach diverges significantly from SOTA without justification

### Pass 6: Validation Protocol

- Is there a Validation Protocol section in the spec?
- If marked N/A: is the rationale valid? Does the feature truly have no executable behavior to validate?
- If present: are the commands concrete and copy-pasteable? (Not "run the tests" but "`bun run test`" or "`pytest tests/ -v`")
- Are success criteria observable? (Exit code, file content, output pattern — not "it should work")
- Is failure diagnosis guidance included? (How to read test output to identify what's broken)
- Could the validate stage execute this protocol as-is without interpretation?

## Output

Write findings to the pipeline directory path provided by the orchestrator (e.g. `.atelier/pipelines/2026-02-25-auth-feature/spec-review.md`). If running standalone without orchestrator context, write to `.atelier/pipelines/YYYY-MM-DD-<feature>/spec-review.md`.

**Do NOT redesign the spec.** Flag problems with specific quotes from the spec and clear descriptions of what's wrong.

**Write as instructions addressed to a fixer.** Each issue includes:

1. The problem
2. The relevant spec quote
3. A suggested fix

End with verdict: `done` (spec is ready for planning — or for roadmap brainstorming if the scope warrants phasing) or `has_issues` (needs revision).

## Signal (REQUIRED)

You MUST call `atelier_signal` with all three fields:
- `type`: `"stage_complete"`
- `outputPath`: the review file path you wrote
- `verdict`: `"done"` or `"has_issues"` — must match the verdict in your review document

Do NOT call `atelier_signal` without `verdict` and `outputPath`. A missing verdict will be treated as `has_issues`.

## Progress File

After completing the review, append to the progress file's `## Iteration Log` in the pipeline directory: `- **Spec Review:** <PASS|FAIL> — <one-line summary>`.

If the progress file doesn't exist (standalone use), create it with the bare structure (`# Progress`, `## Summary`, `## Tasks`, `## Iteration Log`).
