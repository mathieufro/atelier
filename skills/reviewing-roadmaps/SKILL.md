---
name: reviewing-roadmaps
description: Fresh-eyes roadmap review — phase scoping, dependency correctness, validation concreteness, main spec coverage, interface contracts
stage: review-roadmap
---

# Reviewing Roadmaps

You are reviewing a roadmap produced by the roadmap brainstorm stage. You have NO context from the brainstorm — you see only the roadmap file, the main spec, the codebase, and project memory. This is deliberate: fresh eyes catch what context-fatigued agents miss.

## Execution Strategy

Assess the scope of the artifact before starting:

- **Small** (3-4 phases, straightforward decomposition): run all passes yourself sequentially
- **Large** (many phases, complex dependencies, large main spec): spawn a separate sub-agent per pass using the Task tool, each with clean context focused on its specific pass. Aggregate findings into a single review document with a combined verdict.

## Gather Context

Before reviewing, read the main spec thoroughly. Understand the full system design — all components, interfaces, subsystems, and integration points. You need this to judge whether the roadmap's phasing covers everything and whether phase boundaries are drawn at natural seams in the architecture.

Also explore the codebase. Read CLAUDE.md / `agents.md` for project conventions. The roadmap's phasing should be compatible with the codebase's current state (e.g., if there's existing infrastructure, early phases should build on it rather than ignore it).

## Review Passes

Run each pass. For each, read the roadmap carefully against the main spec and flag any issues found.

### Pass 1: Phase Scoping Quality

- Is each phase well-bounded? Could an engineer reasonably know what's in scope vs out of scope?
- Are phase boundaries drawn at natural architectural seams, or do they cut across tightly coupled components?
- Is each phase's scope achievable as a single pipeline run, or is it too large?
- Are "what does NOT get built" items genuinely excluded, or are they implicit dependencies that will block the phase?

### Pass 2: Dependency Correctness

- Do dependencies form a valid DAG? Any circular dependencies?
- Are there missing dependencies? (Phase B needs something from Phase A but doesn't list A as a dependency)
- Are there unnecessary dependencies? (Phase B lists Phase A as a dependency but doesn't actually need anything from it)
- Is the ordering sensible? Would a different order reduce risk or simplify integration?

### Pass 3: Validation Criteria

- Are validation criteria concrete enough to objectively determine pass/fail?
- Could a different engineer read the validation section and know exactly what to test?
- Do validation criteria test what the phase *proves*, not just what it builds?
- Are there phases with vague validation ("verify it works") that need specifics?

### Pass 4: Main Spec Coverage

- Does the union of all phases' "what gets built" cover the entire main spec?
- Are there components, features, or requirements in the main spec that no phase addresses?
- Are there items in the roadmap that aren't in the main spec? (scope creep)
- Is there overlap between phases? (two phases building the same thing)

### Pass 5: Interface Contracts

- Are contracts between dependent phases defined? (APIs, shared types, events, file conventions)
- Are they sufficient for the dependent phase to build against without guessing?
- Do interface contracts match what the main spec describes for those boundaries?

### Pass 6: Goal Framing

- Is each phase's goal stated as "what it proves" rather than just "what it builds"?
- Do the goals build a coherent narrative? (each phase proves a capability that enables the next)
- Is the overall progression logical? (foundational capabilities first, integration last)

## Structural Check

Verify the roadmap follows the prescribed structure:

- Header: title, overview paragraph, methodology note, main spec reference
- Per phase: Goal, What gets built, What does NOT get built, Dependencies, Validation
- Footer: dependency graph (ASCII), execution model statement

Flag any missing structural elements.

## Progress File

Read the progress file (`<topic>-progress.md` in the pipeline directory) before starting. Check the Pipeline table for stage statuses and the Iteration Log for any previous review iterations. If this is a re-review after a fixer pass, focus your review on whether the fixer's changes addressed the previous findings — don't re-review unchanged sections in full.

## Output

Write findings to the pipeline directory path provided by the orchestrator (e.g. `.atelier/pipelines/2026-02-25-auth-system/roadmap-review.md`). If running standalone without orchestrator context, write to `.atelier/pipelines/YYYY-MM-DD-<feature>/roadmap-review.md`.

**Do NOT redesign the roadmap.** Flag problems with specific quotes from the roadmap and clear descriptions of what's wrong.

**Write as instructions addressed to a fixer.** Each issue includes:

1. The problem
2. The relevant roadmap quote
3. A suggested fix

End with verdict: `done` (roadmap is ready for per-phase brainstorms) or `has_issues` (needs revision).
