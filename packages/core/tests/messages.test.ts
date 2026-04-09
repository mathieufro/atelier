import { describe, it, expect } from "vitest"
import type { Message } from "../src/types.js"
import {
  isUserMessage,
  formatDuration,
  modeToPermissionRuleset,
  permissionRulesetToMode,
} from "../src/messages.js"

/** Minimal valid UserMessage for testing */
function makeUserMessage(): Message {
  return {
    id: "msg-1",
    sessionID: "s-1",
    role: "user",
    time: { created: Date.now() },
    agent: "default",
    model: { providerID: "test", modelID: "test-model" },
    system: "",
  }
}

/** Minimal valid AssistantMessage for testing */
function makeAssistantMessage(): Message {
  return {
    id: "msg-2",
    sessionID: "s-1",
    role: "assistant",
    time: { created: Date.now() },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    agent: "default",
    model: { providerID: "test", modelID: "test-model" },
    system: "",
  }
}

describe("isUserMessage", () => {
  it("returns true for user role", () => {
    expect(isUserMessage(makeUserMessage())).toBe(true)
  })
  it("returns false for assistant role", () => {
    expect(isUserMessage(makeAssistantMessage())).toBe(false)
  })
})

describe("formatDuration", () => {
  it("formats sub-second as ms", () => {
    expect(formatDuration(100, 600)).toBe("500ms")
  })

  it("formats seconds with one decimal", () => {
    expect(formatDuration(1000, 3500)).toBe("2.5s")
  })

  it("formats minutes", () => {
    expect(formatDuration(0, 90000)).toBe("1.5m")
  })

  it("handles zero duration", () => {
    expect(formatDuration(1000, 1000)).toBe("0ms")
  })

  it("handles undefined end time", () => {
    expect(formatDuration(1000, undefined)).toBe("")
  })
})

describe("modeToPermissionRuleset", () => {
  it("returns allow-all for build mode", () => {
    expect(modeToPermissionRuleset("build")).toEqual([
      { permission: "*", pattern: "*", action: "allow" },
    ])
  })

  it("returns deny rules for plan mode", () => {
    const rules = modeToPermissionRuleset("plan")
    expect(rules).toEqual([
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "edit", pattern: "*", action: "deny" },
      { permission: "write", pattern: "*", action: "deny" },
    ])
  })

  it("returns allow-all for feature mode", () => {
    expect(modeToPermissionRuleset("feature")).toEqual([
      { permission: "*", pattern: "*", action: "allow" },
    ])
  })
})

describe("permissionRulesetToMode", () => {
  it("returns build for empty/undefined ruleset", () => {
    expect(permissionRulesetToMode(undefined)).toBe("build")
    expect(permissionRulesetToMode([])).toBe("build")
  })

  it("detects plan mode from deny rules", () => {
    expect(permissionRulesetToMode([
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "edit", pattern: "*", action: "deny" },
      { permission: "write", pattern: "*", action: "deny" },
    ])).toBe("plan")
  })

  it("defaults to build for allow-all ruleset", () => {
    expect(permissionRulesetToMode([
      { permission: "*", pattern: "*", action: "allow" },
    ])).toBe("build")
  })

  it("defaults to build for unrecognized rulesets", () => {
    expect(permissionRulesetToMode([
      { permission: "bash", pattern: "ls", action: "allow" },
    ])).toBe("build")
  })
})
