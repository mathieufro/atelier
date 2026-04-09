import { describe, it, expect } from "vitest"
import { filterEvents, LOG_LEVELS, type LogEvent, type LogLevel, type LogFilter } from "../src/logger.js"

describe("LogEvent types", () => {
  it("LOG_LEVELS defines the severity ordering", () => {
    expect(LOG_LEVELS).toEqual(["error", "info", "debug", "trace"])
  })
})

describe("filterEvents", () => {
  const events: LogEvent[] = [
    { ts: "2026-03-01T10:00:00.000Z", seq: 1, level: "info", layer: "atelier", category: "pipeline", action: "pipeline_created", source: "orchestrator", pipelineId: "p1" },
    { ts: "2026-03-01T10:00:01.000Z", seq: 2, level: "debug", layer: "atelier", category: "stage", action: "stage_started", source: "orchestrator", pipelineId: "p1", stageId: "s1", stageName: "brainstorm" },
    { ts: "2026-03-01T10:00:02.000Z", seq: 3, level: "error", layer: "atelier", category: "stage", action: "stage_idle_error", source: "orchestrator", pipelineId: "p1", stageId: "s1", error: "timeout" },
    { ts: "2026-03-01T10:00:03.000Z", seq: 4, level: "debug", layer: "opencode", category: "tool", action: "tool_call_started", source: "event-merger", sessionId: "sess1", data: { toolName: "bash" } },
    { ts: "2026-03-01T10:00:04.000Z", seq: 5, level: "trace", layer: "opencode", category: "session", action: "session_busy", source: "event-merger", sessionId: "sess1" },
  ]

  it("filters by level (includes that level and above)", () => {
    const result = filterEvents(events, { level: "info" })
    expect(result).toHaveLength(2) // info + error
    expect(result.every(e => e.level === "info" || e.level === "error")).toBe(true)
  })

  it("filters by layer", () => {
    const result = filterEvents(events, { layer: "opencode" })
    expect(result).toHaveLength(2)
    expect(result.every(e => e.layer === "opencode")).toBe(true)
  })

  it("filters by category", () => {
    const result = filterEvents(events, { category: "stage" })
    expect(result).toHaveLength(2)
  })

  it("filters by pipelineId", () => {
    const result = filterEvents(events, { pipelineId: "p1" })
    expect(result).toHaveLength(3) // events 1-3 have pipelineId
  })

  it("filters by sessionId", () => {
    const result = filterEvents(events, { sessionId: "sess1" })
    expect(result).toHaveLength(2)
  })

  it("filters by source", () => {
    const result = filterEvents(events, { source: "event-merger" })
    expect(result).toHaveLength(2)
  })

  it("combines multiple filters (AND logic)", () => {
    const result = filterEvents(events, { level: "debug", layer: "atelier" })
    // debug+ means error, info, debug. layer=atelier means events 1-3. Combined: all 3.
    expect(result).toHaveLength(3)
  })

  it("returns all events when filter is empty", () => {
    const result = filterEvents(events, {})
    expect(result).toHaveLength(5)
  })

  it("returns empty array for no matches", () => {
    const result = filterEvents(events, { pipelineId: "nonexistent" })
    expect(result).toHaveLength(0)
  })
})
