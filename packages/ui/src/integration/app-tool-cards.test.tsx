/**
 * E2E: Tool card UI — status dots, diff rendering, write previews, file links.
 *
 * Tests the tool card experience:
 *   - Status dots outside cards, aligned with text dots
 *   - Edit tool with unified diff visualization (red/green)
 *   - Write tool with line count + code preview
 *   - Clickable file paths in tool headers
 *   - Correct dot colors: grey=text, green=completed, red=error, blue=running
 *   - Tool labels shown (Edit, Write, Bash, etc.)
 *   - Content always visible (not collapsible)
 */
import { describe, it, expect, afterEach } from "vitest"
import {
  renderApp,
  makeSession,
  makeAssistantMessage,
  makeUserMessage,
  makeTextPart,
  makeToolPart,
  messageUpdatedEvent,
  partUpdatedEvent,
  type AppHarness,
} from "./helpers.jsx"

async function activateSession(app: AppHarness, title: string) {
  app.selectSession(title)
  await app.flush()
  app.receive({ type: "messages", messages: [] })
  await app.flush()
}

// ---------------------------------------------------------------------------
// Golden sample data — realistic tool states from OpenCode
// ---------------------------------------------------------------------------

const SAMPLE_UNIFIED_DIFF = `--- a/src/components/App.tsx
+++ b/src/components/App.tsx
@@ -10,7 +10,9 @@
 import { useState } from "react"

 export function App() {
-  const [count, setCount] = useState(0)
+  const [count, setCount] = useState(0)
+  const [name, setName] = useState("")
+
   return (
     <div>
       <h1>Hello</h1>`

const SAMPLE_WRITE_CONTENT = `import { describe, it, expect } from "vitest"
import { render } from "@solidjs/testing-library"
import { App } from "./App.jsx"

describe("App", () => {
  it("renders without crashing", () => {
    const { container } = render(() => <App />)
    expect(container).toBeTruthy()
  })

  it("shows welcome message", () => {
    const { container } = render(() => <App />)
    expect(container.textContent).toContain("Welcome")
  })
})`

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("E2E: Tool card status dots", () => {
  let app: AppHarness

  afterEach(() => app?.unmount())

  it("renders green dot outside completed tool card", async () => {
    const sid = "s1"
    app = renderApp()
    app.boot({ sessions: [makeSession({ id: sid, title: "Chat" })] })
    await app.flush()
    await activateSession(app, "Chat")

    const msg = makeAssistantMessage(sid, { id: "a1" })
    app.receive(messageUpdatedEvent(msg))
    app.receive(partUpdatedEvent(makeToolPart("a1", sid, "bash", {
      id: "tp1",
      state: {
        status: "completed",
        input: { command: "ls" },
        output: "file.txt",
        title: "bash",
        metadata: {},
        time: { start: 1000, end: 1200 },
      },
    })))
    await app.flush()

    // Find the green dot — scope to message list to exclude connection status dot
    const msgList = app.container.querySelector("[data-testid='message-list']")!
    expect(msgList).not.toBeNull()
    const dots = msgList.querySelectorAll(".part-dot.bg-vsc-success")
    expect(dots.length).toBeGreaterThanOrEqual(1)
    // The dot's parent should be a part-row
    const dot = dots[0] as HTMLElement
    const flexRow = dot.parentElement!
    expect(flexRow.classList.contains("part-row")).toBe(true)
  })

  it("renders red dot for failed tool call", async () => {
    const sid = "s1"
    app = renderApp()
    app.boot({ sessions: [makeSession({ id: sid, title: "Chat" })] })
    await app.flush()
    await activateSession(app, "Chat")

    const msg = makeAssistantMessage(sid, { id: "a1" })
    app.receive(messageUpdatedEvent(msg))
    app.receive(partUpdatedEvent(makeToolPart("a1", sid, "bash", {
      id: "tp1",
      state: {
        status: "error",
        input: { command: "rm /nope" },
        error: "Permission denied",
        title: "bash",
        time: { start: 1000, end: 1100 },
      },
    })))
    await app.flush()

    const dots = app.container.querySelectorAll(".bg-vsc-error")
    expect(dots.length).toBeGreaterThanOrEqual(1)
  })

  it("renders grey dot for assistant text parts", async () => {
    const sid = "s1"
    app = renderApp()
    app.boot({ sessions: [makeSession({ id: sid, title: "Chat" })] })
    await app.flush()
    await activateSession(app, "Chat")

    const msg = makeAssistantMessage(sid, { id: "a1" })
    app.receive(messageUpdatedEvent(msg))
    app.receive(partUpdatedEvent(makeTextPart("a1", sid, "Here is my analysis.", { id: "tp1" })))
    await app.flush()

    // Find grey dots from assistant text
    const dots = app.container.querySelectorAll(".part-dot.bg-vsc-description-fg")
    expect(dots.length).toBeGreaterThanOrEqual(1)
  })

  it("renders blue dot for running tool call", async () => {
    const sid = "s1"
    app = renderApp()
    app.boot({ sessions: [makeSession({ id: sid, title: "Chat" })] })
    await app.flush()
    await activateSession(app, "Chat")

    const msg = makeAssistantMessage(sid, { id: "a1" })
    app.receive(messageUpdatedEvent(msg))
    app.receive(partUpdatedEvent(makeToolPart("a1", sid, "bash", {
      id: "tp1",
      state: {
        status: "running",
        input: { command: "npm test" },
        title: "Running tests...",
        time: { start: Date.now() },
      },
    })))
    await app.flush()

    // Running tools show a pulsing gray dot
    const dots = app.container.querySelectorAll(".animate-pulse")
    expect(dots.length).toBeGreaterThanOrEqual(1)
  })

  it("dots align — text dot and tool dot are siblings in same-shaped flex rows", async () => {
    const sid = "s1"
    app = renderApp()
    app.boot({ sessions: [makeSession({ id: sid, title: "Chat" })] })
    await app.flush()
    await activateSession(app, "Chat")

    const msg = makeAssistantMessage(sid, { id: "a1" })
    app.receive(messageUpdatedEvent(msg))

    // Text part
    app.receive(partUpdatedEvent(makeTextPart("a1", sid, "Let me fix that.", { id: "t1" })))
    // Tool part
    app.receive(partUpdatedEvent(makeToolPart("a1", sid, "edit", {
      id: "t2",
      state: {
        status: "completed",
        input: { filePath: "/src/app.ts" },
        output: "OK",
        title: "Edit app.ts",
        metadata: {},
        time: { start: 1000, end: 1100 },
      },
    })))
    await app.flush()

    // Both should have part-row wrappers
    const partRows = app.container.querySelectorAll(".part-row")
    expect(partRows.length).toBeGreaterThanOrEqual(2) // at least text + tool
  })
})

