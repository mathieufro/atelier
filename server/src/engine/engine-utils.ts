/** Extract session ID from an OpenCode SSE event payload. Returns undefined if not present. */
export function extractSessionId(event: Record<string, unknown>): string | undefined {
  const props = event?.properties as Record<string, unknown> | undefined
  const info = props?.info as Record<string, unknown> | undefined
  return (info?.sessionID ?? info?.id ?? props?.sessionID ?? event.sessionID) as string | undefined
}
