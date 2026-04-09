import { spawn, type ChildProcess } from "node:child_process"
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { homedir } from "node:os"
import type { Workspace } from "./workspace.js"
import { backends } from "./config.js"

/** A logged HTTP request/response pair for transcript */
interface TranscriptEntry {
  timestamp: number
  direction: "request" | "event"
  method?: string
  url?: string
  body?: unknown
  status?: number
  response?: unknown
  event?: unknown
}

export interface E2EHarness {
  serverUrl: string
  serverProcess: ChildProcess
  events: Array<Record<string, unknown>>
  transcript: TranscriptEntry[]
  sseAbort: AbortController
  /** Send a message to the given session */
  sendMessage(sessionId: string, content: string, mode?: string): Promise<Response>
  /** Create a new session with the specified backend */
  createSession(backend: "claude-code" | "opencode", systemPrompt?: string): Promise<string>
  /** Wait for the next event of the given type (after `afterIndex`) */
  waitForEvent(type: string, timeoutMs?: number, afterIndex?: number): Promise<Record<string, unknown>>
  /** Wait for all events of the given type after a certain index */
  waitForEvents(type: string, count: number, timeoutMs?: number, afterIndex?: number): Promise<Array<Record<string, unknown>>>
  /** Get all captured events */
  getEvents(type?: string): Array<Record<string, unknown>>
  /** Reply to a permission request */
  replyPermission(sessionId: string, requestId: string, decision: "allow" | "deny"): Promise<Response>
  /** Reply to a question */
  replyQuestion(sessionId: string, requestId: string, answer: string): Promise<Response>
  /** Abort a session */
  abortSession(sessionId: string): Promise<Response>
  /** Resume a session */
  resumeSession(sessionId: string, content: string): Promise<Response>
  /** Wait for backend to be ready */
  waitForReady(timeoutMs?: number): Promise<void>
  /** Wait for an event matching type AND sessionId (filters both) */
  waitForRalphEvent(type: string, sessionId: string, timeoutMs?: number, afterIndex?: number): Promise<Record<string, unknown>>
  /** Start a Ralph loop. Returns { sessionId, eventIndex }. */
  startRalphLoop(opts: {
    promptPath: string
    maxIterations?: number
    completionPromise?: string
    model?: { providerID: string; modelID: string }
    variant?: string
  }): Promise<{ sessionId: string; eventIndex: number }>
  /** Cancel an active Ralph loop. */
  cancelRalphLoop(sessionId: string): Promise<Record<string, unknown>>
  /** Get a specific loop's state. */
  getRalphLoop(sessionId: string): Promise<Record<string, unknown>>
  /** List all loops. */
  listRalphLoops(): Promise<Array<Record<string, unknown>>>
  /** Fork an existing session */
  forkSession(sessionId: string, title?: string): Promise<{ id: string }>
  /** List all sessions */
  listSessions(): Promise<Array<Record<string, unknown>>>
  /** Get a single session's detail */
  getSession(sessionId: string): Promise<Record<string, unknown>>
  /** Get messages for a session */
  getMessages(sessionId: string): Promise<Array<Record<string, unknown>>>
  /** Delete a session */
  deleteSession(sessionId: string): Promise<Response>
  /** Wait for an event matching type AND a session ID in properties.info.id */
  waitForSessionEvent(type: string, sessionId: string, timeoutMs?: number, afterIndex?: number): Promise<Record<string, unknown>>
  /** Write transcript JSONL to disk */
  writeTranscript(scenarioName: string): void
  cleanup(): Promise<void>
}

