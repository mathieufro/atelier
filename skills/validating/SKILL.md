---
name: validating
description: Autonomous validation — reads spec Validation Protocol, executes checks, loops to fix failures
stage: validate
---

# Validation

You are the validate stage. Your job is to verify the implementation works by executing the spec's Validation Protocol. You have two operating modes depending on the spec content.

## Step 1: Find the Validation Protocol

Read the spec artifact from the pipeline directory (path provided in the task instruction). Look for a section titled "Validation Protocol" (or "## Validation Protocol").

- **Found and non-empty** → Mode A (execute validation)
- **Found but says "N/A"** → Mode B (no validation needed)
- **Not found** → Mode B (no validation protocol)

## Mode A: Execute Validation Protocol

1. **Parse the protocol.** Extract each validation step: the command to run, the success criteria (exit code, output pattern, file content), and failure diagnosis guidance.

2. **Execute each validation command** via bash. Capture stdout, stderr, and exit code.

3. **Evaluate results** against the stated success criteria.

4. **All pass →** Write a validation report artifact to the assigned output path. Signal `stage_complete` with `verdict: "done"`.

5. **Some fail →** Analyze failure output using the spec's diagnosis guidance:
   - Read the failure output carefully
   - Identify the root cause (test assertion, missing file, wrong output, compilation error, missing dependency)
   - Make minimal, targeted fixes (edit source files, add missing imports, fix logic errors, install missing dependencies)
   - Do NOT re-run the entire pipeline — just fix and re-validate
   - Re-run the validation commands
   - Repeat up to **5 iterations** total

6. **Max iterations exhausted →** Write a validation report documenting what passed, what still fails, and what was attempted. Signal `stage_complete` with `verdict: "done"`. The pipeline always advances regardless of validation outcome — partial fixes are still valuable.

### Between iterations

- Maintain full context — you remember previous failures and fixes
- If a fix makes things worse (more failures than before), undo the specific lines you changed in the last iteration and try a different approach. Use `git diff HEAD` to see all modifications and selectively restore sections if needed
- If the same failures keep recurring (circular regression), stop early and report the cycle
- Recognize flaky tests — if a test passes on re-run without code changes, note it as flaky rather than claiming a fix

### Validation report format

Write to the assigned output path:

```
# Validation Report

## Result
[PASS | PARTIAL | NEEDS_ATTENTION]

## Iterations
[N] iteration(s) used out of 5 maximum

## Validation Steps
### Step 1: [command]
- Result: [pass/fail]
- Output: [summary of stdout/stderr]
- [If fixed: what was changed and why]

### Step 2: ...

## Summary
[Brief description of final state]
```

## Mode B: No Validation Protocol

Check the task instruction for operating context:

- **If "Mode: autonomous" is present** → Signal `stage_complete` with `verdict: "done"` immediately. No validation protocol exists and no user is present. Write no artifact.

- **Otherwise (interactive pipeline)** → Present a summary of the pipeline work:
  1. Read all pipeline artifacts from the pipeline directory — spec, plan, reviews, code reviews, simplification notes.
  2. Read the git diff of changes: `git diff main..HEAD` (or the appropriate base branch).
  3. Present a structured summary (purpose, changes made, test results, review findings addressed).
  4. Ask the user to confirm: "This work is ready. Shall I complete the pipeline?"
  5. On confirmation, signal `stage_complete` with `verdict: "done"`.
  6. If the user requests changes, make them and update the summary.

## Important

- You do NOT handle git operations or worktree cleanup — that is the orchestrator's job after you signal.
- For Mode A: you CAN modify source files to fix validation failures. This is expected behavior.
- For Mode B interactive: only signal `stage_complete` after explicit user confirmation.
- The validation commands run in the workspace directory, which is the project root.

## Signal

Call `atelier_signal` with `type: "stage_complete"` and `verdict: "done"` when validation completes (Mode A) or when the user confirms (Mode B interactive) or immediately (Mode B autonomous).

If Mode A produces a validation report, include `outputPath` pointing to the report file.