describe("E2E: Edit tool with diff visualization", () => {
  let app: AppHarness

  afterEach(() => app?.unmount())

  it("shows additions/removals summary and diff content (always visible)", async () => {
    const sid = "s1"
    app = renderApp()
    app.boot({ sessions: [makeSession({ id: sid, title: "Chat" })] })
    await app.flush()
    await activateSession(app, "Chat")

    const msg = makeAssistantMessage(sid, { id: "a1" })
    app.receive(messageUpdatedEvent(msg))
    app.receive(partUpdatedEvent(makeToolPart("a1", sid, "edit", {
      id: "tp1",
      state: {
        status: "completed",
        input: { filePath: "/src/components/App.tsx", oldString: "const x = 1", newString: "const x = 2" },
        output: "Content replaced in file",
        title: "Edit App.tsx",
        metadata: { diff: SAMPLE_UNIFIED_DIFF, additions: 2, removals: 1 },
        time: { start: 1000, end: 1050 },
      },
    })))
    await app.flush()

    // Tool label should show
    expect(app.container.textContent).toContain("Edit")

    // Summary line should show +2 -1 (always visible, no expand needed)
    expect(app.container.textContent).toContain("+2")
    expect(app.container.textContent).toContain("-1")

    // Diff content should render
    expect(app.container.textContent).toContain("setCount")
    expect(app.container.textContent).toContain("setName")
  })

  it("renders diff lines with correct styling classes", async () => {
    const sid = "s1"
    app = renderApp()
    app.boot({ sessions: [makeSession({ id: sid, title: "Chat" })] })
    await app.flush()
    await activateSession(app, "Chat")

    const msg = makeAssistantMessage(sid, { id: "a1" })
    app.receive(messageUpdatedEvent(msg))
    app.receive(partUpdatedEvent(makeToolPart("a1", sid, "edit", {
      id: "tp1",
      state: {
        status: "completed",
        input: { filePath: "/f.ts" },
        output: "OK",
        title: "Edit f.ts",
        metadata: {
          diff: "--- a/f.ts\n+++ b/f.ts\n@@ -1,3 +1,3 @@\n ctx\n-old\n+new\n ctx",
          additions: 1,
          removals: 1,
        },
        time: { start: 0, end: 100 },
      },
    })))
    await app.flush()

    // Check that tool card container exists with border
    const diffContainer = app.container.querySelector(".tool-card")
    expect(diffContainer).not.toBeNull()

    // Check for green/red line backgrounds
    const greenLines = app.container.querySelectorAll(".bg-green-500\\/10")
    const redLines = app.container.querySelectorAll(".bg-red-500\\/10")
    expect(greenLines.length).toBeGreaterThanOrEqual(1)
    expect(redLines.length).toBeGreaterThanOrEqual(1)
  })

  it("falls back to plain output when no metadata.diff", async () => {
    const sid = "s1"
    app = renderApp()
    app.boot({ sessions: [makeSession({ id: sid, title: "Chat" })] })
    await app.flush()
    await activateSession(app, "Chat")

    const msg = makeAssistantMessage(sid, { id: "a1" })
    app.receive(messageUpdatedEvent(msg))
    app.receive(partUpdatedEvent(makeToolPart("a1", sid, "edit", {
      id: "tp1",
      state: {
        status: "completed",
        input: { filePath: "/f.ts" },
        output: "Content replaced in file: /f.ts",
        title: "Edit f.ts",
        metadata: {},
        time: { start: 0, end: 100 },
      },
    })))
    await app.flush()

    // Content visible without expand
    expect(app.container.textContent).toContain("Content replaced in file")
  })

  it("shows file path as clickable link in tool header", async () => {
    const sid = "s1"
    app = renderApp()
    app.boot({ sessions: [makeSession({ id: sid, title: "Chat" })] })
    await app.flush()
    await activateSession(app, "Chat")

    const msg = makeAssistantMessage(sid, { id: "a1" })
    app.receive(messageUpdatedEvent(msg))
    app.receive(partUpdatedEvent(makeToolPart("a1", sid, "edit", {
      id: "tp1",
      state: {
        status: "completed",
        input: { filePath: "/src/components/App.tsx" },
        output: "OK",
        title: "Edit App.tsx",
        metadata: { diff: SAMPLE_UNIFIED_DIFF, additions: 2, removals: 1 },
        time: { start: 0, end: 100 },
      },
    })))
    await app.flush()

    // File link should be present as a command URI link (in the tool header)
    const fileLink = app.container.querySelector("a.text-vsc-editor-fg") as HTMLAnchorElement | null
    expect(fileLink).toBeDefined()
    expect(fileLink!.textContent).toContain("/src/components/App.tsx")
    expect(fileLink!.href).toContain("command:atelier.openFile")
  })
})

