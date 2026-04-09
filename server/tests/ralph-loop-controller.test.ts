import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { RalphLoopController, buildSystemMessage, extractPromise } from "../src/ralph-loop-controller.js"
import type { AgentEngine } from "@atelier/core/agent-engine"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

describe("buildSystemMessage", () => {
  it("iteration with max and promise", () => {
    const msg = buildSystemMessage(3, 20, "ALL TESTS PASSING")
    expect(msg).toBe(
      "🔄 Ralph loop — Iteration 3/20\n" +
      "Completion: output <promise>ALL TESTS PASSING</promise> when the promise is genuinely fulfilled. Do not output the promise tag unless the statement is true.\n" +
      "\nYour previous work is visible in the filesystem and git history. Build on it."
    )
  })

  it("iteration with max, no promise", () => {
    const msg = buildSystemMessage(5, 10, null)
    expect(msg).toContain("Iteration 5/10")
    expect(msg).not.toContain("Completion:")
    expect(msg).not.toContain("indefinitely")
    expect(msg).toContain("Build on it.")
  })

  it("unlimited with promise", () => {
    const msg = buildSystemMessage(7, 0, "DONE")
    expect(msg).toContain("Iteration 7\n")
    expect(msg).not.toContain("7/")
    expect(msg).toContain("<promise>DONE</promise>")
  })

  it("unlimited, no promise", () => {
    const msg = buildSystemMessage(1, 0, null)
    expect(msg).toContain("Iteration 1\n")
    expect(msg).toContain("This loop runs indefinitely until cancelled.")
    expect(msg).toContain("Build on it.")
  })

  it("iteration 1 of 1 with promise", () => {
    const msg = buildSystemMessage(1, 1, "SHIP IT")
    expect(msg).toContain("Iteration 1/1")
    expect(msg).toContain("<promise>SHIP IT</promise>")
  })
})

describe("extractPromise", () => {
  it("extracts text from promise tags", () => {
    expect(extractPromise("blah <promise>DONE</promise> blah")).toBe("DONE")
  })

  it("normalizes whitespace: trim + collapse", () => {
    expect(extractPromise("<promise>  ALL   TESTS\n  PASSING  </promise>")).toBe("ALL TESTS PASSING")
  })

  it("returns null when no tags present", () => {
    expect(extractPromise("no promise here")).toBeNull()
  })

  it("returns null for empty tags", () => {
    expect(extractPromise("<promise></promise>")).toBeNull()
  })

  it("returns null for whitespace-only tags", () => {
    expect(extractPromise("<promise>   \n  </promise>")).toBeNull()
  })

  it("extracts first match when multiple tags present", () => {
    expect(extractPromise("<promise>FIRST</promise> then <promise>SECOND</promise>")).toBe("FIRST")
  })

  it("handles multiline content inside tags", () => {
    expect(extractPromise("text\n<promise>\nALL TESTS\nPASSING\n</promise>\nmore")).toBe("ALL TESTS PASSING")
  })

  it("is case-sensitive for tag names", () => {
    expect(extractPromise("<PROMISE>DONE</PROMISE>")).toBeNull()
  })

  it("handles promise text with special characters", () => {
    expect(extractPromise('<promise>ALL 100% TESTS (unit + e2e) PASS</promise>')).toBe("ALL 100% TESTS (unit + e2e) PASS")
  })
})

function createMockEngine(outputs: string[] = [""]): AgentEngine {
  let outputIndex = 0
  return {
    createSession: vi.fn().mockResolvedValue({ id: "mock-session" }),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    waitForIdle: vi.fn().mockResolvedValue(undefined),
    getSessionOutput: vi.fn().mockImplementation(async () => {
      const text = outputs[Math.min(outputIndex++, outputs.length - 1)]!
      return { text, tokens: { input: 100, output: 50 } }
    }),
    interruptSession: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    updateSessionTitle: vi.fn().mockResolvedValue(undefined),
  }
}

