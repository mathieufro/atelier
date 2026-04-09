import type { Page } from "@playwright/test"

export async function injectConfig(page: Page, config: { workspacePath: string; models: any[]; agents: any[]; variant?: string; favorites?: any[]; emptyModels?: boolean }) {
  const { emptyModels, ...rest } = config
  const effectiveModels = emptyModels ? [] : (config.models.length > 0 ? config.models : [{ id: "default", providerID: "test", name: "Default" }])
  await page.evaluate((cfg) => {
    window.__injectMessage({ type: "config", ...cfg })
  }, { ...rest, models: effectiveModels })
}

export async function injectSessions(page: Page, sessions: any[]) {
  await page.evaluate((sess) => {
    window.__injectMessage({ type: "sessions", sessions: sess })
  }, sessions)
}

export async function injectActiveSession(page: Page, sessionId: string) {
  await page.evaluate((id) => {
    window.__injectMessage({ type: "activeSession", sessionId: id })
  }, sessionId)
}

export async function injectMessages(page: Page, sessionId: string, messages: any[], opts?: { start?: number; end?: number; total?: number; direction?: string }) {
  await page.evaluate(({ sid, msgs, o }) => {
    window.__injectMessage({
      type: "messages",
      sessionId: sid,
      messages: msgs,
      start: o?.start ?? 0,
      end: o?.end ?? msgs.length,
      total: o?.total ?? msgs.length,
      direction: o?.direction ?? "replace",
    })
  }, { sid: sessionId, msgs: messages, o: opts })
}

export async function injectConnectionState(page: Page, state: "connected" | "disconnected" | "reconnecting") {
  await page.evaluate((s) => {
    window.__injectMessage({ type: "connectionState", state: s })
  }, state)
}

export async function injectEvent(page: Page, event: Record<string, unknown>) {
  await page.evaluate((evt) => {
    window.__injectMessage({ type: "event", event: evt })
  }, event)
}

export async function waitForRender(page: Page, delayMs = 300) {
  await page.waitForTimeout(delayMs)
}
