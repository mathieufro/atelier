import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { deployCallbackTool, deployMcpSignalTool, TOOL_SOURCE, MCP_SIGNAL_TOOL_SOURCE } from "../../src/infra/tool-deployer.js"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"

describe("deployCallbackTool", () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-test-"))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it("creates tools/ directory, writes tool file and package.json", async () => {
    await deployCallbackTool(tempDir)
    const toolPath = path.join(tempDir, "tools", "atelier_signal.ts")
    expect(fs.existsSync(toolPath)).toBe(true)
    const content = fs.readFileSync(toolPath, "utf-8")
    expect(content).toContain("atelier_signal")
    expect(content).toContain("ATELIER_PORT")
    expect(content).toContain("stage_complete")
    expect(content).not.toContain("stage_blocked")

    // Writes package.json inside tools/ to avoid polluting the workspace root
    const pkgPath = path.join(tempDir, "tools", "package.json")
    expect(fs.existsSync(pkgPath)).toBe(true)
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"))
    expect(pkg.dependencies["@opencode-ai/plugin"]).toBe("^1.0.0")
  })

  it("overwrites existing tool file", async () => {
    const toolDir = path.join(tempDir, "tools")
    fs.mkdirSync(toolDir, { recursive: true })
    fs.writeFileSync(path.join(toolDir, "atelier-signal.ts"), "old content")

    await deployCallbackTool(tempDir)
    const content = fs.readFileSync(path.join(toolDir, "atelier_signal.ts"), "utf-8")
    expect(content).not.toBe("old content")
    expect(content).toContain("ATELIER_PORT")
  })

  it("TOOL_SOURCE contains valid tool definition", () => {
    expect(TOOL_SOURCE).toContain('import { tool } from "@opencode-ai/plugin"')
    expect(TOOL_SOURCE).toContain("stage_complete")
    expect(TOOL_SOURCE).not.toContain("stage_blocked")
    expect(TOOL_SOURCE).toContain("/pipeline/signal")
  })
})

// bun install inside deployMcpSignalTool can take time on cold cache
describe("deployMcpSignalTool", { timeout: 30_000 }, () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-mcp-test-"))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it("creates tools/mcp/ directory and writes MCP server script", async () => {
    await deployMcpSignalTool(tempDir)
    const toolPath = path.join(tempDir, "tools", "mcp", "atelier_signal_mcp.ts")
    expect(fs.existsSync(toolPath)).toBe(true)
    const content = fs.readFileSync(toolPath, "utf-8")
    expect(content).toContain("McpServer")
    expect(content).toContain("atelier_signal")
    expect(content).toContain("ATELIER_PORT")
    expect(content).toContain("ATELIER_SESSION_ID")
    expect(content).toContain("/pipeline/signal")
    // Must NOT be in tools/ root (OpenCode scans that for plugin tools)
    expect(fs.existsSync(path.join(tempDir, "tools", "atelier_signal_mcp.ts"))).toBe(false)
  })

  it("writes package.json with @modelcontextprotocol/sdk and zod in mcp/", async () => {
    await deployMcpSignalTool(tempDir)
    const pkgPath = path.join(tempDir, "tools", "mcp", "package.json")
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"))
    expect(pkg.dependencies["@modelcontextprotocol/sdk"]).toBeTruthy()
    expect(pkg.dependencies["zod"]).toBeTruthy()
  })

  it("is idempotent (skips write when hash matches)", async () => {
    await deployMcpSignalTool(tempDir)
    const toolPath = path.join(tempDir, "tools", "mcp", "atelier_signal_mcp.ts")
    const stat1 = fs.statSync(toolPath).mtimeMs

    // Small delay to ensure mtime would differ on write
    await new Promise((r) => setTimeout(r, 50))
    await deployMcpSignalTool(tempDir)
    const stat2 = fs.statSync(toolPath).mtimeMs
    expect(stat2).toBe(stat1)
  })

  it("MCP_SIGNAL_TOOL_SOURCE contains valid MCP server definition", () => {
    expect(MCP_SIGNAL_TOOL_SOURCE).toContain('@modelcontextprotocol/sdk/server/mcp.js')
    expect(MCP_SIGNAL_TOOL_SOURCE).toContain("StdioServerTransport")
    expect(MCP_SIGNAL_TOOL_SOURCE).toContain("stage_complete")
    expect(MCP_SIGNAL_TOOL_SOURCE).toContain("/pipeline/signal")
    expect(MCP_SIGNAL_TOOL_SOURCE).toContain("ATELIER_SESSION_ID")
    // Must not reference @opencode-ai/plugin
    expect(MCP_SIGNAL_TOOL_SOURCE).not.toContain("@opencode-ai/plugin")
  })
})
