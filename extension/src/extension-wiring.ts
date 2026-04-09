import type { AtelierClient } from "./atelier-client.js"
import type { HostMessage, UnifiedEvent } from "@atelier/core"

/**
 * Wire AtelierClient SSE events to webview postMessage.
 * Returns a cleanup function that unsubscribes all handlers.
 */
export function wireClientToWebview(
  client: AtelierClient,
  postMessage: (msg: HostMessage) => void,
): () => void {
  const cleanups = [
    client.onEvent((event) => {
      // test events are handled at the client level (see extension.ts), not forwarded to webview
      if (event.type === "test_command" || event.type === "test_webview_message" || event.type === "test_navigate_session") return
      postMessage({ type: "event", event: event as unknown as UnifiedEvent })
    }),
    client.onConnectionStateChange((state) => {
      postMessage({ type: "connectionState", state })
    }),
    client.onRefreshNeeded(() => {
      postMessage({ type: "event", event: { type: "full_refresh_required", seq: 0 } as UnifiedEvent })
    }),
  ]

  return () => { for (const cleanup of cleanups) cleanup() }
}
