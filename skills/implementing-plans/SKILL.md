---
name: implementing-plans
description: Executes implementation plans — TDD cycle, progress tracking, LSP validation, blocker handling
stage: implement
---

# Implementing Plans

You execute a plan that someone else wrote. Your job is to **ship code** until you can't ship any more. Not audit, not re-plan, not narrate.

## Before Starting

- Read `plan.md` end-to-end. If something is genuinely unclear or contradicts the codebase, resolve it *before* writing code — don't start a task with unresolved questions.
- Read `progress.md` to recover state across sessions. Tasks already marked `[x]` in plan.md are done; do not redo them.
- Skim the codebase areas the plan touches so your implementation is idiomatic. This is the only "exploration" you get — it ends when you start Task N.
- Use TodoWrite for in-session visual tracking. Plan.md checkboxes + progress.md are the cross-session record of truth.

## The Loop (this is the whole job)

```
loop:
  next = first task in plan.md whose checkbox is [ ]
  if next is None: run full test suite → atelier_signal verdict=done → exit
  implement(next)                       # red → green → LSP clean
  tick next in plan.md: [ ] → [x]
  append ONE line to progress.md: "[x] T<n>: <≤15-word note, file path>"
  goto loop
```

**That is the entire algorithm.** Do not deviate. Do not "triage." Do not "audit the prior pipeline's work." Do not write a paragraph about why T2-T5 are an architectural rewrite that should be deferred — pick T2, do T2, tick T2.

## The Forbidden Patterns (read this — these are the failure modes)

You will be tempted to do one of these. Don't. Each has cost real sessions:

1. **Audit-only session.** "No new code written in this session. Audit only — confirmed that the prior pipeline already produced…" → BANNED. If you think the work is already done, prove it by ticking each `[ ]` to `[x]` with a file:line proof on the SAME line. No prose narrative. If you can't prove it in one line, the task isn't done — implement it.

2. **Deferral essay.** "T2/T3/T4/T5: full service rewrite — deferred (would require simultaneous rewrite of routes/handlers/tests…)" → BANNED. Tasks are deferred by *running out of context*, not by you deciding they're hard. If T2 is next and T2 is hard, you do T2. The next session does T3.

3. **Out-of-order cherry picking.** "Shipped T9 and T11 since they were surgical; T2-T8 deferred." → BANNED. Tasks run in plan order. T2 before T3 before T4. The plan author ordered them; trust that ordering.

4. **Rabbit-hole debugging on out-of-scope failures.** Session 2 spent its entire budget bisecting a pre-existing RLS test pollution issue and shipped zero tasks. If a failing test is NOT caused by code you wrote this session, note it once in progress.md and move on. The implement stage is not the bugfix stage.

5. **Declaring "complete" without ticking tasks.** "Implement: complete — Phase 11 backend unit/integration suite is fully green." with 25 unticked boxes above. → BANNED. The progress is the checkboxes in plan.md, not your summary of the suite. If plan.md still has `[ ]` boxes, you are not done.

6. **Multi-paragraph "next session should do" hand-offs.** One line. `Stopped mid-T<n>: <what remains in ≤20 words>`. The next session will read plan.md, not your essay.

If you catch yourself writing "deferred," "out of budget," "exceeds one session," "the honest hand-off is…," "the biggest remaining unknowns are…" — **stop, delete the paragraph, and go implement the next task instead.**

## Scope Discipline

- Make whatever changes the task actually requires — including touching files the plan didn't name and refactoring surrounding code when the task can't land cleanly without it. Plans can't anticipate every collision; an honest implementation often expands scope.
- What's banned is **gold-plating**: adding features the plan doesn't ask for, rewriting working code for style, or chasing tangential cleanups. Rule of thumb: every line you change should be traceable to "T<n> needs this." If it isn't, drop it.
- **No shortcuts "for now."** You will not come back. The next session will trust the progress file and move on. If you can't do it properly, the task isn't done — don't tick it.
- Don't bypass LSP / type errors to "fix later." Fix before the next task.

## TDD Per Task

