import * as fs from "node:fs/promises"
import { existsSync } from "node:fs"
import * as path from "node:path"
import { execFile as execFileCb } from "node:child_process"
import { promisify } from "node:util"
import { createHash } from "node:crypto"

const execFile = promisify(execFileCb)
const INSTALL_TIMEOUT_MS = 60_000

export const TOOL_SOURCE = `import { tool } from "@opencode-ai/plugin"

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
    const res = await fetch(\`http://127.0.0.1:\${port}/pipeline/signal\`, {
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
    return res.ok ? "Signal received by orchestrator." : \`Signal failed: \${await res.text()}\`
  },
})
`

export async function deployCallbackTool(targetDir: string): Promise<void> {
  if (!path.isAbsolute(targetDir)) {
    throw new Error(`targetDir must be absolute, got: ${targetDir}`)
  }
  const toolDir = path.join(targetDir, "tools")
  await fs.mkdir(toolDir, { recursive: true })

  // Skip only if BOTH the tool source is current AND deps are actually installed.
  // Checking node_modules prevents a permanent-broken state when a prior bun install
  // failed (e.g. cold-cache timeout): the .ts hash would match on every restart and
  // the install would never be retried.
  const toolPath = path.join(toolDir, "atelier_signal.ts")
  const newHash = createHash("sha256").update(TOOL_SOURCE).digest("hex")
  const depsInstalled = existsSync(path.join(toolDir, "node_modules", "@opencode-ai", "plugin"))
  try {
    const existing = await fs.readFile(toolPath, "utf-8")
    if (createHash("sha256").update(existing).digest("hex") === newHash && depsInstalled) return
  } catch { /* file doesn't exist yet */ }

  await fs.writeFile(toolPath, TOOL_SOURCE, "utf-8")
  // Clean up old hyphenated filename from previous deployments
  const oldPath = path.join(toolDir, "atelier-signal.ts")
  await fs.rm(oldPath, { force: true })

  // Ensure @opencode-ai/plugin is installed — package.json and node_modules
  // live inside tools/ to avoid polluting the workspace root (especially worktrees).
  const pkgPath = path.join(toolDir, "package.json")
  let pkg: Record<string, unknown> = {}
  try {
    pkg = JSON.parse(await fs.readFile(pkgPath, "utf-8"))
  } catch { /* no existing package.json */ }
  const deps = (pkg.dependencies ?? {}) as Record<string, string>
  if (!deps["@opencode-ai/plugin"]) deps["@opencode-ai/plugin"] = "^1.0.0"
  // MCP deps were previously co-located here but now live in tools/mcp/.
  // Remove them so ajv-formats (CJS transitive dep of @modelcontextprotocol/sdk)
  // doesn't break OpenCode's ESM tool loader.
  let depsChanged = false
  for (const stale of ["@modelcontextprotocol/sdk", "zod"]) {
    if (deps[stale]) { delete deps[stale]; depsChanged = true }
  }
  pkg.dependencies = deps
  await fs.writeFile(pkgPath, JSON.stringify(pkg), "utf-8")
  try {
    if (depsChanged) {
      // Force a fresh install when stale MCP deps are removed
      await fs.rm(path.join(toolDir, "node_modules"), { recursive: true, force: true })
      await fs.rm(path.join(toolDir, "bun.lock"), { force: true })
    }
    await execFile("bun", ["install", "--frozen-lockfile"], { cwd: toolDir, timeout: INSTALL_TIMEOUT_MS }).catch(() =>
      execFile("bun", ["install"], { cwd: toolDir, timeout: INSTALL_TIMEOUT_MS })
    )
  } catch {
    // Non-fatal: a subsequent deploy call will retry (hash check now also verifies
    // node_modules presence, so a failed install won't be masked by a matching hash).
  }
}

