export const backends = {
  "claude-code": {
    model: { providerID: "anthropic", modelID: "haiku" },
    variant: "high",
  },
  opencode: {
    model: { providerID: "openai", modelID: "gpt-5.3-codex-spark" },
    variant: "high",
  },
} as const

/**
 * Detect available backends by polling the server's /config endpoint.
 */
export async function getAvailableBackendsFromServer(serverUrl: string, waitMs = 30_000): Promise<Array<"claude-code" | "opencode">> {
  // Poll until both backends register or timeout — OpenCode can take a while to start
  const deadline = Date.now() + waitMs
  let lastAvailable: Array<"claude-code" | "opencode"> = []
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${serverUrl}/config`)
      if (res.ok) {
        const config = await res.json() as any
        const models = config.models ?? []
        const available: Array<"claude-code" | "opencode"> = []
        if (models.some((m: any) => m.backend === "claude-code")) available.push("claude-code")
        if (models.some((m: any) => m.backend === "opencode")) available.push("opencode")
        lastAvailable = available
        // Both backends found — done
        if (available.length >= 2) return available
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 2_000))
  }
  return lastAvailable.length > 0 ? lastAvailable : ["claude-code"]
}

/**
 * Static list for describe.each — both backends listed.
 * Tests skip at runtime if the backend isn't available on the server.
 */
export function getAvailableBackends(): Array<"claude-code" | "opencode"> {
  return ["claude-code", "opencode"]
}