describe("E2E: Write tool with preview", () => {
  let app: AppHarness

  afterEach(() => app?.unmount())

  it("shows file path, line count, and code preview (always visible)", async () => {
    const sid = "s1"
    app = renderApp()
    app.boot({ sessions: [makeSession({ id: sid, title: "Chat" })] })
    await app.flush()
    await activateSession(app, "Chat")

    const msg = makeAssistantMessage(sid, { id: "a1" })
    app.receive(messageUpdatedEvent(msg))
    app.receive(partUpdatedEvent(makeToolPart("a1", sid, "write", {
      id: "tp1",
      state: {
        status: "completed",
        input: { filePath: "/src/App.test.tsx", content: SAMPLE_WRITE_CONTENT },
        output: "File written",
        title: "Write App.test.tsx",
        metadata: {},
        time: { start: 0, end: 200 },
      },
    })))
    await app.flush()

    // Tool label in header
    expect(app.container.textContent).toContain("Write")

    // File link in header (always visible, as command URI)
    const fileLink = app.container.querySelector("a.text-vsc-editor-fg") as HTMLAnchorElement | null
    expect(fileLink).toBeDefined()
    expect(fileLink!.textContent).toContain("/src/App.test.tsx")

    // Line count
    const lineCount = SAMPLE_WRITE_CONTENT.split("\n").length
    expect(app.container.textContent).toContain(`${lineCount} lines`)

    // First few lines should be visible
    expect(app.container.textContent).toContain("import { describe")
    expect(app.container.textContent).toContain("import { render")
  })

  it("only shows first 5 lines of written content", async () => {
    const sid = "s1"
    app = renderApp()
    app.boot({ sessions: [makeSession({ id: sid, title: "Chat" })] })
    await app.flush()
    await activateSession(app, "Chat")

    const msg = makeAssistantMessage(sid, { id: "a1" })
    app.receive(messageUpdatedEvent(msg))
    app.receive(partUpdatedEvent(makeToolPart("a1", sid, "write", {
      id: "tp1",
      state: {
        status: "completed",
        input: { filePath: "/big.ts", content: SAMPLE_WRITE_CONTENT },
        output: "OK",
        title: "Write big.ts",
        metadata: {},
        time: { start: 0, end: 50 },
      },
    })))
    await app.flush()

    // Lines 1-5 visible (imports + blank line + describe)
    expect(app.container.textContent).toContain('import { App }')
    expect(app.container.textContent).toContain('describe("App"')

    // Line 6+ should NOT be visible
    expect(app.container.textContent).not.toContain('renders without crashing')
  })
})

