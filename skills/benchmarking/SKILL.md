---
name: benchmarking
description: Benchmark harness — runs task sets through autonomous pipelines and collects results
stage: on-demand
---

# Benchmark Harness

You are the benchmark runner. Your job is to drive a set of benchmark tasks through autonomous Atelier pipelines and collect results for comparison against published baselines.

## Workflow

1. Read the benchmark definition file for the target benchmark
2. Follow the definition's instructions to:
   - Clone the task source repository
   - Parse the task list
   - For each task, set up a workspace and run an autonomous pipeline
3. Use the Test MCP tools (`atelier_start`, `atelier_send`, `atelier_poll`, `atelier_close`) to drive each pipeline
4. After each task, run the evaluation method specified in the benchmark definition
5. Log results to a JSONL file

## Task Loop

For each task in the benchmark:

1. **Setup workspace:**
   - Create a directory under `~/atelier-tests/bench-<benchmark>-<task-id>/`
   - Clone the target repo and checkout the base commit
   - Any pre-setup steps from the benchmark definition

2. **Run pipeline:**
   - `atelier_start(workspacePath)` — open VS Code on the workspace
   - `atelier_send(prompt, { mode: "feature", autonomous: true, variant: "medium" })` — start autonomous pipeline
   - `atelier_poll` in a loop until pipeline completes or fails (check `status` field)
   - If pipeline fails or times out (>30 minutes): log as failed, move to next task

3. **Evaluate:**
   - Run the benchmark's evaluation command in the workspace
   - Parse pass/fail and score from the output
   - Log result

4. **Cleanup:**
   - `atelier_close` — close VS Code window
   - Remove the workspace directory to save disk space

## Results

Store results in `<benchmark-dir>/<YYYY-MM-DD-run-id>/`:
- `results.jsonl` — one JSON line per task: `{ "taskId": "...", "status": "pass"|"fail"|"error"|"timeout", "score": 0-1, "tokens": {...}, "wallTimeMs": ..., "error": "..." }`
- `summary.md` — aggregate stats after all tasks complete

## Progress Tracking

Maintain a progress file (`<benchmark-dir>/<run-id>/progress.json`) listing completed task IDs. On restart, skip already-completed tasks. This allows resuming interrupted runs.

## Error Handling

- Individual task failures do NOT stop the run — log and continue
- Infrastructure failures (server crash, VS Code won't open): retry once, then log as error
- Track cumulative token usage across all tasks for cost monitoring

## Important Notes

- Tasks run sequentially — one autonomous pipeline at a time
- Use cost-effective models for initial validation runs (e.g., Haiku)
- A full benchmark run with hundreds of tasks takes hours — plan accordingly
- Never run benchmarks in the Atelier repo workspace — always use isolated test workspaces
