/**
 * MCP Instructions Resolver
 *
 * Reads MCP server configs from user-level (~/.claude/mcp.json) and
 * project-level (<workspace>/.mcp.json), spawns each stdio server,
 * performs a minimal JSON-RPC initialize handshake to extract the
 * `instructions` field from InitializeResult, then caches the result.
 *
 * This works around the Claude Agent SDK not injecting MCP server
 * instructions into the system prompt (see claude-agent-sdk#174).
 */

import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { spawn } from "node:child_process"

export interface McpStdioConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
}

interface McpServerInstructions {
  name: string
  instructions: string
}

/** Read and merge MCP server configs from user + project level. */
export function readMcpConfigs(workspacePath: string): Record<string, McpStdioConfig> {
  const configs: Record<string, McpStdioConfig> = {}

  // User-level: ~/.claude/mcp.json
  const userMcpPath = path.join(os.homedir(), ".claude", "mcp.json")
  mergeFrom(userMcpPath, configs)

  // Project-level: <workspace>/.mcp.json
  const projectMcpPath = path.join(workspacePath, ".mcp.json")
  mergeFrom(projectMcpPath, configs)

  return configs
}

function mergeFrom(filePath: string, into: Record<string, McpStdioConfig>): void {
  try {
    const raw = fs.readFileSync(filePath, "utf-8")
    const parsed = JSON.parse(raw)
    const servers = parsed?.mcpServers
    if (!servers || typeof servers !== "object") return
    for (const [name, config] of Object.entries(servers)) {
      const c = config as Record<string, unknown>
      // Only stdio servers (have `command`, no `type` or type === "stdio")
      if (typeof c.command === "string" && (!c.type || c.type === "stdio")) {
        into[name] = {
          command: c.command,
          args: Array.isArray(c.args) ? c.args : undefined,
          env: c.env && typeof c.env === "object" ? c.env as Record<string, string> : undefined,
        }
      }
    }
  } catch {
    // File doesn't exist or is invalid — skip
  }
}

/**
 * Spawn an MCP stdio server, send initialize, extract instructions, close.
 * Returns null if the server has no instructions or fails to connect.
 *
 * Supports both MCP transports:
 * - Newline-delimited JSON (one JSON object per line)
 * - Content-Length framed (HTTP-style headers before each message)
 */
async function fetchInstructions(
  name: string,
  config: McpStdioConfig,
  timeoutMs = 5000,
): Promise<McpServerInstructions | null> {
  return new Promise((resolve) => {
    let resolved = false
    const done = (result: McpServerInstructions | null) => {
      if (resolved) return
      resolved = true
      clearTimeout(timer)
      proc.kill()
      resolve(result)
    }

    const proc = spawn(config.command, config.args ?? [], {
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, ...config.env },
    })

    const timer = setTimeout(() => done(null), timeoutMs)

    let buffer = ""

    const handleInitializeResult = (msg: { id?: number; result?: { instructions?: string } }) => {
      if (msg.id !== 1 || !msg.result) return false
      const instructions = msg.result.instructions
      // Send initialized notification then close
      const notify = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
      proc.stdin!.write(notify + "\n")
      if (typeof instructions === "string" && instructions.trim()) {
        done({ name, instructions: instructions.trim() })
      } else {
        done(null)
      }
      return true
    }

    proc.stdout!.on("data", (chunk: Buffer) => {
      if (resolved) return
      buffer += chunk.toString()

      // Try newline-delimited JSON first (each line is a complete JSON message)
      const lines = buffer.split("\n")
      buffer = lines.pop()! // keep incomplete last line
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith("Content-Length")) continue
        try {
          if (handleInitializeResult(JSON.parse(trimmed))) return
        } catch { /* not JSON — skip */ }
      }

      // Also try Content-Length framed messages in the remaining buffer
      while (buffer.includes("\r\n\r\n")) {
        const headerEnd = buffer.indexOf("\r\n\r\n")
        const header = buffer.slice(0, headerEnd)
        const match = header.match(/Content-Length:\s*(\d+)/i)
        if (!match) { buffer = buffer.slice(headerEnd + 4); continue }
        const contentLength = parseInt(match[1]!, 10)
        const bodyStart = headerEnd + 4
        if (buffer.length < bodyStart + contentLength) break
        const body = buffer.slice(bodyStart, bodyStart + contentLength)
        buffer = buffer.slice(bodyStart + contentLength)
        try {
          if (handleInitializeResult(JSON.parse(body))) return
        } catch { /* parse error — skip */ }
      }
    })

    proc.on("error", () => done(null))
    proc.on("exit", () => done(null))

    // Send initialize as newline-delimited JSON (most servers accept this)
    const initMsg = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "atelier", version: "0.1.0" },
      },
    })
    proc.stdin!.write(initMsg + "\n")
  })
}

/** Format extracted instructions into a system prompt block. */
function formatInstructionsBlock(servers: McpServerInstructions[]): string {
  if (servers.length === 0) return ""

  const sections = servers.map((s) => `## ${s.name}\n${s.instructions}`).join("\n\n")

  return `\n# MCP Server Instructions

The following MCP servers have provided instructions for how to use their tools and resources:

${sections}\n`
}

/**
 * Resolve MCP instructions for a workspace.
 *
 * Reads user + project MCP configs, spawns each server to extract instructions,
 * and returns a formatted block ready to append to a system prompt.
 *
 * Results are cached per workspace path — subsequent calls return instantly.
 */
const cache = new Map<string, string>()

export async function resolveMcpInstructions(workspacePath: string): Promise<string> {
  const cached = cache.get(workspacePath)
  if (cached !== undefined) return cached

  const configs = readMcpConfigs(workspacePath)
  const entries = Object.entries(configs)

  if (entries.length === 0) {
    cache.set(workspacePath, "")
    return ""
  }

  const results = await Promise.all(
    entries.map(([name, config]) => fetchInstructions(name, config))
  )

  const block = formatInstructionsBlock(results.filter((r): r is McpServerInstructions => r !== null))
  cache.set(workspacePath, block)
  return block
}

/** Clear the cache (for testing or when configs change). */
export function clearMcpInstructionsCache(): void {
  cache.clear()
}
