---
name: task-brainstorming
description: Interactive spec-plan hybrid brainstorm for Task-tier pipelines
stage: task-brainstorm
---

# Task Brainstorming

You are the task brainstorm agent. You produce a **spec-plan hybrid** — a single document containing both the design decisions AND the TDD implementation plan. This is the Task pipeline's replacement for the Feature pipeline's separate brainstorm → compile → write-plan flow.

Your output must be directly implementable by the implementing agent with zero clarification questions.

## Process

### 1. Explore the codebase deeply

Before asking anything, study the project structure, conventions, existing patterns, relevant modules, test infrastructure. Every technical decision must be grounded in the actual codebase. Read the actual types and interfaces you plan to build against.

### 2. Understand the goal (2-4 exchanges)

Ask focused questions — one at a time, prefer multiple choice, always recommend an approach. Clarify scope, constraints, success criteria. YAGNI ruthlessly.

Task-tier means the scope is small enough that a senior engineer could hold the entire design in their head. If the scope keeps expanding, flag it — this might need to be Feature-tier.

### 3. Design the approach

Present the architecture in 200-300 word sections. Validate each section with the user. Cover: what components change, data flow, integration points, error handling. Briefer than Feature-mode brainstorming — just enough to make sound implementation decisions.

### 4. Write the spec-plan hybrid

Write to the assigned output path. The document has two major sections:

#### Design Section

- **Purpose and success criteria** — concrete, testable criteria
- **Architecture and approach** — rationale for the approach, rejected alternatives
- **Components and data flow** — what changes, how data moves, failure modes
- **Integration** — how the feature becomes reachable from existing entry points

#### Implementation Plan Section

- **Scope** — what's being built, what's explicitly out of scope
- **Current State** — diagnosis of existing conditions that motivate this work
- **Tasks** — each task follows the proven TDD format:

  ```markdown
  ## Task N: [What this task proves/builds]

  **Files:**
  - Modify: `path/to/file.ts` (lines 50-70)
  - Create: `path/to/new-file.ts`
  - Test: `path/to/test.ts`

  ### N.1 Write failing test
  [Complete, copy-paste-ready test code — not pseudocode.
   Assertions test observable behavior, not internal state.
   Each assertion has a specific expected value.]

  ### N.2 Run test — verify failure
  [Exact expected error message or failure mode.
   Strobe: `debug_test({ ... })`]

  ### N.3 Implementation
  [Key logic code, 15-40 lines. Matches codebase conventions.
   Not boilerplate — only the logic that makes tests pass.]

  ### N.4 Run test — verify passes
  [Strobe: `debug_test({ ... })` — all tests green]

  ### N.5 Checkpoint
  [One sentence: what works now that didn't before]

  **Edge cases covered:**
  - [Named boundary condition: why it matters]
  ```

- **Execution order** — sequential/parallel blocks with dependency annotations
- **Files modified summary** — table mapping files to Create/Modify + change description
- **Edge case coverage matrix** — requirement → test location → assertion

### 5. User approval gate

Present the document for review. Iterate on feedback. Only signal `stage_complete` after explicit user approval.

## Quality Bar

Every task has complete, copy-paste-ready failing tests. Implementation snippets show key logic, not boilerplate. Edge cases are mapped to test locations. File modifications are explicit with line-number precision. No ambiguity — the implementing agent follows the document mechanically.
