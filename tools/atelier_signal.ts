import { tool } from "@opencode-ai/plugin"

export default tool({
  name: "atelier_signal",
  description: "Signal the Atelier orchestrator. Call when you have completed your task and written your output artifact. Most stages REQUIRE outputPath — the orchestrator will reject your signal if the artifact file is missing.",
  args: {
    type: tool.schema.enum(["stage_complete"]).describe("Signal type"),
    outputPath: tool.schema.string().describe("Path to output artifact (spec, plan, review, etc.). Required for most stages — write the file first, then signal.").optional(),
    verdict: tool.schema.enum(["done", "has_issues", "stuck", "proceed", "skip"]).describe("Review verdict or E2E gate decision").optional(),
    action: tool.schema.enum(["implement", "done"]).describe("Plan gate action").optional(),
    outcome: tool.schema.enum(["fixed", "fixed_unverified", "inconclusive"]).describe("Bugfix pipeline outcome").optional(),
    pipelineType: tool.schema.enum(["task", "feature", "epic", "bugfix"]).describe("Classification: pipeline type (required for classify stage)").optional(),
    worktreeChoice: tool.schema.enum(["in-tree", "worktree"]).describe("Classification: execution mode (required for classify stage)").optional(),
  },
  async execute(args, ctx) {
    const port = process.env.ATELIER_PORT
    if (!port) return "ATELIER_PORT not set -- not running under Atelier orchestrator."
    const res = await fetch(`http://127.0.0.1:${port}/pipeline/signal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: args.type ?? "stage_complete",
        sessionId: ctx.sessionID,
        outputPath: args.outputPath,
        verdict: args.verdict,
        action: args.action,
        outcome: args.outcome,
        pipelineType: args.pipelineType,
        worktreeChoice: args.worktreeChoice,
      }),
    })
    return res.ok ? "Signal received by orchestrator." : `Signal failed: ${await res.text()}`
  },
})
