import { describe, it, expect, vi, beforeEach } from "vitest"
import { createOpenCodeProxy } from "../../src/engine/opencode-proxy.js"
import type { BackendProxy } from "../../src/engine/backend-proxy.js"

describe("OpenCodeProxy", () => {
  it("listSessions forwards to SDK and filters internal sessions", async () => {
    const mockSdk = {
      session: { list: vi.fn(async () => ({
        data: [
          { id: "visible", title: "Chat" },
          { id: "internal", title: "Compile" },
        ],
      })) },
    }
    const proxy = createOpenCodeProxy(mockSdk as any, new Set(["internal"]))
    const sessions = await proxy.listSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].id).toBe("visible")
  })

  it("sendMessage forwards content and params to SDK", async () => {
    const mockSdk = {
      session: { prompt: vi.fn(async () => {}) },
    }
    const proxy = createOpenCodeProxy(mockSdk as any, new Set())
    await proxy.sendMessage("s1", { content: "hello" })
    expect(mockSdk.session.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ sessionID: "s1" }),
    )
  })

  it("createSession delegates to SDK", async () => {
    const mockSdk = {
      session: { create: vi.fn(async () => ({ data: { id: "new-session" } })) },
    }
    const proxy = createOpenCodeProxy(mockSdk as any, new Set())
    const result = await proxy.createSession()
    expect(result.id).toBe("new-session")
  })

  it("getSession delegates to SDK", async () => {
    const mockSdk = {
      session: { get: vi.fn(async () => ({ data: { id: "s1", title: "Test" } })) },
    }
    const proxy = createOpenCodeProxy(mockSdk as any, new Set())
    const result = await proxy.getSession("s1")
    expect(result.id).toBe("s1")
  })

  it("deleteSession delegates to SDK", async () => {
    const mockSdk = {
      session: { delete: vi.fn(async () => {}) },
    }
    const proxy = createOpenCodeProxy(mockSdk as any, new Set())
    await proxy.deleteSession("s1")
    expect(mockSdk.session.delete).toHaveBeenCalledWith({ sessionID: "s1" })
  })

  it("abortSession delegates to SDK", async () => {
    const mockSdk = {
      session: { abort: vi.fn(async () => {}) },
    }
    const proxy = createOpenCodeProxy(mockSdk as any, new Set())
    await proxy.abortSession("s1")
    expect(mockSdk.session.abort).toHaveBeenCalledWith({ sessionID: "s1" })
  })

  it("getMessages maps SDK info field to message", async () => {
    const mockSdk = {
      session: { messages: vi.fn(async () => ({ data: [
        { info: { id: "m1", role: "user", content: "hello" }, parts: [{ type: "text", text: "hello" }] },
      ] })) },
    }
    const proxy = createOpenCodeProxy(mockSdk as any, new Set())
    const page = await proxy.getMessages("s1")
    expect(page.messages).toEqual([{
      message: { id: "m1", role: "user", content: "hello" },
      parts: [{ type: "text", text: "hello" }],
    }])
    expect(page.start).toBe(0)
    expect(page.end).toBe(1)
    expect(page.total).toBe(1)
  })

  it("getMessages supports before pagination", async () => {
    const mockSdk = {
      session: { messages: vi.fn(async () => ({ data: [
        { info: { id: "m1" }, parts: [] },
        { info: { id: "m2" }, parts: [] },
        { info: { id: "m3" }, parts: [] },
      ] })) },
    }
    const proxy = createOpenCodeProxy(mockSdk as any, new Set())
    const page = await proxy.getMessages("s1", { before: 2, limit: 1 })
    expect(page.messages).toHaveLength(1)
    expect(page.messages[0].message.id).toBe("m2")
    expect(page.start).toBe(1)
    expect(page.end).toBe(2)
    expect(page.total).toBe(3)
  })

  it("getConfig returns models from provider.list and workspace from config.get", async () => {
    const mockSdk = {
      config: { get: vi.fn(async () => ({
        data: { path: { cwd: "/workspace" } },
      })) },
      provider: { list: vi.fn(async () => ({
        data: {
          all: [
            {
              id: "anthropic",
              models: {
                "claude-sonnet": { id: "claude-sonnet-4-20250514", name: "Claude Sonnet", limit: { context: 200000, output: 16384 }, reasoning: true, variants: { thinking: {} } },
              },
            },
            { id: "disconnected-provider", models: { "some-model": { id: "sm", name: "Some Model" } } },
          ],
          connected: ["anthropic"],
        },
      })) },
    }
    const proxy = createOpenCodeProxy(mockSdk as any, new Set())
    const config = await proxy.getConfig()
    expect(config.workspacePath).toBe("/workspace")
    expect(config.models).toHaveLength(1)
    expect(config.models[0].providerID).toBe("anthropic")
    expect(config.models[0].name).toBe("Claude Sonnet")
    expect(config.models[0].variants).toEqual({ thinking: {} })
  })

  it("replyPermission delegates to SDK permission.reply with once/always/reject", async () => {
    const mockSdk = {
      permission: { reply: vi.fn(async () => {}) },
    }
    const proxy = createOpenCodeProxy(mockSdk as any, new Set())
    await proxy.replyPermission("s1", "req1", "always")
    expect(mockSdk.permission.reply).toHaveBeenCalledWith({
      requestID: "req1",
      reply: "always",
    })
  })

  it("replyPermission passes reject to SDK", async () => {
    const mockSdk = {
      permission: { reply: vi.fn(async () => {}) },
    }
    const proxy = createOpenCodeProxy(mockSdk as any, new Set())
    await proxy.replyPermission("s1", "req1", "reject")
    expect(mockSdk.permission.reply).toHaveBeenCalledWith({
      requestID: "req1",
      reply: "reject",
    })
  })

  it("replyQuestion delegates to SDK question.reply", async () => {
    const mockSdk = {
      question: { reply: vi.fn(async () => {}) },
    }
    const proxy = createOpenCodeProxy(mockSdk as any, new Set())
    await proxy.replyQuestion("s1", "req1", [["yes"]])
    expect(mockSdk.question.reply).toHaveBeenCalledWith({
      requestID: "req1",
      answers: [["yes"]],
    })
  })

  it("rejectQuestion delegates to SDK question.reject", async () => {
    const mockSdk = {
      question: { reject: vi.fn(async () => {}) },
    }
    const proxy = createOpenCodeProxy(mockSdk as any, new Set())
    await proxy.rejectQuestion("s1", "req1")
    expect(mockSdk.question.reject).toHaveBeenCalledWith({
      requestID: "req1",
    })
  })

  it("updateSessionTitle also updates metadata store", async () => {
    const mockSdk = {
      session: { update: vi.fn(async () => {}) },
    }
    const metadataStore = {
      update: vi.fn(),
    }
    const proxy = createOpenCodeProxy(mockSdk as any, new Set(), undefined, metadataStore as any)

    await proxy.updateSessionTitle("s1", "Fix auth flow")

    expect(mockSdk.session.update).toHaveBeenCalledWith({ sessionID: "s1", title: "Fix auth flow" })
    expect(metadataStore.update).toHaveBeenCalledWith("s1", { title: "Fix auth flow" })
  })
})

