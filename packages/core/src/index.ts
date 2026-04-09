export * from "./types.js"
export type { AtelierEvent, ContentBlock, AtelierMessage, BackendId } from "./atelier-events.js"
export * from "./messages.js"
export * from "./logger.js"

// Note: `state-dir` and `agent-engine` are intentionally NOT re-exported here.
// They depend on Node.js-only APIs (fs, path) and should not be bundled into
// the browser-targeted UI package. Import them directly from their own entry
// points (e.g., `@atelier/core/agent-engine`) when needed in Node.js contexts.
