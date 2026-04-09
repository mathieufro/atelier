import type { BackendId } from "@atelier/core"
import type { AgentEngine, MessageInput } from "@atelier/core/agent-engine"
import type { ModelRef } from "@atelier/core"
import type { createEventMerger } from "./engine/event-merger.js"
import * as fs from "node:fs"

// --- Utility functions (exported for testing) ---

export function buildSystemMessage(iteration: number, maxIterations: number, completionPromise: string | null): string {
  const iterLabel = maxIterations > 0 ? `${iteration}/${maxIterations}` : `${iteration}`
  let msg = `🔄 Ralph loop — Iteration ${iterLabel}\n`

  if (completionPromise) {
    msg += `Completion: output <promise>${completionPromise}</promise> when the promise is genuinely fulfilled. Do not output the promise tag unless the statement is true.\n`
  } else if (maxIterations === 0) {
    msg += `This loop runs indefinitely until cancelled.\n`
  }

  msg += `\nYour previous work is visible in the filesystem and git history. Build on it.`
  return msg
}

export function extractPromise(text: string): string | null {
  const match = text.match(/<promise>([\s\S]*?)<\/promise>/)
  if (!match) return null
  const extracted = match[1]!.trim().replace(/\s+/g, " ")
  return extracted.length > 0 ? extracted : null
}

// --- Types ---

export interface LoopState {
  sessionId: string
  promptPath: string
  maxIterations: number
  completionPromise: string | null
  iteration: number
  status: "running" | "completed" | "cancelled" | "error"
  completionReason?: "promise_fulfilled" | "max_iterations" | "cancelled" | "error"
  completionDetail?: string
  startedAt: string
  backendId: BackendId
  model?: ModelRef
  variant?: string
}

interface LoopEntry {
  state: LoopState
  engine: AgentEngine
}

type EventMerger = ReturnType<typeof createEventMerger>

// --- Controller ---

export class RalphLoopController {
  private loops = new Map<string, LoopEntry>()

  constructor(private merger: EventMerger) {}

  startLoop(
    engine: AgentEngine,
    sessionId: string,
    backendId: BackendId,
    opts: {
      promptPath: string
      maxIterations: number
      completionPromise: string | null
      model?: ModelRef
      variant?: string
    },
  ): void {
    const state: LoopState = {
      sessionId,
      promptPath: opts.promptPath,
      maxIterations: opts.maxIterations,
      completionPromise: opts.completionPromise,
      iteration: 1,
      status: "running",
      startedAt: new Date().toISOString(),
      backendId,
      model: opts.model,
      variant: opts.variant,
    }

    this.loops.set(sessionId, { state, engine })

    // Fire-and-forget — errors handled inside runLoop
    this.runLoop(sessionId).catch(() => {})
  }

  async cancelLoop(sessionId: string): Promise<LoopState | null> {
    const entry = this.loops.get(sessionId)
    if (!entry || entry.state.status !== "running") return entry?.state ?? null

    entry.state.status = "cancelled"
    entry.state.completionReason = "cancelled"

    try {
      await entry.engine.interruptSession(sessionId)
    } catch {
      // Best-effort interrupt
    }

    this.merger.emit({
      type: "ralph.complete",
      sessionId,
      iteration: entry.state.iteration,
      reason: "cancelled" as const,
    })

    return entry.state
  }

  getLoop(sessionId: string): LoopState | null {
    return this.loops.get(sessionId)?.state ?? null
  }

  listLoops(): LoopState[] {
    return Array.from(this.loops.values()).map(e => e.state)
  }

  hasActiveLoop(sessionId: string): boolean {
    const entry = this.loops.get(sessionId)
    return entry?.state.status === "running"
  }

  hasActiveLoops(): boolean {
    for (const entry of this.loops.values()) {
      if (entry.state.status === "running") return true
    }
    return false
  }

  private async runLoop(sessionId: string): Promise<void> {
    const entry = this.loops.get(sessionId)
    if (!entry) return
    const { state, engine } = entry

    // Emit ralph.started
    this.merger.emit({
      type: "ralph.started",
      sessionId,
      promptPath: state.promptPath,
      maxIterations: state.maxIterations,
      completionPromise: state.completionPromise,
      iteration: state.iteration,
    })

    try {
      while (state.status === "running") {
        // 1. Read prompt
        const prompt = await fs.promises.readFile(state.promptPath, "utf-8")

        // 2. Build system message
        const system = buildSystemMessage(state.iteration, state.maxIterations, state.completionPromise)

        // 3. Emit ralph.iteration (before sendMessage, so divider renders above agent response)
        this.merger.emit({
          type: "ralph.iteration",
          sessionId,
          iteration: state.iteration,
          maxIterations: state.maxIterations,
        })

        // 4. Send message
        const messageInput: MessageInput = { content: prompt, system }
        if (state.model) messageInput.model = state.model
        if (state.variant) messageInput.variant = state.variant
        await engine.sendMessage(sessionId, messageInput)

        // 5. Wait for idle
        await engine.waitForIdle(sessionId)

        // 6. Check if cancelled during wait
        if (state.status !== "running") break

        // 7. Check completion (promise)
        if (state.completionPromise) {
          const output = await engine.getSessionOutput(sessionId)
          const promiseText = extractPromise(output.text)
          if (promiseText === state.completionPromise) {
            state.status = "completed"
            state.completionReason = "promise_fulfilled"
            state.completionDetail = promiseText
            break
          }
        }

        // 8. Check max iterations (before incrementing — current iteration is the one just completed)
        if (state.maxIterations > 0 && state.iteration >= state.maxIterations) {
          state.status = "completed"
          state.completionReason = "max_iterations"
          break
        }

        // 9. Increment for next iteration
        state.iteration++
      }
    } catch (err) {
      if (state.status === "running") {
        state.status = "error"
        state.completionReason = "error"
        state.completionDetail = err instanceof Error ? err.message : String(err)
      }
    }

    // Emit ralph.complete (unless already emitted by cancelLoop)
    if (state.completionReason !== "cancelled") {
      this.merger.emit({
        type: "ralph.complete",
        sessionId,
        iteration: state.iteration,
        reason: state.completionReason!,
        ...(state.completionDetail ? { detail: state.completionDetail } : {}),
      })
    }
  }
}