describe("OpenCodeProxy BackendProxy conformance", () => {
  it("implements BackendProxy interface", () => {
    const mockClient = {
      session: { list: vi.fn(), create: vi.fn(), get: vi.fn(), delete: vi.fn(), abort: vi.fn(), messages: vi.fn(), prompt: vi.fn(), update: vi.fn() },
      config: { get: vi.fn() },
      provider: { list: vi.fn() },
      permission: { reply: vi.fn(), list: vi.fn() },
      question: { reply: vi.fn(), reject: vi.fn(), list: vi.fn() },
    }
    const proxy = createOpenCodeProxy(mockClient as any, new Set(), "/ws")
    const bp: BackendProxy = proxy
    expect(typeof bp.listSessions).toBe("function")
    expect(typeof bp.getSession).toBe("function")
    expect(typeof bp.deleteSession).toBe("function")
    expect(typeof bp.abortSession).toBe("function")
    expect(typeof bp.getMessages).toBe("function")
    expect(typeof bp.sendMessage).toBe("function")
    expect(typeof bp.getConfig).toBe("function")
    expect(typeof bp.replyPermission).toBe("function")
    expect(typeof bp.replyQuestion).toBe("function")
    expect(typeof bp.rejectQuestion).toBe("function")
    expect(typeof bp.listPendingPermissions).toBe("function")
    expect(typeof bp.listPendingQuestions).toBe("function")
    expect(typeof bp.updateSessionTitle).toBe("function")
  })
})
