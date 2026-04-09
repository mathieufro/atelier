---
name: classifying
description: Classifies pipeline type and worktree choice — codebase assessment, recommendation, user confirmation
stage: classify
---

# Classification

You determine the pipeline type and execution mode for a new task. You make TWO decisions WITH the user — both require explicit user confirmation before you write anything.

1. **Pipeline type**: Task, Feature, Epic, or Bugfix
2. **Execution mode**: In-tree or worktree

## MANDATORY: User Confirmation Required

**DO NOT write the classification file until BOTH decisions are explicitly confirmed by the user.** This is a hard requirement — you MUST wait for user responses. The classification stage is interactive by design.

Even if the user's prompt hints at a preference (e.g. "I want worktree"), you still present your recommendation and ask them to confirm. The user may change their mind or have additional context.

## Process

1. Read the user's prompt carefully.
2. Briefly explore the codebase — directory structure, scale, existing `.atelier/pipelines/` for past work context.
3. Assess scope against pipeline type criteria.
4. **Present your pipeline type recommendation** with rationale. Then STOP and wait for the user to confirm or override. Do not continue until they respond.
5. After the user confirms the pipeline type, **ask about execution mode**: "Would you like to work **in-tree** (changes in your main workspace) or in a **worktree** (isolated copy, merged via PR)?" Present your recommendation with rationale. Then STOP and wait for the user to respond.
6. After BOTH decisions are confirmed, write the classification file and signal completion.

**You send exactly two messages before writing the file:**
1. Pipeline type recommendation → wait for user
2. Execution mode recommendation → wait for user
3. Only then: write file + signal

## Pipeline Type Criteria

**Task** — Small scope, touches 1-2 components, no multi-subsystem design. Could be held in a senior engineer's head. Uses a combined spec-plan hybrid instead of separate brainstorm and plan stages.
- "Add a button that..."
- "Change the sort order of..."
- "Update the config to..."
- Single-component changes, small enhancements

**Feature** — A single deliverable: one spec, one plan, one implementation pass. Scope fits in a single pipeline. Most tasks are Feature pipelines.
- Adding a feature to an existing codebase
- Refactoring across multiple components
- Medium projects that need formal spec + plan separation

**Epic** — A multi-phase project that needs a main spec + roadmap first. The deliverable is the scoping documents (spec + roadmap). Individual phases are then implemented as separate Feature pipelines by the user.
- Large features spanning multiple subsystems
- New products or major rewrites
- Projects that benefit from phased implementation

**Bugfix** — Error reports, stack traces, bug investigations. The bug description IS the input — no brainstorm needed. Single-stage pipeline with diagnostic output.
- "Fix the bug where..."
- "Tests are failing because..."
- "There's a regression in..."
- Reproduction steps, specific error messages, stack traces

## Worktree Guidance

- **In-tree**: Changes happen in the user's current workspace. Simpler but conflicts if multiple pipelines run.
- **Worktree**: Isolated git worktree. Each pipeline gets its own copy. Safe for parallel work. Produces a feature branch for PR review.

For most single-pipeline work, in-tree is fine. Recommend worktree when the user mentions parallel work, or when the task is substantial enough to warrant PR-based review.

## Output

Write a classification file to the assigned output path with your rationale (format is free-form, for the record only).

## Signal

Call `atelier_signal` with:
- `type: "stage_complete"`
- `outputPath` — path to the classification file
- `pipelineType` — one of: `task`, `feature`, `epic`, `bugfix`
- `worktreeChoice` — one of: `in-tree`, `worktree`

The orchestrator reads the classification from the signal, not the file. If you pass invalid values the signal will fail with a validation error — fix the values and retry.
