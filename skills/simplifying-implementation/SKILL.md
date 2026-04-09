---
name: simplifying-implementation
description: Simplification pass — remove unnecessary complexity, dead surface, disproportionate mechanisms, then polish code
stage: simplify
---

# Simplifying Implementation

You are simplifying code that has already passed code review. The code is correct — your job is to remove unnecessary complexity, eliminate dead surface area, and make what remains clearer. This is a subtractive pass: the best outcome is less code doing the same thing.

**Mindset shift:** The code review verified correctness. You verify *necessity*. For every mechanism, endpoint, parameter, and abstraction introduced in this feature branch, ask: "Does this need to exist? Is there a simpler way? Is this proportional to the problem it solves?"

## Scope

Scope is determined by context:

- **Pipeline mode** (feature branch exists): all code and specs added or modified in the branch (`git diff main...HEAD`).
- **Spec-driven** (given a spec or plan path): all files that implement or are referenced by that spec — trace imports, endpoints, types, and test files outward from the spec's described components.
- **Full codebase** (explicitly requested): scan the entire codebase.

In all modes, you may read any file in the repo to understand usage and call graphs. Only edit files within the determined scope — but if you discover bugs, dead code, or correctness issues in files you read outside the scope, flag them in your output so they are not silently ignored.

## Gather Context

Before analysis:

1. **Read the spec** that drove this implementation — understand what the system needs to do and the deployment context (single-user local tool? multi-tenant service? CLI? library?). The deployment context determines what complexity is proportional.
2. **Read CLAUDE.md** for project conventions.
3. **Get the full diff** (`git diff main...HEAD`) and the list of changed files.

## Execution Strategy

Always spawn sub-agents for analysis. The passes below are independent lenses — run them in parallel, each as a separate sub-agent with clean context. Each sub-agent receives: the spec path, the list of changed files, and its specific pass instructions below. Each sub-agent returns a findings list (not code changes). You aggregate, deduplicate, prioritize, apply the changes yourself, and run tests.

For small diffs (< 5 files), you may run passes sequentially yourself instead of spawning.

## Pass 1: Necessity

*Does each mechanism earn its complexity?*

For every significant mechanism introduced in the branch (state machine, retry logic, polling loop, recovery path, caching layer, queue, timer, protocol, multi-step handshake), answer:

- **Is it redundant?** Does another mechanism already in the codebase cover this case? Example: a watchdog timer that polls for missed events when a ring buffer + replay already guarantees delivery.
- **Is it proportional?** Given the deployment context, is this amount of machinery justified? A 3-retry mechanism with configurable timeouts makes sense for a distributed system — for a single-user local tool, fail immediately with a clear error.
- **Can it be replaced by something simpler?** A multi-step reconnection protocol with sequence-based deduplication can often be replaced by: close connection, fetch fresh state, reconnect. If the gap is acceptable (and for local tools, 100ms always is), the simpler approach wins.
- **Does the spec actually require it?** Sometimes implementation adds defensive mechanisms the spec didn't ask for. If the spec is silent and the mechanism handles a scenario that can't realistically occur, remove it.

Output: list of mechanisms to remove or simplify, each with a one-sentence rationale.

## Pass 2: Dead Surface

*Is everything that was added actually reachable and used?*

Trace the call graph and usage of every new addition:

- **Unused endpoints/routes** — defined in the API but never called by any client code. Check both internal callers and the client-facing interface.
- **Unused functions/methods** — exported or public but never imported or called anywhere.
- **Redundant parameters** — function/endpoint parameters whose values are already available to the callee through other means (e.g., server already has workspacePath from state, so accepting it as a body parameter is redundant).
- **Duplicate functions** — two functions that do the same thing with different names (e.g., `getPipelineDetail` and `getPipeline` with identical behavior).
- **Dead type fields** — fields in types/interfaces that are set but never read, or always set to the same value and never branched on.
- **Endpoints that aren't client-facing** — internal server methods exposed as external API. If no client calls it, remove from the public API surface.