For every task: write test → run via Strobe `debug_test` → **observe red** → implement → run again → **observe green** → tsc/LSP clean → tick.

- Read your own test before writing implementation: "if I deleted the implementation, would this fail?" If no, the test is broken.
- One task = one full red-green cycle. No combined tests across tasks. No "I'll write tests after."
- Run tests through Strobe only (`debug_test`). Never raw `bun test` / `cargo test`.
- After tick: `tsc --noEmit` (or equivalent) must be clean. If not, fix before next task.

## When to Stop (and how)

You stop when **one** of these is true. Plan size is NOT one of them. "Feels like a lot" is NOT one of them.

| Signal | What to do |
|---|---|
| `[ ]` queue is empty | Run full suite. All green → `atelier_signal verdict=done`. |
| A tool returns a context-near-limit / auto-compact warning, OR you can feel the system about to compact | Finish the current task if you're mid-cycle, tick it, then signal `partial`. |
| You've made 3+ genuine attempts at the current task with Strobe instrumentation and are blocked on a contradiction between plan and codebase | Signal `stuck` with the specific contradiction (one paragraph, not five). |

**Default behavior: keep going.** Your bias must be toward "one more task," not "good stopping point." If you're unsure whether to stop, do one more task. Sessions that ship 8 tasks and signal partial are MUCH better than sessions that ship 2 tasks and write an essay.

### Signaling partial (only with an observable stop signal above)

1. Make sure plan.md checkboxes reflect reality (only `[x]` tasks you actually completed full-cycle).
2. Append ONE line to progress.md: `- **Implement (partial):** <K>/<N> done this session; stopped at T<n+1> because <observable signal>.`
3. Call `atelier_signal` with `type: "stage_complete"`, `verdict: "partial"`, `outputPath` = absolute path to progress.md.

### Signaling done

Append: `- **Implement:** <N>/<N> done, full suite green.`
Then `atelier_signal verdict=done`.

## Progress File Discipline

The progress file is a **log of what got ticked**, not a notepad for hypotheses, audits, or hand-off essays. Each session adds at most:
- One opening line: `- **Implement (session <k>, <date>):** starting at T<n>.`
- One line per task ticked: `[x] T<n>: <note>` (≤15 words, include a file path).
- One closing line: partial/done/stuck per above.

If your contribution to progress.md is longer than ~20 lines, you spent too much time writing and not enough shipping.

**Plan.md is the source of truth for task state.** Tick the boxes in plan.md, not in progress.md.

## When Things Go Wrong

- **Unclear plan instruction** → pick the most reasonable interpretation, note assumption in one line, keep going. Don't ask, don't skip.
- **Test fails unexpectedly** → use Strobe `debug_trace` to instrument and debug. Don't reread files in a loop — instrument.
- **LSP error after a task** → fix before next task. Tests don't cover every path.
- **Task is genuinely blocked after real attempts** → if you've already ticked ≥1 task this session, mark `[!] T<n> blocked: <reason>` in plan.md and signal `partial`. If you've ticked zero, you are not blocked enough yet — keep attacking.
- **Pre-existing failure unrelated to your changes** → note once, do not chase. Implement stage ≠ bugfix stage.

## What "Done" Means For A Task

All of these, every time:
- [ ] Test written that exercises the production path
- [ ] Test observed failing (red) before implementation
- [ ] Implementation written
- [ ] Test observed passing (green)
- [ ] Full relevant suite still green
- [ ] tsc/LSP clean
- [ ] Box ticked in plan.md
- [ ] ≤15-word note appended to progress.md

Miss any of these → task is not done → do not tick it.

## Hard Bans (recap)

- No audit-only sessions. Zero code shipped = failure, regardless of "discoveries."
- No deferral essays. "Deferred — would require…" is forbidden language.
- No out-of-order task execution.
- No "complete" declaration with unticked boxes.
- No multi-paragraph hand-off narratives.
- No "I'll come back to this." You won't.
- No vibe-budget. Stop only on observable signals.

**Ship the next task. Then the next. Then the next.**
