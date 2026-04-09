---
name: bugfixing
description: Bug investigation and fixing — git blame triage, static analysis, reproduction, Strobe instrumentation, diagnostic output
stage: bugfix
---

# Bugfixing

Investigate a bug, find the root cause, fix it, verify the fix. One agent, one session. Most bugs (80%+) are found via static analysis — read the code, spot the issue, fix it. For the rest, switch to runtime observation. The key is knowing when to switch.

## Hard Limits

**1. Know when to stop reading and start instrumenting.**
If reading more files isn't giving you new leads, stop and switch to runtime observation. Don't keep reading hoping the answer will appear.

**2. Every hypothesis must be tested, not confirmed by reading more files.**
State the hypothesis explicitly. Design an observation (trace, log, test) that would prove or disprove it. Run it. If right, one run proves it. If wrong, you still have new data.

**3. Never re-run a test without new instrumentation or a code change.**
Same test + no new trace/log/change = same failure, no new data.

**4. Prefer runtime verification, but don't block on it.**
LLMs naturally prefer to "guess and check" — reading code and generating patches without runtime evidence. This often produces speculative multi-file rewrites instead of precise 2-3 line fixes. When you CAN reproduce the bug in a test, you MUST — it's the strongest signal. But some bugs are genuinely hard to reproduce (embedded systems, hardware-dependent, complex integration, race conditions, environment-specific). When reproduction is impractical:
- You may fix based on a high-confidence static hypothesis
- Mark the diagnostic document outcome as `high-confidence-unverified` instead of `root-cause-found`
- The pipeline completes but the orchestrator flags the fix for **manual confirmation** by the user
- State your confidence level and reasoning explicitly: "I'm confident this is the root cause because X, Y, Z — but I could not reproduce it in a test because W"

---

## The Protocol

### Phase 0: Triage

Before reading any code:

1. **Parse the bug report.** Extract: error messages, stack traces, reproduction steps, affected files/lines, user expectations vs actual behavior.
2. **Git blame.** Run `git blame` on any files/lines mentioned in the bug report or stack trace. Review the blame commit's diff — it often reveals what changed and why.
3. **Classify the bug.** This informs your investigation strategy:
   - **Crash** — stack trace points to the failure site. Start there.
   - **Wrong output** — compare expected vs actual. Trace the data flow backward from the output site.
   - **Regression** — something worked before. Git blame + recent commits are your primary lead. Consider `git bisect` for non-obvious regressions.
   - **Performance** — profiling, not debugging. Trace hot paths.
   - **Intermittent** — race condition or state-dependent. Needs instrumentation to catch in the act.

### Phase 1: Static Analysis (time-boxed)

Read the relevant code — the error site, its immediate callers, and the blame commit diff.

- Search for the root cause based on error messages, stack traces, blame context
- If the bug is **obvious** (wrong variable, missing check, typo, logic error visible in the code): write a reproduction test → verify it fails → fix it → verify it passes → run full suite → DONE
- If not obvious and reading more isn't giving new leads → go to Phase 2. Runtime bugs (wrong execution path, unregistered handler, wrong instance, initialization order, compile-time guard) are invisible in source.

### Phase 2: Reproduce

Write the smallest test that exercises the exact bug:

- **Unit test** when the bug is in an isolatable function you can call directly
- **E2E test** when the scenario requires real system state: UI interaction, file operations, multi-step workflow, complex object construction. When in doubt, prefer E2E — it replicates the exact user situation

Run with `debug_test`. Verify it **fails**. A passing test means wrong reproduction, not a fixed bug.

If you **cannot reproduce** after reasonable effort:
- Produce a diagnostic document (see Diagnostic Output below)
- Signal `stage_complete` with `type: "inconclusive"`
- The pipeline exits with findings. This is a valid outcome.

### Phase 3: Instrument & Observe (Strobe)

You have a failing test. Now find out WHY it fails.

**Cycle** (max 3 iterations):

1. **State your hypothesis** explicitly: "I believe X is the root cause because Y"
2. **Design the observation**: Add targeted traces at the highest-level entry point you suspect:
   ```
   debug_trace({ sessionId, add: ["ClassName::*"] })
   ```
   Or inject a log statement at the exact location you care about, rebuild, rerun.
3. **Run the failing test** and query results:
   ```
   debug_query({ sessionId, eventType: "function_enter" })
   ```
4. **Analyze**: Did the suspected function run? With what arguments? What was the return value? If the function never appears — something upstream blocked it. That's your new lead.
5. **Conclude**: Either the hypothesis is confirmed (proceed to fix) or refuted (form new hypothesis, go to step 1)

