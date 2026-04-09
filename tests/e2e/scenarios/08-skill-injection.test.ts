/**
 * E2E Scenario 8: Skill Injection Reliability
 *
 * Validates skill invocation at session start and mid-session
 * for both backends.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createWorkspace, type Workspace } from "../workspace.js"
import { createE2EHarness, type E2EHarness } from "../harness.js"
import { getAvailableBackends, getAvailableBackendsFromServer, backends } from "../config.js"

interface MessageWithParts {
  message: Record<string, unknown>
  parts: Array<Record<string, unknown>>
}

describe.each(getAvailableBackends())("Scenario 8: Skill Injection [%s]", (backend) => {
  let workspace: Workspace
  let harness: E2EHarness
  let sessionId = ""
  let backendAvailable = false

  beforeAll(async () => {
    workspace = await createWorkspace(`skill-injection-${backend}`, {
      "src/index.ts": "export const ready = true\n",
      "package.json": JSON.stringify({ name: "skill-injection-test", version: "1.0.0" }),
    })
    harness = await createE2EHarness(workspace)
    await harness.waitForReady(90_000)

    const available = await getAvailableBackendsFromServer(harness.serverUrl)
    backendAvailable = available.includes(backend)
  }, 120_000)

  afterAll(async () => {
    harness?.writeTranscript(`08-skill-injection-${backend}`)
    await harness?.cleanup()
    await workspace?.cleanup()
  }, 15_000)

  async function invokeSkill(skillName: string, content: string, sid?: string): Promise<string> {
    const cfg = backends[backend]
    const body: Record<string, unknown> = {
      skillName,
      content,
      model: cfg.model,
    }
    if (cfg.variant) body.variant = cfg.variant
    if (sid) body.sessionId = sid

    const res = await fetch(`${harness.serverUrl}/skill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    const data = await res.json() as { sessionId?: string; ok?: boolean; error?: string }
    if (!res.ok) throw new Error(`invokeSkill failed: ${res.status} ${JSON.stringify(data)}`)
    return data.sessionId ?? sid ?? ""
  }

  async function sendBuildMessage(content: string, sid: string): Promise<void> {
    const cfg = backends[backend]
    const body: Record<string, unknown> = {
      content,
      mode: "build",
      sessionId: sid,
      model: cfg.model,
    }
    if (cfg.variant) body.variant = cfg.variant

    const res = await fetch(`${harness.serverUrl}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    const data = await res.json() as Record<string, unknown>
    if (!res.ok) throw new Error(`sendMessage failed: ${res.status} ${JSON.stringify(data)}`)
  }

  async function getSessionMessages(sid: string): Promise<MessageWithParts[]> {
    const res = await fetch(`${harness.serverUrl}/session/${sid}/messages?limit=200`)
    const data = await res.json() as { messages: MessageWithParts[] }
    if (!res.ok) throw new Error(`getMessages failed: ${res.status} ${JSON.stringify(data)}`)
    return data.messages ?? []
  }

  function userText(entry: MessageWithParts): string {
    const textPart = entry.parts.find((p) => p.type === "text")
    return typeof textPart?.text === "string" ? textPart.text : ""
  }

  it("injects skill at session start and mid-session", async ({ skip }) => {
    if (!backendAvailable) skip()

    const startPrompt = `SKILL_START_${backend}`
    const midPrompt = `SKILL_MID_${backend}`

    // Session start: invoke skill without a sessionId
    const startIdx = harness.events.length
    sessionId = await invokeSkill("brainstorming", startPrompt)
    expect(sessionId).toBeTruthy()
    await harness.waitForEvent("session.idle", 180_000, startIdx)

    // Mid-session: regular turn, then invoke skill on existing session
    const normalIdx = harness.events.length
    await sendBuildMessage("Reply with: NORMAL_TURN", sessionId)
    await harness.waitForEvent("session.idle", 180_000, normalIdx)

    const midIdx = harness.events.length
    await invokeSkill("brainstorming", midPrompt, sessionId)
    await harness.waitForEvent("session.idle", 180_000, midIdx)

    const messages = await getSessionMessages(sessionId)
    const userMessages = messages.filter((m) => m.message.role === "user")

    if (backend === "claude-code") {
      const startSlash = `/brainstorming\n${startPrompt}`
      const midSlash = `/brainstorming\n${midPrompt}`
      expect(userMessages.some((m) => userText(m) === startSlash)).toBe(true)
      expect(userMessages.some((m) => userText(m) === midSlash)).toBe(true)
    } else {
      const startEntry = userMessages.find((m) => userText(m) === startPrompt)
      const midEntry = userMessages.find((m) => userText(m) === midPrompt)
      expect(startEntry).toBeTruthy()
      expect(midEntry).toBeTruthy()
      expect(String(startEntry?.message.system ?? "")).toContain("Brainstorming")
      expect(String(midEntry?.message.system ?? "")).toContain("Brainstorming")
    }
  }, 300_000)
})
