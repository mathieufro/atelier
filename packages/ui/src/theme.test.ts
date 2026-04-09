import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

describe("VS Code theme", () => {
  const css = readFileSync(resolve(__dirname, "index.css"), "utf-8")

  it("defines vscode CSS variable theme tokens", () => {
    expect(css).toContain("--color-vsc-editor-bg")
    expect(css).toContain("--color-vsc-editor-fg")
    expect(css).toContain("--color-vsc-input-bg")
    expect(css).toContain("--color-vsc-sidebar-bg")
    expect(css).toContain("--color-vsc-panel-border")
    expect(css).toContain("--color-vsc-button-bg")
    expect(css).toContain("--color-vsc-link")
    expect(css).toContain("--color-vsc-description-fg")
    expect(css).toContain("--color-vsc-disabled-fg")
    expect(css).toContain("--color-vsc-error")
    expect(css).toContain("--color-vsc-success")
    expect(css).toContain("--color-vsc-warning")
  })

  it("defines vscode font family tokens", () => {
    expect(css).toContain("--font-vsc-ui")
    expect(css).toContain("--font-vsc-mono")
  })

  it("does not contain hardcoded zinc color classes", () => {
    // CSS should use vsc- variable tokens, not hardcoded Tailwind zinc classes
    expect(css).not.toContain("bg-zinc-")
    expect(css).not.toContain("text-zinc-")
    expect(css).not.toContain("border-zinc-")
  })
})
