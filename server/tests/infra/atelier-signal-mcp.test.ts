import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { deployMcpSignalTool } from "../../src/infra/tool-deployer.js"

// End-to-end integration test: spawns the deployed MCP subprocess exactly the way
// claude-code-engine.buildMcpServers does, speaks raw JSON-RPC over stdio, and
// verifies it exposes atelier_signal and forwards calls to /pipeline/signal.
//
// This is the seam that the deployer unit tests and the engine-config test
// cannot cover: a broken MCP source, missing deps, or runtime import error
// would make all other tests pass while work agents silently lose the tool.
//
// bun cold-start + first-time bun install on a fresh tempdir can run long on
// Windows with AV scanning. Vitest's describe-options bag honors `timeout` for
// tests but not `hookTimeout` — pass the budget to beforeEach/afterEach directly.
describe("atelier_signal MCP subprocess", { timeout: 90_000 }, () => {
  let tempDir: string
  let httpServer: Server
  let port: number
  let received: Array<{ url: string | undefined; body: Record<string, unknown> }>
  let proc: ChildProcessWithoutNullStreams | undefined
  let stderrBuf: string

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-mcp-e2e-"))
    received = []
    stderrBuf = ""

    // Mock orchestrator — records every POST hit from the MCP tool
    await new Promise<void>((resolve) => {
      httpServer = createServer((req, res) => {
        let body = ""
        req.on("data", (c) => { body += c.toString() })
        req.on("end", () => {
          try {
            received.push({ url: req.url, body: body ? JSON.parse(body) : {} })
          } catch {
            received.push({ url: req.url, body: { _raw: body } })
          }
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ ok: true }))
        })
      }).listen(0, "127.0.0.1", () => {
        port = (httpServer.address() as AddressInfo).port
        resolve()
      })
    })

    // Deploys the MCP tool + installs deps into tempDir/tools/mcp/
    await deployMcpSignalTool(tempDir)
  }, 90_000)

  afterEach(async () => {
    if (proc && proc.exitCode === null) {
      proc.kill()
      await new Promise<void>((r) => proc!.once("exit", () => r()))
    }
    await new Promise<void>((r) => httpServer.close(() => r()))
    try { fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch {}
  }, 30_000)

  it("exposes atelier_signal and forwards stage_complete to /pipeline/signal", async () => {
    const scriptPath = path.join(tempDir, "tools", "mcp", "atelier_signal_mcp.ts")
    expect(fs.existsSync(scriptPath)).toBe(true)

    proc = spawn("bun", ["run", scriptPath], {
      env: {
        ...process.env,
        ATELIER_PORT: String(port),
        ATELIER_SESSION_ID: "session-under-test",
      },
      stdio: ["pipe", "pipe", "pipe"],
    })

    // stdout framing: ndjson (one JSON-RPC message per line). Buffer across
    // chunks and queue messages so readFrame() is safe to call concurrently
    // with the subprocess emitting multiple frames in one chunk.
    const queue: unknown[] = []
    const waiters: Array<(m: unknown) => void> = []
    let stdoutBuf = ""
    proc.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf-8")
      let nl
      while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim()
        stdoutBuf = stdoutBuf.slice(nl + 1)
        if (!line) continue
        let msg: unknown
        try { msg = JSON.parse(line) } catch { continue }
        const w = waiters.shift()
        if (w) w(msg)
        else queue.push(msg)
      }
    })
    proc.stderr.on("data", (c: Buffer) => { stderrBuf += c.toString("utf-8") })

    let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null
    proc.on("exit", (code, signal) => { exitInfo = { code, signal } })

    const readFrame = <T = Record<string, unknown>>(label: string): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        if (queue.length > 0) return resolve(queue.shift() as T)
        const onExit = () => reject(new Error(
          `Subprocess exited before receiving ${label} (code=${exitInfo?.code}). stderr:\n${stderrBuf}`,
        ))
        proc!.once("exit", onExit)
        waiters.push((m) => {
          proc!.off("exit", onExit)
          resolve(m as T)
        })
      })

    const send = (msg: object) => {
      proc!.stdin.write(JSON.stringify(msg) + "\n")
    }

    // 1. initialize handshake
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "atelier-test", version: "1.0.0" },
      },
    })
    const initRes = await readFrame<{ result: { capabilities: { tools?: unknown }; serverInfo: { name: string } } }>("initialize")
    expect(initRes.result.capabilities.tools).toBeDefined()
    expect(initRes.result.serverInfo.name).toBe("atelier-signal")

    // The server only dispatches tool calls after the initialized notification
    send({ jsonrpc: "2.0", method: "notifications/initialized" })

    // 2. tools/list should advertise atelier_signal
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    const listRes = await readFrame<{ result: { tools: Array<{ name: string }> } }>("tools/list")
    const toolNames = listRes.result.tools.map((t) => t.name)
    expect(toolNames).toContain("atelier_signal")

    // 3. tools/call should POST to /pipeline/signal with the right payload
    send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "atelier_signal",
        arguments: { type: "stage_complete", outputPath: "/tmp/artifact.md" },
      },
    })
    const callRes = await readFrame<{ result: { content: Array<{ type: string; text: string }> } }>("tools/call")
    expect(callRes.result.content[0]?.text).toContain("Signal received")

    expect(received).toHaveLength(1)
    expect(received[0]!.url).toBe("/pipeline/signal")
    expect(received[0]!.body).toMatchObject({
      type: "stage_complete",
      sessionId: "session-under-test",
      outputPath: "/tmp/artifact.md",
    })
  })

  it("reports failure when ATELIER_PORT is unset", async () => {
    const scriptPath = path.join(tempDir, "tools", "mcp", "atelier_signal_mcp.ts")
    // Intentionally omit ATELIER_PORT/ATELIER_SESSION_ID
    const { ATELIER_PORT: _p, ATELIER_SESSION_ID: _s, ...envWithout } = process.env
    proc = spawn("bun", ["run", scriptPath], { env: envWithout, stdio: ["pipe", "pipe", "pipe"] })

    const queue: unknown[] = []
    const waiters: Array<(m: unknown) => void> = []
    let stdoutBuf = ""
    proc.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf-8")
      let nl
      while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim()
        stdoutBuf = stdoutBuf.slice(nl + 1)
        if (!line) continue
        try {
          const msg = JSON.parse(line)
          const w = waiters.shift()
          if (w) w(msg); else queue.push(msg)
        } catch {}
      }
    })
    proc.stderr.on("data", (c: Buffer) => { stderrBuf += c.toString("utf-8") })

    const readFrame = <T = Record<string, unknown>>(): Promise<T> =>
      new Promise<T>((resolve) => {
        if (queue.length > 0) return resolve(queue.shift() as T)
        waiters.push((m) => resolve(m as T))
      })

    const send = (msg: object) => { proc!.stdin.write(JSON.stringify(msg) + "\n") }

    send({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    })
    await readFrame()
    send({ jsonrpc: "2.0", method: "notifications/initialized" })

    send({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "atelier_signal", arguments: { type: "stage_complete" } },
    })
    const callRes = await readFrame<{ result: { content: Array<{ type: string; text: string }> } }>()
    expect(callRes.result.content[0]?.text).toContain("ATELIER_PORT")
    expect(received).toHaveLength(0)
  })
})
