---
name: ralph-loop-help
description: Explain the Ralph Loop technique and how to set up and run loops in Atelier
stage: on-demand
---

# Ralph Loop Help

Explain the Ralph Loop technique to the user. Answer any follow-up questions they have. If they provide context about a specific task, help them write a good prompt file.

## What is Ralph Loop?

An iterative, autonomous development loop. The same prompt is fed to an AI agent repeatedly. Each iteration, the agent sees its previous work in the filesystem and git history, building incrementally toward a goal.

Named after Ralph Wiggum from The Simpsons. The technique was pioneered by Geoffrey Huntley (ghuntley.com/ralph).

## Command

In the Atelier chat panel:

```
/ralph-loop <prompt-path> [--max-iterations N] [--completion-promise "TEXT"]
```

- `<prompt-path>` — path to a `.md` file containing the task prompt (relative to workspace root)
- `--max-iterations N` — stop after N iterations (default: unlimited)
- `--completion-promise "TEXT"` — exact phrase the agent must output to signal completion

Cancel an active loop:
```
/cancel-ralph
```

### Examples

```
/ralph-loop ./ralph-prompt.md --max-iterations 20
/ralph-loop ./ralph-prompt.md --max-iterations 30 --completion-promise "ALL TESTS PASSING"
```

## How It Works

1. Atelier creates a **new session** titled `"Ralph: <filename>"`
2. Each iteration:
   - **Re-reads the prompt file** from disk (so you can edit it mid-loop)
   - Injects a system message: iteration count, completion rules
   - Sends the prompt to the agent
   - Waits for the agent to finish
   - Checks for `<promise>...</promise>` XML tags in the agent's output
   - If the promise text matches `--completion-promise` exactly (after whitespace normalization) the loop ends
   - If `--max-iterations` reached the loop ends
   - Otherwise the next iteration starts
3. The UI shows iteration dividers between messages

## Writing a Prompt File

The prompt is a **markdown file** in the workspace. It gets re-read every iteration, so you can edit it while the loop runs to steer the agent.

### Recommended Structure

```markdown
## Task

[Clear, concrete description of what needs to be done]

## Requirements

- [Specific, testable requirement 1]
- [Specific, testable requirement 2]
- [Measurable success criterion]

## Process

1. Check current state (read files, run tests, review git log)
2. Identify what's missing or broken
3. Make targeted changes
4. Verify changes work (run tests, lint, build)
5. If all requirements met, output: <promise>DONE</promise>

## Rules

- Do NOT output <promise>DONE</promise> unless ALL requirements are genuinely met
- Run tests after every change
- Build on previous iterations — your past work is in the files and git history
```

### Good Prompts

**Clear completion criteria with verification steps:**
```markdown
Fix all failing tests in src/parser/.

Process:
1. Run `bun test src/parser/`
2. Read failures
3. Fix one test at a time
4. Re-run tests after each fix
5. When ALL tests pass, output: <promise>ALL TESTS PASSING</promise>
```

**Incremental goals:**
```markdown
Build a CLI tool for converting CSV to JSON.

Phase 1: Basic conversion (read CSV, write JSON)
Phase 2: Column type inference (numbers, dates, booleans)
Phase 3: Streaming for large files
Phase 4: Tests for all phases

After each phase, commit with a descriptive message.
When all 4 phases complete with tests passing, output: <promise>COMPLETE</promise>
```

**Self-correcting with TDD:**
```markdown
Implement the auth middleware from spec.md.

Each iteration:
1. Read spec.md for requirements
2. Run the test suite: `bun test src/auth/`
3. If tests fail, read failures carefully, fix the root cause
4. If tests pass but spec has uncovered requirements, add tests + implement
5. When spec is fully implemented and all tests pass: <promise>AUTH COMPLETE</promise>

Do not output the promise if any test is failing or any spec requirement is unimplemented.
```

### Bad Prompts

- **"Make the code better"** — no success criteria, loop can never complete
- **"Build an app"** — too vague, no verification steps
- **No `<promise>` tag instructions** — loop runs forever unless `--max-iterations` is set
- **No verification step** — agent can't self-check progress, just guesses when it's done

### Key Principles

1. **Always set `--max-iterations`** as a safety net, even with a completion promise
2. **Include verification commands** — `bun test`, `bun run build`, `bun run lint` — so the agent can self-check
3. **The prompt file is live** — you can edit it mid-loop to add requirements, change direction, or add hints
4. **Each iteration starts fresh context** but sees all previous file changes and git history
5. **Completion promises are strict** — the agent must output `<promise>EXACT TEXT</promise>` and must NOT lie to escape the loop

## Completion Promise

To signal completion, the agent outputs an XML tag in its response:

```
<promise>EXACT TEXT HERE</promise>
```

- Must **exactly match** the `--completion-promise` value (whitespace is normalized: trimmed, internal spaces collapsed)
- Case-sensitive
- The agent must NOT output the promise unless the statement is genuinely true
- Without `--completion-promise` or `--max-iterations`, the loop runs indefinitely

## When to Use Ralph Loop

**Good for:**
- Tasks with clear, testable success criteria (tests passing, lint clean, build succeeding)
- Iterative refinement (get tests green, improve coverage, fix a class of bugs)
- Greenfield implementation from a spec you can walk away from
- Tasks with automatic verification (test suites, type checkers, linters)

**Not good for:**
- Tasks requiring human judgment or design decisions mid-way
- One-shot operations (just send a normal message)
- Tasks with unclear or subjective success criteria
- Exploratory research or investigation

## Progress

- **UI dividers** show iteration count between messages in the session
- **Session title** shows `"Ralph: <filename>"`
- Agent sees its own previous file changes and git history each iteration
- Use `/cancel-ralph` to stop a running loop at any time