export async function createE2EHarness(workspace: Workspace, opts?: { port?: number }): Promise<E2EHarness> {
  const port = opts?.port ?? 0
  const projectRoot = join(import.meta.dirname, "../..")

  // Start the Atelier server as a subprocess
  const serverProcess = spawn("bun", ["run", "server/src/index.ts", workspace.path], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ATELIER_PORT: String(port),
      ATELIER_IDLE_DETECTOR_CONFIG: JSON.stringify({ idleTimeoutMs: 0 }),
    },
  })

  // Wait for PID file to appear (server writes it after Bun.serve binds)
  const wsHash = createHash("sha256").update(workspace.path).digest("hex").slice(0, 12)
  const stateDir = join(homedir(), ".atelier", wsHash)
  const pidPath = join(stateDir, "atelier.pid")

  const serverUrl = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Server start timeout (30s)")), 30_000)
    let stderr = ""
    serverProcess.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString() })
    serverProcess.on("error", (err) => { clearTimeout(timeout); reject(err) })
    serverProcess.on("exit", (code) => {
      clearTimeout(timeout)
      reject(new Error(`Server exited with code ${code}.\nstderr: ${stderr}`))
    })

    const interval = setInterval(() => {
      try {
        if (existsSync(pidPath)) {
          const content = readFileSync(pidPath, "utf-8")
          const url = content.split("\n")[1]?.trim()
          if (url?.startsWith("http")) {
            clearTimeout(timeout)
            clearInterval(interval)
            resolve(url)
          }
        }
      } catch {}
    }, 100)
  })

  // Connect SSE to capture events
  const events: Array<Record<string, unknown>> = []
  const transcript: TranscriptEntry[] = []
  const sseAbort = new AbortController()

  fetch(`${serverUrl}/events`, { signal: sseAbort.signal })
    .then(async (res) => {
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const event = JSON.parse(line.slice(6))
              events.push(event)
              transcript.push({ timestamp: Date.now(), direction: "event", event })
            } catch {}
          }
        }
      }
    })
    .catch(() => {})

  /** Logged fetch wrapper — records request/response to transcript */
  async function trackedFetch(url: string, init: RequestInit): Promise<Response> {
    const entry: TranscriptEntry = {
      timestamp: Date.now(),
      direction: "request",
      method: init.method ?? "GET",
      url: url.replace(serverUrl, ""),
      body: init.body ? JSON.parse(init.body as string) : undefined,
    }
    const res = await fetch(url, init)
    const cloned = res.clone()
    try {
      entry.status = res.status
      entry.response = await cloned.json()
    } catch {
      entry.response = await cloned.text().catch(() => null)
    }
    transcript.push(entry)
    return res
  }

  const harness: E2EHarness = {
    serverUrl,
    serverProcess,
    events,
    transcript,
    sseAbort,

    async createSession(backend, systemPrompt) {
      const config = backends[backend]
      const res = await trackedFetch(`${serverUrl}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          backend,
          model: config.model,
          systemPrompt: systemPrompt ?? "You are a test agent. Follow instructions exactly. Do not add commentary.",
        }),
      })
      if (!res.ok) throw new Error(`Failed to create session: ${res.status} ${await res.text()}`)
      const data = await res.json() as any
      return data.sessionId ?? data.id
    },

    async sendMessage(sessionId, content, mode = "build") {
      const body: Record<string, unknown> = { content, mode }
      if (sessionId) body.sessionId = sessionId
      return trackedFetch(`${serverUrl}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    },

    async waitForEvent(type, timeoutMs = 60_000, afterIndex = -1) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        for (let i = Math.max(0, afterIndex + 1); i < events.length; i++) {
          if ((events[i] as any).type === type) return events[i]!
        }
        await new Promise((r) => setTimeout(r, 200))
      }
      const types = events.slice(Math.max(0, afterIndex + 1)).map((e: any) => e.type).join(", ")
      throw new Error(`Timed out waiting for event: ${type}. Got: ${types}`)
    },

    async waitForEvents(type, count, timeoutMs = 60_000, afterIndex = -1) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const matches: Array<Record<string, unknown>> = []
        for (let i = Math.max(0, afterIndex + 1); i < events.length; i++) {
          if ((events[i] as any).type === type) matches.push(events[i]!)
        }
        if (matches.length >= count) return matches.slice(0, count)
        await new Promise((r) => setTimeout(r, 200))
      }
      throw new Error(`Timed out waiting for ${count} events of type: ${type}`)
    },

    getEvents(type) {
      if (!type) return [...events]
      return events.filter((e: any) => e.type === type)
    },

    async replyPermission(sessionId, requestId, decision) {
      return trackedFetch(`${serverUrl}/session/${sessionId}/permission`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, decision }),
      })
    },

    async replyQuestion(sessionId, requestId, answer) {
      return trackedFetch(`${serverUrl}/session/${sessionId}/question`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, answer }),
      })
    },

    async abortSession(sessionId) {
      return trackedFetch(`${serverUrl}/session/${sessionId}/abort`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
    },

    async resumeSession(sessionId, content) {
      return trackedFetch(`${serverUrl}/session/${sessionId}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      })
    },

    async waitForRalphEvent(type, sessionId, timeoutMs = 60_000, afterIndex = -1) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        for (let i = Math.max(0, afterIndex + 1); i < events.length; i++) {
          const e = events[i] as any
          if (e.type === type && e.sessionId === sessionId) return events[i]!
        }
        await new Promise((r) => setTimeout(r, 200))
      }
      const types = events.slice(Math.max(0, afterIndex + 1)).map((e: any) => `${e.type}(${e.sessionId ?? ""})`).join(", ")
      throw new Error(`Timed out waiting for event: ${type} with sessionId: ${sessionId}. Got: ${types}`)
    },

    async startRalphLoop(opts) {
      const eventIndex = events.length
      const body: Record<string, unknown> = { promptPath: opts.promptPath }
      if (opts.maxIterations !== undefined) body.maxIterations = opts.maxIterations
      if (opts.completionPromise !== undefined) body.completionPromise = opts.completionPromise
      if (opts.model) body.model = opts.model
      if (opts.variant) body.variant = opts.variant
      const res = await trackedFetch(`${serverUrl}/ralph-loop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`Failed to start ralph loop: ${res.status} ${await res.clone().text()}`)
      const data = await res.json() as any
      return { sessionId: data.sessionId, eventIndex }
    },

    async cancelRalphLoop(sessionId) {
      const res = await trackedFetch(`${serverUrl}/ralph-loop/${sessionId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
      if (!res.ok) throw new Error(`Failed to cancel ralph loop: ${res.status}`)
      return await res.json() as Record<string, unknown>
    },

    async getRalphLoop(sessionId) {
      const res = await fetch(`${serverUrl}/ralph-loop/${sessionId}`)
      const data = await res.json() as Record<string, unknown>
      transcript.push({ timestamp: Date.now(), direction: "request", method: "GET", url: `/ralph-loop/${sessionId}`, status: res.status, response: data })
      return data
    },

    async listRalphLoops() {
      const res = await fetch(`${serverUrl}/ralph-loop`)
      const data = await res.json() as any
      transcript.push({ timestamp: Date.now(), direction: "request", method: "GET", url: `/ralph-loop`, status: res.status, response: data })
      return data.loops ?? []
    },

    async forkSession(sessionId, title) {
      const body: Record<string, unknown> = {}
      if (title !== undefined) body.title = title
      const res = await trackedFetch(`${serverUrl}/session/${sessionId}/fork`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`Fork failed: ${res.status} ${await res.clone().text()}`)
      return await res.json() as { id: string }
    },

    async listSessions() {
      const res = await trackedFetch(`${serverUrl}/sessions`, { method: "GET" })
      return await res.json() as Array<Record<string, unknown>>
    },

    async getSession(sessionId) {
      const res = await trackedFetch(`${serverUrl}/session/${sessionId}`, { method: "GET" })
      return await res.json() as Record<string, unknown>
    },

    async getMessages(sessionId) {
      const res = await trackedFetch(`${serverUrl}/session/${sessionId}/messages`, { method: "GET" })
      const data = await res.json() as any
      return data.messages ?? data
    },

    async deleteSession(sessionId) {
      return trackedFetch(`${serverUrl}/session/${sessionId}`, { method: "DELETE" })
    },

    async waitForSessionEvent(type, sessionId, timeoutMs = 60_000, afterIndex = -1) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        for (let i = Math.max(0, afterIndex + 1); i < events.length; i++) {
          const e = events[i] as any
          if (e.type === type && e.properties?.info?.id === sessionId) return events[i]!
        }
        await new Promise((r) => setTimeout(r, 200))
      }
      const types = events.slice(Math.max(0, afterIndex + 1)).map((e: any) => `${e.type}(${(e as any).properties?.info?.id ?? ""})`).join(", ")
      throw new Error(`Timed out waiting for event: ${type} with sessionId: ${sessionId}. Got: ${types}`)
    },

    async waitForReady(timeoutMs = 60_000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        try {
          const res = await fetch(`${serverUrl}/health`)
          const data = await res.json() as any
          if (data.status === "ready") {
            const backendStatuses = Object.values(data.backends ?? {}) as string[]
            if (backendStatuses.some(s => s === "ready")) return
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 1_000))
      }
      throw new Error("Server never reached ready state")
    },

    writeTranscript(scenarioName) {
      const dir = join(projectRoot, "test-results", "e2e", "transcripts")
      mkdirSync(dir, { recursive: true })
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
      const filename = `${scenarioName}-${timestamp}.jsonl`
      const lines = transcript.map(entry => JSON.stringify(entry)).join("\n")
      writeFileSync(join(dir, filename), lines + "\n")
    },

    async cleanup() {
      sseAbort.abort()
      serverProcess.kill("SIGTERM")
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          serverProcess.kill("SIGKILL")
          resolve()
        }, 5_000)
        serverProcess.on("close", () => {
          clearTimeout(timeout)
          resolve()
        })
      })
    },
  }

  return harness
}
