import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import type { OpenCodeProxy } from "../app.js"
import type { PermissionRuleset } from "@atelier/core"
import type { SessionMetadataStore } from "./session-metadata-store.js"

export function createOpenCodeProxy(
  client: OpencodeClient,
  internalSessions: Set<string>,
  workspacePath?: string,
  metadataStore?: SessionMetadataStore,
): OpenCodeProxy {
  return {
    async listSessions() {
      const res = await client.session.list()
      const sessions = (res.data as Array<{ id: string; directory?: string; [k: string]: unknown }>) ?? []
      return sessions.filter((s) =>
        !internalSessions.has(s.id)
        && (!workspacePath || s.directory === workspacePath),
      )
    },

    async createSession(permission?: PermissionRuleset) {
      const res = await client.session.create(permission ? { permission } : {})
      return { id: (res.data as { id: string }).id }
    },

    async getSession(id: string) {
      const res = await client.session.get({ sessionID: id })
      return res.data as Record<string, unknown>
    },

    async deleteSession(id: string) {
      await client.session.delete({ sessionID: id })
      metadataStore?.delete(id)
    },

    async abortSession(id: string) {
      await client.session.abort({ sessionID: id })
    },

    // Pagination uses index-based cursors (before/after). This assumes messages are
    // append-only within a session — existing messages are never reordered or deleted.
    async getMessages(id: string, opts?: { before?: number; after?: number; limit?: number }) {
      interface MessageItem { info?: Record<string, unknown>; parts?: unknown[] }
      const res = await client.session.messages({ sessionID: id })
      const all = ((res.data as MessageItem[]) ?? []).map((item) => ({
        message: (item.info ?? {}) as Record<string, unknown>,
        parts: (item.parts ?? []) as Array<Record<string, unknown>>,
      }))
      const total = all.length
      const rawLimit = opts?.limit ?? 80
      const limit = Math.max(1, Math.min(rawLimit, 200))

      let start = 0
      let end = total
      if (opts?.before !== undefined) {
        end = Math.max(0, Math.min(opts.before, total))
        start = Math.max(0, end - limit)
      } else if (opts?.after !== undefined) {
        start = Math.max(0, Math.min(opts.after + 1, total))
        end = Math.min(total, start + limit)
      } else {
        end = total
        start = Math.max(0, end - limit)
      }

      return {
        messages: all.slice(start, end),
        start,
        end,
        total,
      }
    },

    async sendMessage(sessionId: string, params: Record<string, unknown>) {
      const content = params.content as string
      const system = params.system as string | undefined
      const model = params.model as { providerID: string; modelID: string } | undefined
      const variant = params.variant as string | undefined
      const attachments = params.attachments as Array<{ mime: string; url: string; filename?: string }> | undefined
      const parts: Array<{ type: "text"; text: string } | { type: "file"; mime: string; url: string; filename?: string }> = [{ type: "text", text: content }]
      if (attachments) {
        for (const att of attachments) {
          parts.push({ type: "file", mime: att.mime, url: att.url, filename: att.filename })
        }
      }
      await client.session.prompt({
        sessionID: sessionId,
        parts: parts as Parameters<typeof client.session.prompt>[0]["parts"],
        model,
        variant,
        system,
      } as Parameters<typeof client.session.prompt>[0])
    },

    async getConfig() {
      const [configRes, providerRes] = await Promise.all([
        client.config.get(),
        client.provider.list(),
      ])
      interface ConfigData { path?: { cwd?: string } }
      interface ProviderModel { id?: string; name?: string; limit?: unknown; reasoning?: unknown; variants?: unknown }
      interface ProviderEntry { id: string; models?: Record<string, ProviderModel> }
      interface ProviderData { connected?: string[]; all?: ProviderEntry[] }
      const configData = configRes.data as ConfigData
      const providerData = providerRes.data as ProviderData

      const connected = new Set<string>(providerData?.connected ?? [])
      const models: Array<{ id: string; name: string; providerID: string; limit?: unknown; reasoning?: unknown; variants?: unknown }> = []
      for (const provider of providerData?.all ?? []) {
        if (!connected.has(provider.id)) continue
        for (const [key, raw] of Object.entries(provider.models ?? {})) {
          const m = raw as ProviderModel
          models.push({
            id: m.id ?? `${provider.id}/${key}`,
            name: m.name ?? key,
            providerID: provider.id,
            limit: m.limit,
            reasoning: m.reasoning,
            variants: m.variants,
          })
        }
      }

      return {
        agents: [],
        models,
        workspacePath: configData.path?.cwd ?? "",
      }
    },

    async replyPermission(_sessionId: string, requestId: string, reply: string) {
      await client.permission.reply({
        requestID: requestId,
        reply: reply as "once" | "always" | "reject",
      })
    },

    async replyQuestion(_sessionId: string, requestId: string, answers: string[][]) {
      await client.question.reply({
        requestID: requestId,
        answers,
      })
    },

    async rejectQuestion(_sessionId: string, requestId: string) {
      await client.question.reject({
        requestID: requestId,
      })
    },

    async listPendingPermissions() {
      const res = await client.permission.list()
      return (res.data as Array<{ id: string; sessionID: string; [key: string]: unknown }>) ?? []
    },

    async listPendingQuestions() {
      const res = await client.question.list()
      return (res.data as Array<{ id: string; sessionID: string; [key: string]: unknown }>) ?? []
    },

    async updateSessionTitle(sessionId: string, title: string) {
      try {
        await client.session.update({ sessionID: sessionId, title })
        metadataStore?.update(sessionId, { title })
      } catch {
        // Non-critical — title is cosmetic
      }
    },

  }
}
