// tests/integration/test-backend-proxy.test.ts
import { describe, it, expect } from "vitest"
import { TestBackendProxy } from "./test-backend-proxy.js"

describe("TestBackendProxy", () => {
  it("listSessions returns seeded sessions", async () => {
    const proxy = new TestBackendProxy()
    proxy.addSession({ id: "s1", title: "Chat 1" })
    proxy.addSession({ id: "s2", title: "Chat 2" })
    const sessions = await proxy.listSessions()
    expect(sessions).toHaveLength(2)
    expect(sessions[0].id).toBe("s1")
  })

  it("getMessages returns seeded messages with pagination", async () => {
    const proxy = new TestBackendProxy()
    proxy.addMessages("s1", [
      { message: { id: "m1", sessionID: "s1", role: "user" }, parts: [] },
      { message: { id: "m2", sessionID: "s1", role: "assistant" }, parts: [] },
      { message: { id: "m3", sessionID: "s1", role: "user" }, parts: [] },
    ])
    const result = await proxy.getMessages("s1", { limit: 2 })
    expect(result.messages).toHaveLength(2)
    expect(result.total).toBe(3)
    expect(result.start).toBe(1)
    expect(result.end).toBe(3)
  })

  it("getMessages with before returns older messages", async () => {
    const proxy = new TestBackendProxy()
    proxy.addMessages("s1", [
      { message: { id: "m1", sessionID: "s1", role: "user" }, parts: [] },
      { message: { id: "m2", sessionID: "s1", role: "assistant" }, parts: [] },
      { message: { id: "m3", sessionID: "s1", role: "user" }, parts: [] },
    ])
    const result = await proxy.getMessages("s1", { before: 2, limit: 1 })
    expect(result.messages).toHaveLength(1)
    expect(result.start).toBe(1)
  })

  it("sendMessage records the call", async () => {
    const proxy = new TestBackendProxy()
    await proxy.sendMessage("s1", { content: "hello" })
    expect(proxy.sentMessages).toHaveLength(1)
    expect(proxy.sentMessages[0]).toEqual({ sessionId: "s1", params: { content: "hello" } })
  })

  it("getConfig returns configurable models", async () => {
    const proxy = new TestBackendProxy()
    proxy.setConfig({
      models: [{ id: "gpt-4o", name: "GPT-4o", providerID: "openai" }],
      workspacePath: "/tmp/test",
    })
    const config = await proxy.getConfig()
    expect(config.models).toHaveLength(1)
    expect(config.workspacePath).toBe("/tmp/test")
  })

  it("replyPermission records the reply", async () => {
    const proxy = new TestBackendProxy()
    await proxy.replyPermission("s1", "req-1", "once")
    expect(proxy.permissionReplies).toHaveLength(1)
    expect(proxy.permissionReplies[0]).toEqual({ sessionId: "s1", requestId: "req-1", reply: "once" })
  })

  it("listPendingPermissions returns seeded permissions", async () => {
    const proxy = new TestBackendProxy()
    proxy.addPendingPermission({ id: "perm-1", sessionID: "s1", permission: { tool: "bash" } })
    const perms = await proxy.listPendingPermissions()
    expect(perms).toHaveLength(1)
    expect(perms[0].id).toBe("perm-1")
  })

  it("deleteSession removes session from list", async () => {
    const proxy = new TestBackendProxy()
    proxy.addSession({ id: "s1", title: "Chat 1" })
    await proxy.deleteSession("s1")
    const sessions = await proxy.listSessions()
    expect(sessions).toHaveLength(0)
  })
})
