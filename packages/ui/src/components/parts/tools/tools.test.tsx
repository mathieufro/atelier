import { describe, it, expect, vi } from "vitest"
import { render } from "@solidjs/testing-library"
import type { ToolState, ToolStatePending, ToolStateRunning, ToolStateCompleted, ToolStateError } from "@atelier/core"
import { BashToolView } from "./BashTool.jsx"
import { EditToolView } from "./EditTool.jsx"
import { WriteToolView } from "./WriteTool.jsx"
import { WebFetchToolView } from "./WebFetchTool.jsx"
import { TodoToolView } from "./TodoTool.jsx"
import { McpToolView } from "./McpTool.jsx"
import { GenericToolView } from "./GenericTool.jsx"
import { parseUnifiedDiff } from "./DiffView.jsx"

// Factory helpers for tool states
const pendingState = (input: Record<string, unknown> = {}): ToolStatePending => ({
  status: "pending",
  input,
  raw: "",
} as ToolStatePending)

const runningState = (input: Record<string, unknown> = {}): ToolStateRunning => ({
  status: "running",
  input,
  time: { start: Date.now() },
  title: "Running...",
})

const completedState = (input: Record<string, unknown>, output: string): ToolStateCompleted => ({
  status: "completed",
  input,
  output,
  metadata: {},
  time: { start: Date.now(), end: Date.now() + 100 },
  title: "Done",
})

const errorState = (input: Record<string, unknown>, error: string): ToolStateError => ({
  status: "error",
  input,
  error,
  time: { start: Date.now(), end: Date.now() + 100 },
} as ToolStateError)

// --- BashTool ---

describe("BashToolView", () => {
  it("renders command", () => {
    const { container } = render(() => <BashToolView state={pendingState({ command: "ls -la" })} />)
    expect(container.textContent).toContain("ls -la")
    expect(container.textContent).toContain("$")
  })

  it("renders output on completion", () => {
    const { container } = render(() => <BashToolView state={completedState({ command: "echo hi" }, "hi")} />)
    expect(container.textContent).toContain("hi")
  })

  it("renders error state", () => {
    const { container } = render(() => <BashToolView state={errorState({ command: "fail" }, "command not found")} />)
    expect(container.textContent).toContain("command not found")
  })
})

// --- EditTool ---

describe("EditToolView", () => {
  it("renders diff from metadata when available", () => {
    const state: ToolStateCompleted = {
      status: "completed",
      input: { filePath: "/src/app.ts" },
      output: "Content replaced",
      metadata: {
        diff: "--- a/app.ts\n+++ b/app.ts\n@@ -1,3 +1,3 @@\n context\n-old line\n+new line\n context",
        additions: 1,
        removals: 1,
      },
      time: { start: 0, end: 100 },
      title: "Edit app.ts",
    }
    const { container } = render(() => <EditToolView state={state} />)
    expect(container.textContent).toContain("+1")
    expect(container.textContent).toContain("-1")
    expect(container.textContent).toContain("old line")
    expect(container.textContent).toContain("new line")
  })

  it("falls back to output when no metadata.diff", () => {
    const { container } = render(() => (
      <EditToolView state={completedState({ filePath: "/src/app.ts" }, "Content replaced")} />
    ))
    expect(container.textContent).toContain("Content replaced")
  })
})

// --- DiffView parser ---

describe("parseUnifiedDiff", () => {
  it("parses a simple unified diff", () => {
    const diff = `--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,3 @@
 context
-removed
+added
 context`
    const hunks = parseUnifiedDiff(diff)
    expect(hunks).toHaveLength(1)
    expect(hunks[0]!.lines).toHaveLength(4)
    expect(hunks[0]!.lines[0]!.type).toBe("context")
    expect(hunks[0]!.lines[1]!.type).toBe("remove")
    expect(hunks[0]!.lines[1]!.content).toBe("removed")
    expect(hunks[0]!.lines[2]!.type).toBe("add")
    expect(hunks[0]!.lines[2]!.content).toBe("added")
  })

  it("tracks line numbers correctly", () => {
    const diff = `--- a/f.ts
+++ b/f.ts
@@ -5,3 +5,4 @@
 ctx
-old
+new1
+new2
 ctx`
    const hunks = parseUnifiedDiff(diff)
    const lines = hunks[0]!.lines
    expect(lines[0]!.oldLineNo).toBe(5)
    expect(lines[0]!.newLineNo).toBe(5)
    expect(lines[1]!.oldLineNo).toBe(6) // removed line
    expect(lines[2]!.newLineNo).toBe(6) // first add
    expect(lines[3]!.newLineNo).toBe(7) // second add
  })
})

// --- FileTool (now falls through to GenericToolView) ---

describe("read/view tools via GenericToolView", () => {
  it("renders tool name for successful read", () => {
    const { container } = render(() => (
      <GenericToolView tool="read" state={completedState({ filePath: "/src/index.ts" }, "const x = 1\nconst y = 2")} />
    ))
    expect(container.textContent).toContain("read")
  })

  it("shows error on failure via GenericToolView", () => {
    const state: ToolState = { tool: "read", status: "error", input: { filePath: "/missing.ts" }, error: "File not found", time: { start: 0, end: 10 } } as any
    const { container } = render(() => (
      <GenericToolView tool="read" state={state} />
    ))
    expect(container.textContent).toContain("File not found")
  })
})

