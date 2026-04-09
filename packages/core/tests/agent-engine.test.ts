import { describe, it, expect } from "vitest"
import type { AgentEngine, SessionConfig, MessageInput, AgentSession, SessionOutput } from "../src/agent-engine.js"

describe("AgentEngine interface", () => {
  it("interface shape is correct (compile-time check)", () => {
    // This test verifies the interface at compile time — if any method
    // signature changes, TypeScript will report it here.
    const _check: AgentEngine = {
      createSession: async (_config: SessionConfig): Promise<AgentSession> => ({ id: "test" }),
      sendMessage: async (_sid: string, _msg: MessageInput): Promise<void> => {},
      waitForIdle: async (_sid: string, _timeout?: number): Promise<void> => {},
      getSessionOutput: async (_sid: string): Promise<SessionOutput> => ({ text: "", tokens: { input: 0, output: 0 } }),
      interruptSession: async (_sid: string): Promise<void> => {},
      deleteSession: async (_sid: string): Promise<void> => {},
      updateSessionTitle: async (_sid: string, _title: string): Promise<void> => {},
    }
    expect(_check).toBeDefined()
  })
})