Output: list of dead items to remove, each with evidence (no callers found, duplicate of X, value always Y).

## Pass 3: Spec Hygiene (when spec files are in the diff)

*Is the spec internally consistent and minimal?*

Only run this pass if spec/design documents were added or modified in the branch. Scan for:

- **Redundant edge case documentation** — cases already covered by general rules stated elsewhere in the same doc.
- **Contradictions** — something labeled "out of scope" that describes in-scope behavior, or two sections that give conflicting rules for the same scenario.
- **Over-specification** — conditions that are redundant (checking A && B when A implies B), or multi-condition checks where fewer conditions suffice.
- **Inconsistencies** — naming (singular vs plural, camelCase vs snake_case for the same concept), or patterns used differently for similar things (one endpoint uses a `reply` field, a similar endpoint uses a separate reject endpoint).
- **Consolidation opportunities** — multiple rules/endpoints/paths that can be unified into one without loss of expressiveness.

Output: list of spec issues, each with the section/line and a concrete fix.

## Pass 4: Code Consistency

*Does the diff express the same patterns the same way?*

- **Mixed idioms** — some functions use early returns, others use deep nesting for the same guard pattern. Match the surrounding codebase.
- **Naming drift** — similar concepts named differently (`data` vs `payload` vs `result`). Align to codebase convention.
- **Import/export style** — match existing patterns.
- **Error handling style** — match existing patterns.
- **Casing inconsistencies** — if the codebase uses `sessionId` everywhere but the new code introduces `sessionID`, normalize. One normalization point is better than N consumers handling both.

## Pass 5: Code Clarity

*Does the code say what it means?*

- **Deep nesting** (3+ levels) — flatten with guard clauses or extract-function.
- **Long functions** (40+ lines of logic) — extract at natural seams only if the name adds understanding.
- **Negated conditions** — flip `!isNotReady` to positive form.
- **Dead parameters** — parameters passed but never used in the body.
- **Unnecessary type assertions** — `as Foo` when already narrowed or inferable.

## Pass 6: Code Compression

*Can we remove code without losing anything?*

- **Redundant variables** — `const x = foo(); return x;` → `return foo();` (only when the name adds nothing).
- **Wrapper functions that just forward** — remove the wrapper, call the inner function directly.
- **Identity transforms** — `.map(x => x)`, `.filter(() => true)`.
- **Duplicate branches** — multiple `else if` branches with identical bodies → merge with `||`.
- **Console.log / debug artifacts** — leftover debugging output.
- **Forwarding events the sender already knows about** — if the client sent a request, forwarding the "request received" event back to it adds no information. Only forward events that carry new state.

## What NOT to Do

- **Don't change behavior.** If unsure whether an edit changes semantics, skip it.
- **Don't add.** No new comments, docstrings, type annotations, or error handling. This is a subtraction pass.
- **Don't rewrite.** If code works and is clear enough, leave it. The bar is "unnecessary, dead, or confusing" — not "not how I'd do it".
- **Don't chase style preferences.** Only enforce patterns the codebase already uses.

## Process

1. **Gather context** — spec, conventions, diff, changed files list.
2. **Spawn sub-agents** for passes 1-6 (or run sequentially for small diffs). Each returns a findings list.
3. **Aggregate findings.** Deduplicate. Prioritize by impact: necessity > dead surface > spec hygiene > code-level.
4. **Apply changes** yourself — highest impact first. For each change, verify it doesn't alter behavior.
5. **Run tests** to verify nothing broke. If a test fails, determine the cause — if your change caused it, revert that change. If a pre-existing test was already failing, fix it. Don't dismiss failures as "pre-existing" or "not my problem." All tests must pass when you're done.
6. **Self-check:** re-read your changes. For each edit, confirm: "This removal/simplification is clearly justified and the code is better without it."
7. Append to the progress file's `## Iteration Log`: `- **Simplify:** <one-line summary of changes>`.
8. Call `atelier_signal` with `type: "stage_complete"`.
