import { describe, it, expect } from "vitest"
import { render } from "@solidjs/testing-library"
import { ToolPartView } from "./ToolPart.jsx"

const base = { id: "p1", sessionID: "s1", messageID: "m1", type: "tool" as const, callID: "c1" }

describe("ToolPartView", () => {
  it("renders pending state with tool label", () => {
    const { container } = render(() =>
      <ToolPartView part={{ ...base, tool: "bash", state: { status: "pending", input: { command: "ls" }, raw: '{}' } }} />,
    )
    expect(container.textContent).toContain("Bash")
    expect(container.textContent).toContain("Preparing")
  })

  it("renders completed state with duration", () => {
    const { container } = render(() =>
      <ToolPartView part={{ ...base, tool: "bash", state: { status: "completed", input: { command: "echo hi" }, output: "hi\n", title: "bash", metadata: {}, time: { start: 1000, end: 2500 } } }} />,
    )
    expect(container.textContent).toContain("1.5s")
  })

  it("renders error state", () => {
    const { container } = render(() =>
      <ToolPartView part={{ ...base, tool: "bash", state: { status: "error", input: {}, error: "fail", time: { start: 0, end: 100 } } }} />,
    )
    expect(container.textContent).toContain("failed")
  })

  it("shows tool label for known tools", () => {
    const { container } = render(() =>
      <ToolPartView part={{ ...base, tool: "edit", state: { status: "completed", input: { filePath: "/a.ts" }, output: "OK", title: "Edit a.ts", metadata: {}, time: { start: 0, end: 1 } } }} />,
    )
    expect(container.textContent).toContain("Edit")
  })

  it("renders apply_patch with edit diff card", () => {
    const { container } = render(() =>
      <ToolPartView
        part={{
          ...base,
          tool: "apply_patch",
          state: {
            status: "completed",
            input: { patchText: "*** Begin Patch" },
            output: "Patch applied",
            title: "apply patch",
            metadata: {
              diff: "--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-old\n+new",
              additions: 1,
              removals: 1,
            },
            time: { start: 0, end: 1 },
          },
        }}
      />,
    )
    expect(container.textContent).toContain("Edit")
    expect(container.textContent).toContain("old")
    expect(container.textContent).toContain("new")
  })

  it("shows clickable file path for single-file apply_patch", () => {
    const { container } = render(() =>
      <ToolPartView
        part={{
          ...base,
          tool: "apply_patch",
          state: {
            status: "completed",
            input: { patchText: "*** Begin Patch" },
            output: "Success. Updated the following files:\nA extension/tests/atelier-server-manager.test.ts",
            title: "Success. Updated the following files:\nA extension/tests/atelier-server-manager.test.ts",
            metadata: {
              files: [{
                filePath: "/repo/extension/tests/atelier-server-manager.test.ts",
                relativePath: "extension/tests/atelier-server-manager.test.ts",
                type: "add",
                diff: "@@ -0,0 +1 @@\n+test",
                before: "",
                after: "test\n",
                additions: 1,
                deletions: 0,
              }],
            },
            time: { start: 0, end: 1 },
          },
        }}
      />,
    )
    const fileLink = container.querySelector("a.text-vsc-editor-fg") as HTMLAnchorElement | null
    expect(fileLink).toBeDefined()
    expect(fileLink!.textContent).toContain("/repo/extension/tests/atelier-server-manager.test.ts")
    expect(fileLink!.href).toContain("command:atelier.openFile")
  })

  it("shows clickable file path for file-based tools", () => {
    const { container } = render(() =>
      <ToolPartView part={{ ...base, tool: "write", state: { status: "completed", input: { filePath: "/src/app.ts", content: "x" }, output: "OK", title: "Write app.ts", metadata: {}, time: { start: 0, end: 1 } } }} />,
    )
    const fileLink = container.querySelector("a.text-vsc-editor-fg") as HTMLAnchorElement | null
    expect(fileLink).toBeDefined()
    expect(fileLink!.textContent).toContain("/src/app.ts")
    expect(fileLink!.href).toContain("command:atelier.openFile")
  })

  it("falls back to tool name for unknown tools", () => {
    const { container } = render(() =>
      <ToolPartView part={{ ...base, tool: "unknown", state: { status: "completed", input: {}, output: "x", title: "unknown", metadata: {}, time: { start: 0, end: 1 } } }} />,
    )
    expect(container.textContent).toContain("unknown")
  })

  it("renders unknown tools with non-string output", () => {
    const { container } = render(() =>
      <ToolPartView
        part={{
          ...base,
          tool: "toolsearch",
          state: {
            status: "completed",
            input: { query: "loading" },
            output: [{ file: "App.tsx", line: 42 }],
            title: "toolsearch",
            metadata: {},
            time: { start: 0, end: 1 },
          } as any,
        }}
      />,
    )
    expect(container.textContent).toContain("toolsearch")
    expect(container.textContent).toContain("App.tsx")
  })

  it("content is always visible (not collapsible)", () => {
    const { container } = render(() =>
      <ToolPartView part={{ ...base, tool: "bash", state: { status: "completed", input: { command: "ls" }, output: "done", title: "bash", metadata: {}, time: { start: 1000, end: 2000 } } }} />,
    )
    // Content should be immediately visible without clicking
    expect(container.textContent).toContain("done")
  })
})
