import { describe, it, expect } from "vitest"
import type {
  AtelierEvent,
  ContentBlock,
  AtelierMessage,
  BackendId,
} from "../src/atelier-events.js"
import type { PipelineEvent } from "../src/types.js"

describe("AtelierEvent type system", () => {
  it("session.busy is a valid AtelierEvent", () => {
    const event: AtelierEvent = {
      type: "session.busy",
      sessionId: "s1",
    }
    expect(event.type).toBe("session.busy")
    expect(event.sessionId).toBe("s1")
  })

  it("session.idle carries usage and optional cost/duration", () => {
    const event: AtelierEvent = {
      type: "session.idle",
      sessionId: "s1",
      usage: { inputTokens: 100, outputTokens: 50 },
      costUsd: 0.01,
      durationMs: 5000,
    }
    expect(event.usage.inputTokens).toBe(100)
    expect(event.costUsd).toBe(0.01)
  })

  it("session.stalled has correct shape", () => {
    const event: AtelierEvent = {
      type: "session.stalled",
      sessionId: "s1",
      reason: "No SDK yield for 91s (last subtype: part_progress, lease: 90s, restart 1/3)",
      silentForMs: 91000,
    }
    expect(event.type).toBe("session.stalled")
    if (event.type === "session.stalled") {
      expect(event.sessionId).toBe("s1")
      expect(event.reason).toContain("No SDK yield")
      expect(event.silentForMs).toBe(91000)
    }
  })

  it("session.error carries error string", () => {
    const event: AtelierEvent = {
      type: "session.error",
      sessionId: "s1",
      error: "subprocess crash",
    }
    expect(event.error).toBe("subprocess crash")
  })

  it("message.delta carries contentType and delta", () => {
    const event: AtelierEvent = {
      type: "message.delta",
      sessionId: "s1",
      messageId: "m1",
      contentType: "text",
      delta: "Hello",
    }
    expect(event.contentType).toBe("text")
    expect(event.delta).toBe("Hello")
  })

  it("message.completed carries contentBlocks array", () => {
    const blocks: ContentBlock[] = [
      { type: "text", text: "Hello" },
      { type: "tool_use", toolUseId: "t1", name: "Read", input: { file: "foo.ts" } },
      { type: "tool_result", toolUseId: "t1", output: "contents", isError: false },
      { type: "thinking", text: "Let me think..." },
    ]
    const event: AtelierEvent = {
      type: "message.completed",
      sessionId: "s1",
      messageId: "m1",
      role: "assistant",
      contentBlocks: blocks,
    }
    expect(event.contentBlocks).toHaveLength(4)
    expect(event.contentBlocks[0].type).toBe("text")
  })

  it("tool.started and tool.completed are valid", () => {
    const started: AtelierEvent = {
      type: "tool.started",
      sessionId: "s1",
      toolUseId: "t1",
      toolName: "Bash",
      input: { command: "ls" },
    }
    const completed: AtelierEvent = {
      type: "tool.completed",
      sessionId: "s1",
      toolUseId: "t1",
      toolName: "Bash",
      output: "file1.ts",
      durationMs: 120,
      isError: false,
    }
    expect(started.toolName).toBe("Bash")
    expect(completed.isError).toBe(false)
  })

  it("permission.asked carries suggestions and decisionReason", () => {
    const event: AtelierEvent = {
      type: "permission.asked",
      sessionId: "s1",
      requestId: "r1",
      toolName: "Bash",
      toolInput: { command: "rm -rf /" },
      suggestions: ["allow", "deny"],
      decisionReason: "dangerous command",
    }
    expect(event.requestId).toBe("r1")
    expect(event.suggestions).toEqual(["allow", "deny"])
  })

  it("connection.status carries backend and state", () => {
    const event: AtelierEvent = {
      type: "connection.status",
      backend: "claude-code",
      state: "ready",
    }
    expect(event.backend).toBe("claude-code")
    expect(event.state).toBe("ready")
  })

  it("rate_limit carries status and optional fields", () => {
    const event: AtelierEvent = {
      type: "rate_limit",
      sessionId: "s1",
      status: "allowed_warning",
      resetsAt: 1700000000,
      utilization: 0.85,
    }
    expect(event.status).toBe("allowed_warning")
  })

  it("AtelierMessage has correct shape", () => {
    const msg: AtelierMessage = {
      id: "m1",
      role: "assistant",
      contentBlocks: [{ type: "text", text: "Hello" }],
      timestamp: Date.now(),
      usage: { inputTokens: 100, outputTokens: 50 },
    }
    expect(msg.role).toBe("assistant")
    expect(msg.contentBlocks).toHaveLength(1)
  })

  it("BackendId is constrained to known values", () => {
    const id: BackendId = "claude-code"
    const id2: BackendId = "opencode"
    expect(id).toBe("claude-code")
    expect(id2).toBe("opencode")
  })
})

describe("PipelineEvent type constraints", () => {
  it("does not include stage_failed or pipeline_failed", () => {
    // @ts-expect-error — stage_failed should not be assignable to PipelineEvent
    const bad1: PipelineEvent = { type: "stage_failed", pipelineId: "p1", stageId: "s1", error: "x" }
    // @ts-expect-error — pipeline_failed should not be assignable to PipelineEvent
    const bad2: PipelineEvent = { type: "pipeline_failed", pipelineId: "p1", error: "x" }

    const validTypes: PipelineEvent["type"][] = [
      "stage_started",
      "stage_completed",
      "stage_interrupted",
      "stage_resumed",
      "pipeline_completed",
      "stuck_escalation",
      "fix_stage_inserted",
      "pipeline_title_updated",
    ]
    expect(validTypes).toHaveLength(8)

    void bad1
    void bad2
  })
})