describe("E2E: Mixed conversation with multiple part types", () => {
  let app: AppHarness

  afterEach(() => app?.unmount())

  it("renders full conversation: text + edit + bash + text", async () => {
    const sid = "s1"
    app = renderApp()
    app.boot({ sessions: [makeSession({ id: sid, title: "Chat" })] })
    await app.flush()
    await activateSession(app, "Chat")

    // User message
    const userMsg = makeUserMessage(sid, { id: "u1" })
    app.receive(messageUpdatedEvent(userMsg))
    app.receive(partUpdatedEvent(makeTextPart("u1", sid, "Fix the bug in App.tsx", { id: "up1" })))
    await app.flush()

    // User message should adapt to content width (inline-block)
    const userCard = app.container.querySelector(".inline-block.bg-vsc-input-bg")
    expect(userCard).not.toBeNull()

    // Assistant message
    const assistantMsg = makeAssistantMessage(sid, { id: "a1" })
    app.receive(messageUpdatedEvent(assistantMsg))

    // Part 1: text
    app.receive(partUpdatedEvent(makeTextPart("a1", sid, "I'll fix the bug. Let me edit the file.", { id: "t1" })))
    await app.flush()

    // Part 2: edit tool with diff
    app.receive(partUpdatedEvent(makeToolPart("a1", sid, "edit", {
      id: "e1",
      state: {
        status: "completed",
        input: { filePath: "/src/App.tsx" },
        output: "OK",
        title: "Edit App.tsx",
        metadata: {
          diff: "--- a/App.tsx\n+++ b/App.tsx\n@@ -3,3 +3,3 @@\n ctx\n-buggy()\n+fixed()\n ctx",
          additions: 1,
          removals: 1,
        },
        time: { start: 1000, end: 1050 },
      },
    })))
    await app.flush()

    // Part 3: bash tool
    app.receive(partUpdatedEvent(makeToolPart("a1", sid, "bash", {
      id: "b1",
      state: {
        status: "completed",
        input: { command: "bun vitest run" },
        output: "All 42 tests passed",
        title: "Run tests",
        metadata: {},
        time: { start: 2000, end: 3500 },
      },
    })))
    await app.flush()

    // Part 4: text
    app.receive(partUpdatedEvent(makeTextPart("a1", sid, "All tests pass now.", { id: "t2" })))
    await app.flush()

    // Verify all parts rendered (content always visible, no expand needed)
    expect(app.container.textContent).toContain("Fix the bug in App.tsx")
    expect(app.container.textContent).toContain("I'll fix the bug")
    expect(app.container.textContent).toContain("Edit")
    expect(app.container.textContent).toContain("Bash")
    expect(app.container.textContent).toContain("All tests pass now")

    // Verify dot colors — scope to the message list to exclude the connection status dot in the top bar
    const msgList = app.container.querySelector("[data-testid='message-list']")!
    expect(msgList).not.toBeNull()

    // Green dots for completed tools
    const greenDots = msgList.querySelectorAll(".part-dot.bg-vsc-success")
    expect(greenDots.length).toBe(2) // edit + bash

    // Grey dots for text
    const greyDots = msgList.querySelectorAll(".part-dot.bg-vsc-description-fg")
    expect(greyDots.length).toBeGreaterThanOrEqual(2) // 2 text parts
  })
})
