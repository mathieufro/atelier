/**
 * Pure decision functions for session forking.
 * No vscode dependency — testable with plain Maps.
 */

/** Should we fork when switching to a session that's active in another panel? */
export function shouldForkOnSwitch<P>(
  targetSessionId: string,
  currentPanel: P,
  panelActiveSessionIds: Map<P, string | null>,
  sessionStatusCache: Map<string, "busy" | "idle">,
): boolean {
  let inOtherPanel = false
  for (const [panel, sessionId] of panelActiveSessionIds) {
    if (panel !== currentPanel && sessionId === targetSessionId) {
      inOtherPanel = true
      break
    }
  }
  if (!inOtherPanel) return false
  return sessionStatusCache.get(targetSessionId) === "busy"
}

/** Find panels viewing a session, excluding the sender panel. */
export function findBystanderPanels<P>(
  sessionId: string,
  senderPanel: P,
  panelActiveSessionIds: Map<P, string | null>,
): P[] {
  const bystanders: P[] = []
  for (const [panel, activeId] of panelActiveSessionIds) {
    if (panel !== senderPanel && activeId === sessionId) {
      bystanders.push(panel)
    }
  }
  return bystanders
}

/** Should an empty fork be cleaned up when a panel closes? */
export function shouldCleanupFork<P>(
  sessionId: string,
  closingPanel: P,
  forkTracker: Map<string, { hasUserMessages: boolean }>,
  panelActiveSessionIds: Map<P, string | null>,
): boolean {
  const tracking = forkTracker.get(sessionId)
  if (!tracking) return false
  if (tracking.hasUserMessages) return false
  for (const [panel, activeId] of panelActiveSessionIds) {
    if (panel !== closingPanel && activeId === sessionId) return false
  }
  return true
}

/** Find orphan forks from a session list (for startup sweep). */
export function findOrphanForks(
  sessions: Array<{ id: string; forkedFrom?: string; createdAt: number; lastActiveAt: number }>,
  thresholdMs: number,
): string[] {
  return sessions
    .filter((s) => s.forkedFrom && (s.lastActiveAt - s.createdAt) < thresholdMs)
    .map((s) => s.id)
}
