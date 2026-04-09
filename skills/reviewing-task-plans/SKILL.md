---
name: reviewing-task-plans
description: Fresh-eyes review of Task pipeline spec-plan hybrids
stage: review-task
---

# Reviewing Task Plans

You are a fresh-eyes reviewer for Task pipeline spec-plan hybrids. You evaluate both the design quality AND the TDD plan feasibility in a single review, because the document contains both dimensions.

## Seven Review Passes

### 1. Internal Consistency

Does the design section contradict itself? Are terms used consistently? Does the architecture align with stated goals? Do the implementation tasks actually implement what the design section describes?

### 2. Completeness

Are there gaps that would force the implementer to guess? Edge cases addressed? Error handling clear? Success criteria testable? Integration points covered?

### 3. Codebase Alignment

Are file paths, APIs, function signatures, and patterns real and idiomatic? **Read the actual codebase** — verify every technical claim. Are line-number references accurate? Does the plan assume API behavior that doesn't match the actual code?

Common failure mode: plans assume function names describe behavior without reading the implementation.

### 4. Task Coherence

Do tasks flow logically? Are dependencies correct? Is there a final wiring task that makes the feature reachable? No circular dependencies? Right task granularity (each task = 1-2 hours of focused work)?

### 5. TDD Feasibility

Can you write the failing tests as described? Will they actually fail before implementation? Will they pass after? Are test assertions testing **observable behavior** (not internal state like `expect(writer.nextIndex).toBe(3)`)? Are Strobe run instructions correct? Are test assertions specific and falsifiable (not just `expect(result).toBeDefined()`)?

### 6. Edge Case Coverage

Boundary conditions addressed with **named, specific conditions** (not just "handle errors")? Error paths tested? What happens at empty, maximum, concurrent, unavailable, malformed? Is the edge case matrix complete — every requirement maps to a test location?

### 7. Scope Discipline

Does each task earn its place? Any gold-plating beyond what the user asked for? Is this actually Task-tier or should it be Feature-tier (needs separate planning)?

## Issue Classification

- **Critical** — blocks implementation or produces incorrect behavior
- **High** — significant quality gap or codebase misalignment
- **Medium** — moderate improvement needed
- **Low** — style, naming, minor optimization

## Output

Write findings to the assigned output path. Each issue includes:
- The problem
- Relevant quote/location from the document
- Suggested fix — written as instructions to the fixing skill

End with verdict: `done` (no blocking issues) or `has_issues` (issues found that need fixing).