// --- WriteTool ---

describe("WriteToolView", () => {
  it("renders content preview and line count", () => {
    const { container } = render(() => (
      <WriteToolView state={pendingState({ filePath: "/src/new.ts", content: "const x = 1" })} />
    ))
    expect(container.textContent).toContain("const x = 1")
    expect(container.textContent).toContain("1 line")
  })

  it("shows only first 5 lines for long content", () => {
    const longContent = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n")
    const { container } = render(() => (
      <WriteToolView state={pendingState({ filePath: "f.ts", content: longContent })} />
    ))
    expect(container.textContent).toContain("line 1")
    expect(container.textContent).toContain("line 5")
    expect(container.textContent).not.toContain("line 6")
    expect(container.textContent).toContain("20 lines")
  })
})

// --- GlobGrepTool (now falls through to GenericToolView) ---

describe("glob/grep tools via GenericToolView", () => {
  it("renders tool name for successful glob", () => {
    const { container } = render(() => (
      <GenericToolView tool="glob" state={{ status: "completed", input: { pattern: "**/*.ts" }, output: "src/a.ts\nsrc/b.ts", title: "glob", metadata: {}, time: { start: 0, end: 100 } } as ToolState} />
    ))
    expect(container.textContent).toContain("glob")
  })

  it("shows error on failure via GenericToolView", () => {
    const { container } = render(() => (
      <GenericToolView tool="grep" state={{ status: "error", input: { pattern: "TODO" }, error: "no matches", time: { start: 0, end: 50 } } as ToolState} />
    ))
    expect(container.textContent).toContain("no matches")
  })
})

// --- WebFetchTool ---

describe("WebFetchToolView", () => {
  it("renders URL", () => {
    const { container } = render(() => (
      <WebFetchToolView state={pendingState({ url: "https://example.com" })} />
    ))
    expect(container.textContent).toContain("https://example.com")
  })

  it("truncates long output to 5 lines", () => {
    const longOutput = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n")
    const { container } = render(() => (
      <WebFetchToolView state={completedState({ url: "https://example.com" }, longOutput)} />
    ))
    expect(container.textContent).toContain("line 1")
    expect(container.textContent).toContain("line 5")
    expect(container.textContent).not.toContain("line 6")
  })
})

// --- TodoTool ---

describe("TodoToolView", () => {
  it("renders todo items from input", () => {
    const { container } = render(() => (
      <TodoToolView state={pendingState({ todos: [
        { content: "Task 1", status: "completed" },
        { content: "Task 2", status: "in_progress", activeForm: "Working on Task 2" },
        { content: "Task 3", status: "pending" },
      ] })} />
    ))
    expect(container.textContent).toContain("Task 1")
    expect(container.textContent).toContain("Working on Task 2")
    expect(container.textContent).toContain("Task 3")
    // Checkbox SVG for completed item
    expect(container.querySelector("svg")).toBeTruthy()
  })

  it("shows no todos fallback", () => {
    const { container } = render(() => <TodoToolView state={pendingState({})} />)
    expect(container.textContent).toContain("No todos")
  })
})

// --- McpTool ---

describe("McpToolView", () => {
  it("parses server and tool name from mcp_ prefix", () => {
    const { container } = render(() => (
      <McpToolView tool="mcp_strobe_debug_launch" state={pendingState({})} />
    ))
    expect(container.textContent).toContain("strobe")
    expect(container.textContent).toContain("debug_launch")
  })

  it("renders input JSON", () => {
    const { container } = render(() => (
      <McpToolView tool="mcp_strobe_test" state={pendingState({ key: "value" })} />
    ))
    expect(container.textContent).toContain("key")
    expect(container.textContent).toContain("value")
  })
})

// --- GenericTool ---

describe("GenericToolView", () => {
  it("renders tool name", () => {
    const { container } = render(() => (
      <GenericToolView tool="custom_tool" state={pendingState({})} />
    ))
    expect(container.textContent).toContain("custom_tool")
  })

  it("shows/hides input on toggle", async () => {
    const { container } = render(() => (
      <GenericToolView tool="custom" state={pendingState({ key: "val" })} />
    ))
    const btn = container.querySelector("button")
    expect(btn?.textContent).toContain("show input")
    btn?.click()
    expect(container.textContent).toContain("key")
  })

  it("shows error state", () => {
    const { container } = render(() => (
      <GenericToolView tool="custom" state={errorState({}, "something failed")} />
    ))
    expect(container.textContent).toContain("something failed")
  })
})

// --- m14: Tool state transitions ---

describe("Tool state transitions", () => {
  it("BashTool transitions pending → running → completed → error", () => {
    // Pending
    let { container } = render(() => <BashToolView state={pendingState({ command: "ls" })} />)
    expect(container.textContent).toContain("ls")

    // Running
    ;({ container } = render(() => <BashToolView state={runningState({ command: "ls" })} />))
    expect(container.textContent).toContain("ls")

    // Completed
    ;({ container } = render(() => <BashToolView state={completedState({ command: "ls" }, "file.txt")} />))
    expect(container.textContent).toContain("file.txt")

    // Error
    ;({ container } = render(() => <BashToolView state={errorState({ command: "ls" }, "denied")} />))
    expect(container.textContent).toContain("denied")
  })
})