**For specific patterns:**

- **Silent failure** (no output, no assertion message): Almost always means handler not registered, compile-time guard, wrong instance, or event never fired. Trace the registration/initialization path.
- **Wrong value**: Use watches: `debug_trace({ sessionId, watches: { add: [{ variable: "myVar", on: ["suspect::*"] }] } })`
- **Race condition**: Add traces to both competing paths. Look at timestamps in `debug_query` results.
- **UI bug**: Use `debug_ui({ sessionId, mode: "both" })` to see the accessibility tree and screenshot. Compare with expected state.

**When Strobe hooks return 0:**
1. Try `@file:filename.cpp` — bypasses name mangling
2. Glob `**/*.dSYM` — if found, re-launch with `symbolsPath`
3. Try without namespace prefix
4. Templates/lambdas rarely hook — go straight to log injection
5. After 2-3 attempts, switch to source logging. Don't chase symbol resolution.

### Phase 4: Fix & Verify

You have evidence. State it explicitly before fixing: "The trace showed X was never called because Y. The fix is Z."

1. **Fix the code** — usually a few lines. If the fix requires architectural changes beyond the bug scope, produce a diagnostic document explaining why and signal `stage_complete` with the finding.
2. **Verify the reproduction test passes**
3. **Run the full test suite** to catch regressions
4. **Produce the diagnostic document** (see below)

### Phase 5: Escalate (if Phase 3 exhausted)

If 3 instrument-observe cycles haven't identified the root cause:

- Produce a diagnostic document with all hypotheses tested, evidence collected, narrowed search area, and suggested next steps
- Signal `stage_complete` with `type: "inconclusive"`
- The pipeline exits with findings

---

## Diagnostic Output

**Always produced**, regardless of outcome. This is the primary artifact of the bugfix pipeline.

```markdown
## Diagnostic Report: <one-line bug summary>

### Classification
- **Type**: crash | wrong-output | regression | performance | intermittent
- **Outcome**: root-cause-found | high-confidence-unverified | reproduced-unclear | cannot-reproduce

### Symptoms
<Error messages, stack traces, user-reported behavior>

### Investigation

#### Triage
- **Blame analysis**: <git blame findings, introducing commit if found>
- **Initial assessment**: <first impressions from the bug report>

#### Hypotheses Tested
1. **Hypothesis**: <what you thought was wrong>
   - **Observation**: <what you did to test it — trace, log, test>
   - **Evidence**: <what you found>
   - **Conclusion**: confirmed | refuted | inconclusive

#### Reproduction
- **Test**: <path to reproduction test, or "could not reproduce">
- **Failure mode**: <how the test fails — error message, wrong output, timeout>

### Root Cause (if found)
- **Location**: <file:line>
- **Cause**: <concise explanation>
- **Introducing commit**: <hash, if identified via blame>

### Fix (if applied)
- **Change**: <concise description>
- **Files modified**: <list>
- **Regression test**: <path, confirms fix>

### Suggested Next Steps (if inconclusive)
- <what a human should look at next>
```

---

## What Good Bugfixing Looks Like

### Easy case (80% of bugs):
```
1. Read bug report → stack trace points to auth.ts:42
2. git blame auth.ts → line changed 3 days ago in commit abc123
3. Read the diff → missing null check on user.session
4. Write test that hits the null path → fails ✓
5. Add the null check → test passes ✓
6. Full suite passes ✓
```
**Straightforward. Minutes, not hours.**

### Hard case (20% of bugs):
```
1. Read bug report → "settings don't save" — no stack trace
2. git blame settings.ts → no recent changes
3. Read settings.ts, storage.ts → nothing obvious
4. Write E2E test: open settings, change value, reload, check → fails ✓
5. debug_trace({ add: ["SettingsManager::*"] }) → save() called but persist() returns false
6. debug_trace({ add: ["StorageBackend::*"] }) → write() called with correct data, BUT path is wrong
7. Read the path construction → config directory has trailing slash from env var
8. Fix path join → test passes ✓
9. Full suite passes ✓
```
**Key: switched to runtime observation when static analysis stalled.**

## Pipeline Outcome Signaling

When running as a pipeline stage, signal completion with the `atelier_signal` tool:

- `type: "stage_complete"`
- `outputPath`: path to the diagnostic document
- `outcome`: one of:
  - `"fixed"` — bug identified, fix applied, tests pass
  - `"fixed_unverified"` — fix applied but full verification impractical (e.g., environment-specific, requires manual testing)
  - `"inconclusive"` — investigation exhausted without identifying root cause

If you don't specify an outcome, the orchestrator defaults to `"fixed"`.