export const MCP_SIGNAL_TOOL_SOURCE = `import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

const server = new McpServer(
  { name: "atelier-signal", version: "1.0.0" },
  { instructions: "Call atelier_signal with type 'stage_complete' when you have completed your task and written your output artifact. Most stages REQUIRE outputPath — the orchestrator will reject your signal if the artifact file is missing." },
)

server.tool(
  "atelier_signal",
  "Signal the Atelier orchestrator. Call when you have completed your task and written your output artifact. Most stages REQUIRE outputPath — write the file first, then signal.",
  {
    type: z.enum(["stage_complete"]).describe("Signal type"),
    outputPath: z.string().optional().describe("Path to output artifact. Required for most stages — write the file first, then signal."),
    verdict: z.enum(["done", "has_issues", "stuck", "proceed", "skip"]).optional().describe("Review verdict or E2E gate decision"),
    action: z.enum(["implement", "done"]).optional().describe("Plan gate action"),
    outcome: z.enum(["fixed", "fixed_unverified", "inconclusive"]).optional().describe("Bugfix pipeline outcome"),
    pipelineType: z.enum(["task", "feature", "epic", "bugfix"]).optional().describe("Classification: pipeline type (required for classify stage)"),
    worktreeChoice: z.enum(["in-tree", "worktree"]).optional().describe("Classification: execution mode (required for classify stage)"),
  },
  async (args) => {
    const port = process.env.ATELIER_PORT
    const sessionId = process.env.ATELIER_SESSION_ID
    if (!port || !sessionId)
      return { content: [{ type: "text" as const, text: "ATELIER_PORT or ATELIER_SESSION_ID not set." }] }
    const res = await fetch(\`http://127.0.0.1:\${port}/pipeline/signal\`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: args.type ?? "stage_complete",
        sessionId,
        outputPath: args.outputPath,
        verdict: args.verdict,
        action: args.action,
        outcome: args.outcome,
        pipelineType: args.pipelineType,
        worktreeChoice: args.worktreeChoice,
      }),
    })
    return { content: [{ type: "text" as const, text: res.ok ? "Signal received by orchestrator." : \`Signal failed: \${await res.text()}\` }] }
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)
`

export async function deployMcpSignalTool(targetDir: string): Promise<void> {
  if (!path.isAbsolute(targetDir)) {
    throw new Error(`targetDir must be absolute, got: ${targetDir}`)
  }
  // MCP tools live in tools/mcp/ — a separate subdirectory that OpenCode doesn't
  // scan for plugin tools. This keeps @modelcontextprotocol/sdk (which depends on
  // CJS-only ajv-formats) out of the tools/ directory that OpenCode loads, avoiding
  // "Missing default export" errors that break all model responses.
  const mcpDir = path.join(targetDir, "tools", "mcp")
  await fs.mkdir(mcpDir, { recursive: true })

  const toolPath = path.join(mcpDir, "atelier_signal_mcp.ts")
  const newHash = createHash("sha256").update(MCP_SIGNAL_TOOL_SOURCE).digest("hex")
  const depsInstalled = existsSync(path.join(mcpDir, "node_modules", "@modelcontextprotocol", "sdk"))
  try {
    const existing = await fs.readFile(toolPath, "utf-8")
    if (createHash("sha256").update(existing).digest("hex") === newHash && depsInstalled) return
  } catch { /* file doesn't exist yet */ }

  await fs.writeFile(toolPath, MCP_SIGNAL_TOOL_SOURCE, "utf-8")
  // Clean up old location (was previously in tools/ directly)
  await fs.rm(path.join(targetDir, "tools", "atelier_signal_mcp.ts"), { force: true })

  const pkgPath = path.join(mcpDir, "package.json")
  let pkg: Record<string, unknown> = {}
  try {
    pkg = JSON.parse(await fs.readFile(pkgPath, "utf-8"))
  } catch { /* no existing package.json */ }
  const depsMcp = (pkg.dependencies ?? {}) as Record<string, string>
  if (!depsMcp["@modelcontextprotocol/sdk"]) depsMcp["@modelcontextprotocol/sdk"] = "^1.12.0"
  if (!depsMcp["zod"]) depsMcp["zod"] = "^3.25.0"
  pkg.dependencies = depsMcp
  await fs.writeFile(pkgPath, JSON.stringify(pkg), "utf-8")

  try {
    await execFile("bun", ["install", "--frozen-lockfile"], { cwd: mcpDir, timeout: INSTALL_TIMEOUT_MS }).catch(() =>
      execFile("bun", ["install"], { cwd: mcpDir, timeout: INSTALL_TIMEOUT_MS })
    )
  } catch {
    // Non-fatal: next deploy retries (hash check also verifies node_modules presence).
  }
}

