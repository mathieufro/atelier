const DEBUG_KEY = "atelier:debug"

function isDebugEnabled(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(DEBUG_KEY) === "1"
  } catch {
    return false
  }
}

export function debug(action: string, data?: Record<string, unknown>): void {
  if (!isDebugEnabled()) return
  if (data) {
    console.debug(`[atelier] ${action}`, data)
  } else {
    console.debug(`[atelier] ${action}`)
  }
}