function createMockMerger() {
  return { emit: vi.fn() } as any
}

describe("RalphLoopController", () => {
  let tmpDir: string
  let promptPath: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-test-"))
    promptPath = path.join(tmpDir, "prompt.md")
    fs.writeFileSync(promptPath, "Fix the bug in auth.ts")
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("runs to max iterations and completes", async () => {
    const engine = createMockEngine()
    const merger = createMockMerger()
    const controller = new RalphLoopController(merger)

    controller.startLoop(engine, "s1", "claude-code", {
      promptPath,
      maxIterations: 3,
      completionPromise: null,
    })

    await vi.waitFor(() => {
      expect(controller.getLoop("s1")?.status).toBe("completed")
    }, { timeout: 2000 })

    expect(engine.sendMessage).toHaveBeenCalledTimes(3)
    expect(engine.waitForIdle).toHaveBeenCalledTimes(3)
    const loop = controller.getLoop("s1")!
    expect(loop.completionReason).toBe("max_iterations")
    expect(loop.iteration).toBe(3)
  })

  it("completes on promise match", async () => {
    const engine = createMockEngine(["working...", "still going", "done <promise>FIXED</promise>"])
    const merger = createMockMerger()
    const controller = new RalphLoopController(merger)

    controller.startLoop(engine, "s1", "claude-code", {
      promptPath,
      maxIterations: 10,
      completionPromise: "FIXED",
    })

    await vi.waitFor(() => {
      expect(controller.getLoop("s1")?.status).toBe("completed")
    }, { timeout: 2000 })

    expect(engine.sendMessage).toHaveBeenCalledTimes(3)
    const loop = controller.getLoop("s1")!
    expect(loop.completionReason).toBe("promise_fulfilled")
    expect(loop.completionDetail).toBe("FIXED")
    expect(loop.iteration).toBe(3)
  })

  it("does not match wrong promise text", async () => {
    const engine = createMockEngine(["<promise>WRONG</promise>", "<promise>ALSO WRONG</promise>"])
    const merger = createMockMerger()
    const controller = new RalphLoopController(merger)

    controller.startLoop(engine, "s1", "claude-code", {
      promptPath,
      maxIterations: 2,
      completionPromise: "CORRECT",
    })

    await vi.waitFor(() => {
      expect(controller.getLoop("s1")?.status).toBe("completed")
    }, { timeout: 2000 })

    expect(controller.getLoop("s1")!.completionReason).toBe("max_iterations")
  })

  it("cancels an active loop", async () => {
    let resolveIdle!: () => void
    const engine = createMockEngine()
    ;(engine.waitForIdle as any).mockImplementation(() => new Promise<void>(r => { resolveIdle = r }))

    const merger = createMockMerger()
    const controller = new RalphLoopController(merger)

    controller.startLoop(engine, "s1", "claude-code", {
      promptPath,
      maxIterations: 0,
      completionPromise: null,
    })

    // Wait for first sendMessage to be called (loop is in-flight)
    await vi.waitFor(() => {
      expect(engine.sendMessage).toHaveBeenCalledTimes(1)
    })

    const result = await controller.cancelLoop("s1")
    resolveIdle()

    expect(result?.status).toBe("cancelled")
    expect(result?.completionReason).toBe("cancelled")
    expect(engine.interruptSession).toHaveBeenCalledWith("s1")
  })

  it("errors when prompt file disappears mid-loop", async () => {
    const engine = createMockEngine()
    let sendCallCount = 0
    ;(engine.sendMessage as any).mockImplementation(async () => {
      sendCallCount++
      if (sendCallCount === 1) fs.unlinkSync(promptPath)
    })

    const merger = createMockMerger()
    const controller = new RalphLoopController(merger)

    controller.startLoop(engine, "s1", "claude-code", {
      promptPath,
      maxIterations: 10,
      completionPromise: null,
    })

    await vi.waitFor(() => {
      expect(controller.getLoop("s1")?.status).not.toBe("running")
    }, { timeout: 2000 })

    const loop = controller.getLoop("s1")!
    expect(loop.status).toBe("error")
    expect(loop.completionReason).toBe("error")
    expect(loop.completionDetail).toContain("ENOENT")
  })

  it("emits ralph.started before first iteration", async () => {
    const engine = createMockEngine()
    const merger = createMockMerger()
    const controller = new RalphLoopController(merger)

    controller.startLoop(engine, "s1", "claude-code", {
      promptPath,
      maxIterations: 1,
      completionPromise: "DONE",
    })

    await vi.waitFor(() => {
      expect(controller.getLoop("s1")?.status).toBe("completed")
    })

    const started = merger.emit.mock.calls.filter((c: any) => c[0].type === "ralph.started")
    expect(started).toHaveLength(1)
    expect(started[0][0]).toMatchObject({
      type: "ralph.started",
      sessionId: "s1",
      promptPath,
      maxIterations: 1,
      completionPromise: "DONE",
      iteration: 1,
    })
  })

  it("emits ralph.iteration before each sendMessage", async () => {
    const engine = createMockEngine()
    const merger = createMockMerger()
    const controller = new RalphLoopController(merger)

    controller.startLoop(engine, "s1", "claude-code", {
      promptPath,
      maxIterations: 3,
      completionPromise: null,
    })

    await vi.waitFor(() => {
      expect(controller.getLoop("s1")?.status).toBe("completed")
    })

    const iterations = merger.emit.mock.calls.filter((c: any) => c[0].type === "ralph.iteration")
    expect(iterations).toHaveLength(3)
    expect(iterations[0][0]).toMatchObject({ iteration: 1, maxIterations: 3 })
    expect(iterations[1][0]).toMatchObject({ iteration: 2, maxIterations: 3 })
    expect(iterations[2][0]).toMatchObject({ iteration: 3, maxIterations: 3 })
  })

  it("emits ralph.complete when loop finishes", async () => {
    const engine = createMockEngine()
    const merger = createMockMerger()
    const controller = new RalphLoopController(merger)

    controller.startLoop(engine, "s1", "claude-code", {
      promptPath,
      maxIterations: 2,
      completionPromise: null,
    })

    await vi.waitFor(() => {
      expect(controller.getLoop("s1")?.status).toBe("completed")
    })

    const complete = merger.emit.mock.calls.filter((c: any) => c[0].type === "ralph.complete")
    expect(complete).toHaveLength(1)
    expect(complete[0][0]).toMatchObject({
      type: "ralph.complete",
      sessionId: "s1",
      iteration: 2,
      reason: "max_iterations",
    })
  })

  it("re-reads prompt file each iteration", async () => {
    const engine = createMockEngine()
    const sendContents: string[] = []
    ;(engine.sendMessage as any).mockImplementation(async (_sid: string, msg: any) => {
      sendContents.push(msg.content)
      if (sendContents.length === 1) {
        fs.writeFileSync(promptPath, "Now fix the tests")
      }
    })

    const merger = createMockMerger()
    const controller = new RalphLoopController(merger)

    controller.startLoop(engine, "s1", "claude-code", {
      promptPath,
      maxIterations: 2,
      completionPromise: null,
    })

    await vi.waitFor(() => {
      expect(controller.getLoop("s1")?.status).toBe("completed")
    })

    expect(sendContents[0]).toBe("Fix the bug in auth.ts")
    expect(sendContents[1]).toBe("Now fix the tests")
  })

  it("passes system message with iteration context", async () => {
    const engine = createMockEngine()
    const merger = createMockMerger()
    const controller = new RalphLoopController(merger)

    controller.startLoop(engine, "s1", "claude-code", {
      promptPath,
      maxIterations: 2,
      completionPromise: "FIXED",
    })

    await vi.waitFor(() => {
      expect(controller.getLoop("s1")?.status).toBe("completed")
    })

    const firstCall = (engine.sendMessage as any).mock.calls[0][1]
    expect(firstCall.system).toContain("Iteration 1/2")
    expect(firstCall.system).toContain("<promise>FIXED</promise>")

    const secondCall = (engine.sendMessage as any).mock.calls[1][1]
    expect(secondCall.system).toContain("Iteration 2/2")
  })

  it("passes model and variant on every sendMessage", async () => {
    const engine = createMockEngine()
    const merger = createMockMerger()
    const controller = new RalphLoopController(merger)

    const model = { providerID: "anthropic", modelID: "claude-sonnet-4-6" }
    controller.startLoop(engine, "s1", "claude-code", {
      promptPath,
      maxIterations: 2,
      completionPromise: null,
      model,
      variant: "reasoning",
    })

    await vi.waitFor(() => {
      expect(controller.getLoop("s1")?.status).toBe("completed")
    })

    for (const call of (engine.sendMessage as any).mock.calls) {
      expect(call[1].model).toEqual(model)
      expect(call[1].variant).toBe("reasoning")
    }
  })

  it("listLoops returns all loops", async () => {
    const merger = createMockMerger()
    const controller = new RalphLoopController(merger)

    // Use engines that hang on waitForIdle so loops stay running
    const engine1 = createMockEngine()
    ;(engine1.waitForIdle as any).mockImplementation(() => new Promise(() => {}))
    const engine2 = createMockEngine()
    ;(engine2.waitForIdle as any).mockImplementation(() => new Promise(() => {}))

    controller.startLoop(engine1, "s1", "claude-code", { promptPath, maxIterations: 100, completionPromise: null })
    controller.startLoop(engine2, "s2", "opencode", { promptPath, maxIterations: 100, completionPromise: null })

    // Wait for both to start
    await vi.waitFor(() => {
      expect(engine1.sendMessage).toHaveBeenCalled()
      expect(engine2.sendMessage).toHaveBeenCalled()
    })

    const loops = controller.listLoops()
    expect(loops).toHaveLength(2)
    expect(loops.map(l => l.sessionId).sort()).toEqual(["s1", "s2"])
  })

  it("hasActiveLoop returns true for running, false for completed/unknown", async () => {
    const engine = createMockEngine()
    ;(engine.waitForIdle as any).mockImplementation(() => new Promise(() => {}))

    const merger = createMockMerger()
    const controller = new RalphLoopController(merger)

    controller.startLoop(engine, "s1", "claude-code", { promptPath, maxIterations: 100, completionPromise: null })

    await vi.waitFor(() => { expect(engine.sendMessage).toHaveBeenCalled() })

    expect(controller.hasActiveLoop("s1")).toBe(true)
    expect(controller.hasActiveLoop("nonexistent")).toBe(false)
  })

  it("cancelLoop returns null for unknown session", async () => {
    const merger = createMockMerger()
    const controller = new RalphLoopController(merger)
    expect(await controller.cancelLoop("nonexistent")).toBeNull()
  })

  it("getLoop returns null for unknown session", () => {
    const merger = createMockMerger()
    const controller = new RalphLoopController(merger)
    expect(controller.getLoop("nonexistent")).toBeNull()
  })

  it("handles engine.sendMessage throwing", async () => {
    const engine = createMockEngine()
    ;(engine.sendMessage as any).mockRejectedValue(new Error("backend crashed"))

    const merger = createMockMerger()
    const controller = new RalphLoopController(merger)

    controller.startLoop(engine, "s1", "claude-code", {
      promptPath,
      maxIterations: 5,
      completionPromise: null,
    })

    await vi.waitFor(() => {
      expect(controller.getLoop("s1")?.status).toBe("error")
    })

    const loop = controller.getLoop("s1")!
    expect(loop.completionReason).toBe("error")
    expect(loop.completionDetail).toContain("backend crashed")
  })
})