export const MCP_RESPONDER_SOURCE = `import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

const server = new McpServer(
  { name: "atelier-responder", version: "1.0.0" },
  { instructions: "Use atelier_poll to monitor pipeline events and atelier_reply to answer questions from the work agent." },
)

server.tool(
  "atelier_poll",
  "Poll for new pipeline events. Returns events like question.asked, stage_started, text, tool calls. Pass afterCursor from the previous poll to get only new events.",
  {
    afterCursor: z.number().optional().describe("Cursor from previous poll (default 0). Pass nextCursor from last response."),
  },
  async (args) => {
    const port = process.env.ATELIER_PORT
    const pipelineId = process.env.ATELIER_PIPELINE_ID
    if (!port || !pipelineId)
      return { content: [{ type: "text" as const, text: "ATELIER_PORT or ATELIER_PIPELINE_ID not set." }] }
    const cursor = args.afterCursor ?? 0
    const res = await fetch(
      \`http://127.0.0.1:\${port}/pipeline/\${pipelineId}/poll?after=\${cursor}&timeout=10000&source=responder\`,
    )
    const body = await res.text()
    return { content: [{ type: "text" as const, text: res.ok ? body : \`Poll failed: \${body}\` }] }
  },
)

server.tool(
  "atelier_reply",
  "Reply to a work agent's question or permission request. Pass sessionId and requestId from the question.asked event.",
  {
    sessionId: z.string().describe("Session ID from the question.asked event"),
    requestId: z.string().describe("Request ID from the question.asked event"),
    answers: z.array(z.array(z.string())).optional().describe("For questions: array of answer arrays, e.g. [[\\"Task\\"], [\\"In-tree\\"]]"),
    reply: z.string().optional().describe("For permissions: reply string (e.g. 'always')"),
  },
  async (args) => {
    const port = process.env.ATELIER_PORT
    if (!port)
      return { content: [{ type: "text" as const, text: "ATELIER_PORT not set." }] }
    let url: string
    let payload: Record<string, unknown>
    if (args.answers) {
      url = \`http://127.0.0.1:\${port}/session/\${args.sessionId}/question\`
      payload = { requestId: args.requestId, answers: args.answers }
    } else if (args.reply) {
      url = \`http://127.0.0.1:\${port}/session/\${args.sessionId}/permission\`
      payload = { requestId: args.requestId, reply: args.reply }
    } else {
      return { content: [{ type: "text" as const, text: "Must provide either answers (for questions) or reply (for permissions)." }] }
    }
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
    return { content: [{ type: "text" as const, text: res.ok ? "Reply sent." : \`Reply failed: \${await res.text()}\` }] }
  },
)

server.tool(
  "atelier_send_message",
  "Send a user message to a work agent session. Use this for conversational turns when the agent stops (goes idle) without asking a formal question — e.g. during classification or brainstorming when the agent presents a recommendation and waits for feedback.",
  {
    sessionId: z.string().describe("Session ID of the work agent (from stage_started or poll events)"),
    content: z.string().describe("Your message to the work agent"),
  },
  async (args) => {
    const port = process.env.ATELIER_PORT
    if (!port)
      return { content: [{ type: "text" as const, text: "ATELIER_PORT not set." }] }
    const res = await fetch(\`http://127.0.0.1:\${port}/session/\${args.sessionId}/message\`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: args.content }),
    })
    return { content: [{ type: "text" as const, text: res.ok ? "Message sent." : \`Send failed: \${await res.text()}\` }] }
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)
`

export async function deployResponderMcp(targetDir: string): Promise<void> {
  if (!path.isAbsolute(targetDir)) {
    throw new Error(`targetDir must be absolute, got: ${targetDir}`)
  }
  // MCP tools in tools/mcp/ — see deployMcpSignalTool comment for rationale.
  const mcpDir = path.join(targetDir, "tools", "mcp")
  await fs.mkdir(mcpDir, { recursive: true })

  const toolPath = path.join(mcpDir, "atelier_responder_mcp.ts")
  const newHash = createHash("sha256").update(MCP_RESPONDER_SOURCE).digest("hex")
  const depsInstalled = existsSync(path.join(mcpDir, "node_modules", "@modelcontextprotocol", "sdk"))
  try {
    const existing = await fs.readFile(toolPath, "utf-8")
    if (createHash("sha256").update(existing).digest("hex") === newHash && depsInstalled) return
  } catch { /* file doesn't exist yet */ }

  await fs.writeFile(toolPath, MCP_RESPONDER_SOURCE, "utf-8")
  // Clean up old location
  await fs.rm(path.join(targetDir, "tools", "atelier_responder_mcp.ts"), { force: true })

  // Ensure MCP SDK deps are present (shared package.json with signal tool)
  const pkgPath = path.join(mcpDir, "package.json")
  let pkg: Record<string, unknown> = {}
  try {
    pkg = JSON.parse(await fs.readFile(pkgPath, "utf-8"))
  } catch { /* no existing package.json */ }
  const deps = (pkg.dependencies ?? {}) as Record<string, string>
  if (!deps["@modelcontextprotocol/sdk"]) deps["@modelcontextprotocol/sdk"] = "^1.12.0"
  if (!deps["zod"]) deps["zod"] = "^3.25.0"
  pkg.dependencies = deps
  await fs.writeFile(pkgPath, JSON.stringify(pkg), "utf-8")

  try {
    await execFile("bun", ["install", "--frozen-lockfile"], { cwd: mcpDir, timeout: INSTALL_TIMEOUT_MS }).catch(() =>
      execFile("bun", ["install"], { cwd: mcpDir, timeout: INSTALL_TIMEOUT_MS })
    )
  } catch {
    // Non-fatal: next deploy retries (hash check also verifies node_modules presence).
  }
}
