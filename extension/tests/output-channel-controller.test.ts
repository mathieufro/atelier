import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { formatLogEvent, OutputChannelController } from "../src/output-channel-controller.js"
import type { LogEvent } from "@atelier/core"

describe("formatLogEvent", () => {
  it("formats an info event with pipeline context", () => {
    const event: LogEvent = {
      ts: "2026-03-01T14:32:05.123Z",
      seq: 1,
      level: "info",
      layer: "atelier",
      category: "stage",
      action: "stage_started",
      source: "orchestrator",
      pipelineId: "abc123def456",
      stageName: "brainstorm",
    }

    const result = formatLogEvent(event)
    // Time is rendered in local timezone via toLocaleTimeString
    const expectedTime = new Date(event.ts).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })
    expect(result).toContain(expectedTime)
    expect(result).toContain("[INFO]")
    expect(result).toContain("stage_started")
    expect(result).toContain("brainstorm")
    expect(result).toContain("pipeline=abc12")
  })

  it("formats an error event with error message", () => {
    const event: LogEvent = {
      ts: "2026-03-01T14:35:12.456Z",
      seq: 2,
      level: "error",
      layer: "atelier",
      category: "stage",
      action: "stage_idle_error",
      source: "orchestrator",
      pipelineId: "abc123def456",
      stageName: "write_plan",
      error: "Nudge limit exceeded",
    }

    const result = formatLogEvent(event)
    expect(result).toContain("[ERROR]")
    expect(result).toContain("stage_idle_error")
    expect(result).toContain("write_plan")
    expect(result).toContain("Nudge limit exceeded")
  })

  it("formats a debug event with session context", () => {
    const event: LogEvent = {
      ts: "2026-03-01T14:32:07.789Z",
      seq: 3,
      level: "debug",
      layer: "opencode",
      category: "tool",
      action: "tool_call_started",
      source: "event-merger",
      sessionId: "def456abc789",
      data: { toolName: "bash" },
    }

    const result = formatLogEvent(event)
    expect(result).toContain("[DEBUG]")
    expect(result).toContain("tool_call_started")
    expect(result).toContain("session=def45")
    expect(result).toContain("toolName=bash")
  })

  it("truncates IDs to 5 chars", () => {
    const event: LogEvent = {
      ts: "2026-03-01T14:32:05.000Z",
      seq: 1,
      level: "info",
      layer: "atelier",
      category: "pipeline",
      action: "pipeline_created",
      source: "orchestrator",
      pipelineId: "abcdefghijklmnop",
    }

    const result = formatLogEvent(event)
    expect(result).toContain("pipeline=abcde")
    expect(result).not.toContain("abcdefghijklmnop")
  })
})

describe("OutputChannelController", () => {
  let controller: OutputChannelController
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    fetchMock = vi.fn()
    globalThis.fetch = fetchMock as any
    controller = new OutputChannelController("http://127.0.0.1:3000")
  })

  afterEach(() => {
    controller.dispose()
    vi.useRealTimers()
  })

  it("connect() fetches /log-events with level param", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, body: null })
    await controller.connect()
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3000/log-events?level=info",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it("setLevel() reconnects with new level", async () => {
    fetchMock.mockResolvedValue({ ok: false, body: null })
    await controller.connect()
    fetchMock.mockClear()

    fetchMock.mockResolvedValueOnce({ ok: false, body: null })
    await controller.setLevel("debug")
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3000/log-events?level=debug",
      expect.any(Object),
    )
  })

  it("dispose() aborts the connection and clears reconnect timer", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, body: null })
    await controller.connect()

    // A failed connection schedules a reconnect — dispose should clear it
    controller.dispose()

    // Advance timers — no reconnect should happen
    fetchMock.mockClear()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("scheduleReconnect uses exponential backoff capped at 30s", async () => {
    // Each failed connect triggers scheduleReconnect
    fetchMock.mockResolvedValue({ ok: false, body: null })
    await controller.connect() // retry 0 → delay 1s

    fetchMock.mockClear()
    await vi.advanceTimersByTimeAsync(999)
    expect(fetchMock).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1) // 1000ms total
    expect(fetchMock).toHaveBeenCalledTimes(1) // retry 1 → delay 2s

    fetchMock.mockClear()
    await vi.advanceTimersByTimeAsync(2000) // retry 2 → delay 4s
    expect(fetchMock).toHaveBeenCalledTimes(1)

    fetchMock.mockClear()
    await vi.advanceTimersByTimeAsync(4000) // retry 3 → delay 8s
    expect(fetchMock).toHaveBeenCalledTimes(1)

    fetchMock.mockClear()
    await vi.advanceTimersByTimeAsync(8000) // retry 4 → delay 16s
    expect(fetchMock).toHaveBeenCalledTimes(1)

    fetchMock.mockClear()
    await vi.advanceTimersByTimeAsync(16000) // retry 5 → delay 30s (capped)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    fetchMock.mockClear()
    await vi.advanceTimersByTimeAsync(30000) // retry 6 → still 30s cap
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
