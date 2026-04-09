import { describe, it, expect, vi } from "vitest"
import { createRoot } from "solid-js"
import { createStreamingRenderer } from "./renderer.js"

describe("createStreamingRenderer", () => {
  it("renders plain text", () => {
    createRoot((dispose) => {
      const container = document.createElement("div")
      const renderer = createStreamingRenderer(container)
      renderer.write("Hello world")
      renderer.end()
      expect(container.textContent).toContain("Hello world")
      dispose()
    })
  })

  it("renders bold text", () => {
    createRoot((dispose) => {
      const container = document.createElement("div")
      const renderer = createStreamingRenderer(container)
      renderer.write("**bold**")
      renderer.end()
      expect(container.querySelector("strong")).not.toBeNull()
      dispose()
    })
  })

  it("renders code block with language", () => {
    createRoot((dispose) => {
      const container = document.createElement("div")
      const renderer = createStreamingRenderer(container)
      renderer.write("```typescript\nconst x = 1\n```")
      renderer.end()
      expect(container.querySelector("pre")).not.toBeNull()
      dispose()
    })
  })

  // C5: Code blocks should have copy buttons
  it("renders code block with copy button", () => {
    createRoot((dispose) => {
      const container = document.createElement("div")
      const renderer = createStreamingRenderer(container)
      renderer.write("```\ncode\n```")
      renderer.end()
      const btn = container.querySelector("button")
      expect(btn).not.toBeNull()
      expect(btn?.textContent).toContain("Copy")
      dispose()
    })
  })

  // Regression: each copy button should copy its own code block, not the last one
  it("copy buttons reference their own code block content", () => {
    createRoot((dispose) => {
      const container = document.createElement("div")
      const copied: string[] = []
      const renderer = createStreamingRenderer(container, {
        postMessage: (msg: any) => { copied.push(msg.text) },
      })
      renderer.write("```\nfirst block\n```\n\n```\nsecond block\n```")
      renderer.end()
      const buttons = container.querySelectorAll("button")
      expect(buttons.length).toBe(2)
      // Click the first button — should copy "first block", not "second block"
      buttons[0]!.click()
      expect(copied[0]).toContain("first block")
      buttons[1]!.click()
      expect(copied[1]).toContain("second block")
      dispose()
    })
  })

  // C5: Code blocks should have language class
  it("applies language class to code blocks", () => {
    createRoot((dispose) => {
      const container = document.createElement("div")
      const renderer = createStreamingRenderer(container)
      renderer.write("```typescript\nconst x = 1\n```")
      renderer.end()
      const code = container.querySelector("code")
      expect(code?.className).toContain("language-typescript")
      dispose()
    })
  })

  it("handles streaming character by character", () => {
    createRoot((dispose) => {
      const container = document.createElement("div")
      const renderer = createStreamingRenderer(container)
      for (const ch of "Hello") renderer.write(ch)
      renderer.end()
      expect(container.textContent).toContain("Hello")
      dispose()
    })
  })

  // C5: File paths detected and wrapped as clickable elements
  it("detects file paths and wraps in clickable elements", () => {
    createRoot((dispose) => {
      const container = document.createElement("div")
      const renderer = createStreamingRenderer(container, {
        onFileClick: () => {},
      })
      renderer.write("See src/foo.ts:42 for details")
      renderer.end()
      const link = container.querySelector("[data-file-path]")
      expect(link).not.toBeNull()
      dispose()
    })
  })

  // C5: File path renders as command URI link
  it("renders file paths as VS Code command URI links", () => {
    createRoot((dispose) => {
      const container = document.createElement("div")
      const renderer = createStreamingRenderer(container, { onFileClick: () => {} })
      renderer.write("See src/foo.ts:42")
      renderer.end()
      const link = container.querySelector("a[data-file-path]") as HTMLAnchorElement
      expect(link).not.toBeNull()
      expect(link.href).toContain("command:atelier.openFile")
      expect(link.href).toContain(encodeURIComponent(JSON.stringify(["src/foo.ts", 42])))
      expect(link.textContent).toBe("src/foo.ts:42")
      dispose()
    })
  })

  it("skips file path wrapping inside inline code to preserve DOM structure", () => {
    createRoot((dispose) => {
      const container = document.createElement("div")
      const renderer = createStreamingRenderer(container, { onFileClick: () => {} })
      renderer.write("`packages/ui/src/components/ChatView.tsx:169`")
      renderer.end()
      const link = container.querySelector("a[data-file-path]") as HTMLAnchorElement
      expect(link).toBeNull()
      const code = container.querySelector("code")
      expect(code).not.toBeNull()
      expect(code!.textContent).toContain("ChatView.tsx")
      dispose()
    })
  })

  it("detects file paths in plain text outside inline code", () => {
    createRoot((dispose) => {
      const container = document.createElement("div")
      const renderer = createStreamingRenderer(container, { onFileClick: () => {} })
      renderer.write("Check packages/ui/src/components/ChatView.tsx:169 for details")
      renderer.end()
      const link = container.querySelector("a[data-file-path]") as HTMLAnchorElement
      expect(link).not.toBeNull()
      expect(link.getAttribute("data-file-path")).toBe("packages/ui/src/components/ChatView.tsx")
      dispose()
    })
  })

  it("preserves inline code position when separated by slashes", () => {
    createRoot((dispose) => {
      const container = document.createElement("div")
      const renderer = createStreamingRenderer(container, { onFileClick: () => {} })
      renderer.write("Use `option-a`/`option-b` for config")
      renderer.end()
      const codes = container.querySelectorAll("code")
      expect(codes.length).toBe(2)
      // Code elements must appear before "for config", not at the end
      const html = container.innerHTML
      const codeAIdx = html.indexOf("<code")
      const forIdx = html.indexOf("for config")
      expect(codeAIdx).toBeLessThan(forIdx)
      dispose()
    })
  })

  it("detects absolute file paths with spaces", () => {
    createRoot((dispose) => {
      const container = document.createElement("div")
      const renderer = createStreamingRenderer(container, { onFileClick: () => {} })
      renderer.write("Open /home/user/project/Screenshot 2026-03-11 at 15.13.00.png")
      renderer.end()
      const link = container.querySelector("a[data-file-path]") as HTMLAnchorElement
      expect(link).not.toBeNull()
      expect(link.getAttribute("data-file-path")).toBe("/home/user/project/Screenshot 2026-03-11 at 15.13.00.png")
      dispose()
    })
  })

  // File path regex should not match version strings or URL paths
  it("does not match version strings as file paths", () => {
    createRoot((dispose) => {
      const container = document.createElement("div")
      const renderer = createStreamingRenderer(container, { onFileClick: () => {} })
      renderer.write("Using version 1.2.3/4.5")
      renderer.end()
      const link = container.querySelector("[data-file-path]")
      expect(link).toBeNull()
      dispose()
    })
  })

  // Matches paths starting with /, ./, or project patterns
  it("matches paths starting with ./ or /", () => {
    createRoot((dispose) => {
      const container = document.createElement("div")
      const renderer = createStreamingRenderer(container, { onFileClick: () => {} })
      renderer.write("Edit ./src/index.ts")
      renderer.end()
      const link = container.querySelector("[data-file-path]")
      expect(link).not.toBeNull()
      expect(link?.textContent).toBe("./src/index.ts")
      dispose()
    })
  })

  // I12: Sanitize javascript: URIs
  it("sanitizes javascript: URIs in links", () => {
    createRoot((dispose) => {
      const container = document.createElement("div")
      const renderer = createStreamingRenderer(container)
      renderer.write("[click](javascript:alert(1))")
      renderer.end()
      const links = container.querySelectorAll("a[href]")
      for (const link of links) {
        const href = link.getAttribute("href") ?? ""
        expect(href).not.toMatch(/^javascript:/i)
      }
      dispose()
    })
  })

  // I12: Sanitize data: URIs
  it("sanitizes data: URIs in links", () => {
    createRoot((dispose) => {
      const container = document.createElement("div")
      const renderer = createStreamingRenderer(container)
      renderer.write("[click](data:text/html,<script>alert(1)</script>)")
      renderer.end()
      const links = container.querySelectorAll("a[href]")
      for (const link of links) {
        const href = link.getAttribute("href") ?? ""
        expect(href).not.toMatch(/^data:/i)
      }
      dispose()
    })
  })

  it("cleanup disposes resources", () => {
    createRoot((dispose) => {
      const container = document.createElement("div")
      const renderer = createStreamingRenderer(container)
      renderer.write("test")
      renderer.cleanup()
      expect(() => renderer.write("more")).not.toThrow()
      dispose()
    })
  })

  // Edge cases
  it("handles empty string writes", () => {
    createRoot((dispose) => {
      const container = document.createElement("div")
      const renderer = createStreamingRenderer(container)
      renderer.write("")
      renderer.write("")
      renderer.end()
      dispose()
    })
  })

  it("renders inline code", () => {
    createRoot((dispose) => {
      const container = document.createElement("div")
      const renderer = createStreamingRenderer(container)
      renderer.write("Use `foo()` here")
      renderer.end()
      expect(container.querySelector("code")).not.toBeNull()
      dispose()
    })
  })

  it("normalizes consecutive inline code lines into one code block", () => {
    createRoot((dispose) => {
      const container = document.createElement("div")
      const renderer = createStreamingRenderer(container)
      renderer.write(["`{`", "`\"mcp\": {`", "`  \"strobe\": {`", "`  }`", "`}`"].join("\n"))
      renderer.end()
      expect(container.querySelectorAll("p code").length).toBe(0)
      const pre = container.querySelector("pre")
      expect(pre).not.toBeNull()
      expect(pre?.textContent).toContain('"mcp": {')
      dispose()
    })
  })

  it("renders ordered and unordered lists", () => {
    createRoot((dispose) => {
      const container = document.createElement("div")
      const renderer = createStreamingRenderer(container)
      renderer.write("- item 1\n- item 2\n")
      renderer.end()
      expect(container.querySelector("ul")).not.toBeNull()
      dispose()
    })
  })
})
