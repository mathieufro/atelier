import { describe, it, expect } from "vitest"
import { getWebviewContent } from "../src/webview-panel.js"

describe("getWebviewContent", () => {
  it("generates HTML with nonce", () => {
    const html = getWebviewContent(
      "fake-nonce",
      "vscode-resource://js/webview.js",
      "vscode-resource://css/webview.css",
      "vscode-resource://csp",
    )
    expect(html).toContain("fake-nonce")
    expect(html).toContain("vscode-resource://js/webview.js")
    expect(html).toContain('<div id="root">')
  })

  it("includes CSP meta tag", () => {
    const html = getWebviewContent("n", "j", "c", "csp")
    expect(html).toContain("Content-Security-Policy")
    expect(html).toContain("script-src")
  })
})
