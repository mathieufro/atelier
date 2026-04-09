/**
 * File Context Interaction E2E Tests
 *
 * Tests the full file context pipeline: inject → render → toggle → send → augment.
 * These are interaction-focused tests distinct from the static golden states in input-bar.spec.ts.
 */
import { test, expect } from "@playwright/test"
import { injectConfig, injectSessions, injectActiveSession, waitForRender } from "../helpers/inject.js"
import { makeSession } from "../helpers/factories.js"

const HARNESS = "/tests/visual/harness/"

async function setup(page: any) {
  await page.goto(HARNESS)
  await page.waitForTimeout(500)
  await injectConfig(page, { workspacePath: "/tmp", models: [], agents: [] })
  const session = makeSession("s1")
  await injectSessions(page, [session])
  await injectActiveSession(page, "s1")
  await waitForRender(page)
}

async function injectFileContext(
  page: any,
  ctx: { path: string; relativePath: string; startLine?: number; endLine?: number },
) {
  await page.evaluate((c: any) => (window as any).__injectMessage({ type: "activeFileContext", ...c }), ctx)
  await waitForRender(page)
}

test.describe("File Context Interaction", () => {
  // ─── Smoke Test ───────────────────────────────────────────────────────────────

  test("smoke: file context inject → toggle → send", async ({ page }) => {
    await setup(page)
    await injectFileContext(page, {
      path: "/workspace/src/index.ts",
      relativePath: "src/index.ts",
      startLine: 1,
      endLine: 10,
    })

    const pill = page.locator("[data-testid='file-context-pill']")
    await expect(pill).toBeVisible()
    await expect(pill).toContainText("index.ts:1-10")

    // Toggle off
    await pill.click()
    await waitForRender(page)
    await expect(pill).toHaveClass(/line-through/)

    // Toggle back on
    await pill.click()
    await waitForRender(page)
    await expect(pill).not.toHaveClass(/line-through/)

    // Send message and check outbox
    await page.locator("textarea").focus()
    await page.keyboard.type("Hello")
    await page.keyboard.press("Enter")
    await waitForRender(page)

    const outbox = await page.evaluate(() => (window as any).__testOutbox)
    const sent = outbox.find((m: any) => m.type === "sendMessage" || m.content?.includes("[context:"))
    expect(sent).toBeTruthy()
  })

  // ─── Scenario 1: Inject file context → pill appears with correct label ────────

  test("Scenario 1: inject file context → pill appears with correct label", async ({ page }) => {
    await setup(page)

    // No pill before injection
    await expect(page.locator("[data-testid='file-context-pill']")).toHaveCount(0)

    await injectFileContext(page, {
      path: "/workspace/src/utils/parser.ts",
      relativePath: "src/utils/parser.ts",
      startLine: 42,
      endLine: 58,
    })

    const pill = page.locator("[data-testid='file-context-pill']")
    await expect(pill).toBeVisible()
    await expect(pill).toContainText("parser.ts:42-58")
    await expect(pill).toHaveClass(/text-vsc-link/)

    const title = await pill.getAttribute("title")
    expect(title).toContain("src/utils/parser.ts")
  })

  // ─── Scenario 2: Toggle pill off and on ──────────────────────────────────────

  test("Scenario 2: toggle pill off and on + state persistence", async ({ page }) => {
    await setup(page)
    await injectFileContext(page, {
      path: "/workspace/src/App.tsx",
      relativePath: "src/App.tsx",
      startLine: 1,
      endLine: 5,
    })

    const pill = page.locator("[data-testid='file-context-pill']")
    await expect(pill).toBeVisible()

    // Toggle off
    await pill.click()
    await waitForRender(page)
    await expect(pill).toHaveClass(/line-through/)
    await expect(pill).not.toHaveClass(/text-vsc-link/)
    let state = await page.evaluate(() => (window as any).__testState)
    expect(state.fileContextEnabled).toBe(false)

    // Toggle back on
    await pill.click()
    await waitForRender(page)
    await expect(pill).toHaveClass(/text-vsc-link/)
    await expect(pill).not.toHaveClass(/line-through/)
    state = await page.evaluate(() => (window as any).__testState)
    expect(state.fileContextEnabled).toBe(true)
  })

  // ─── Scenario 3: Send with context enabled → augmented content ───────────────

  test("Scenario 3: send message with context enabled → augmented content in outbox", async ({ page }) => {
    await setup(page)
    await injectFileContext(page, {
      path: "/workspace/src/components/App.tsx",
      relativePath: "src/components/App.tsx",
      startLine: 12,
      endLine: 25,
    })

    // Pill enabled by default
    const pill = page.locator("[data-testid='file-context-pill']")
    await expect(pill).toBeVisible()
    await expect(pill).not.toHaveClass(/line-through/)

    await page.locator("textarea").focus()
    await page.keyboard.type("Refactor this component")
    await page.keyboard.press("Enter")
    await waitForRender(page)

    const outbox = await page.evaluate(() => (window as any).__testOutbox)
    const sent = outbox.find((m: any) => m.type === "sendMessage")
    expect(sent).toBeTruthy()
    expect(sent.content).toMatch(/^\[context: src\/components\/App\.tsx:12-25\]\n/)
    expect(sent.content).toContain("Refactor this component")
  })

  // ─── Scenario 4: Send with context disabled → no prefix ──────────────────────

  test("Scenario 4: send message with context disabled → no prefix", async ({ page }) => {
    await setup(page)
    await injectFileContext(page, {
      path: "/workspace/src/utils/util.ts",
      relativePath: "src/utils/util.ts",
      startLine: 1,
      endLine: 20,
    })

    // Disable the pill
    const pill = page.locator("[data-testid='file-context-pill']")
    await pill.click()
    await waitForRender(page)
    await expect(pill).toHaveClass(/line-through/)

    await page.locator("textarea").focus()
    await page.keyboard.type("Fix the bug")
    await page.keyboard.press("Enter")
    await waitForRender(page)

    const outbox = await page.evaluate(() => (window as any).__testOutbox)
    // No message should carry a [context: ...] prefix
    const withContext = outbox.find((m: any) => m.content?.includes("[context:"))
    expect(withContext).toBeUndefined()
    // The plain message should be sent as-is
    const plain = outbox.find((m: any) => m.type === "sendMessage")
    expect(plain).toBeTruthy()
    expect(plain.content).toBe("Fix the bug")
  })

  // ─── Scenario 5: Switch files → pill updates label ───────────────────────────

  test("Scenario 5: switch files → pill updates label", async ({ page }) => {
    await setup(page)

    // First file: multi-line selection
    await injectFileContext(page, {
      path: "/workspace/src/components/App.tsx",
      relativePath: "src/components/App.tsx",
      startLine: 12,
      endLine: 25,
    })
    await expect(page.locator("[data-testid='file-context-pill']")).toContainText("App.tsx:12-25")

    // Second file: single-line selection
    await injectFileContext(page, {
      path: "/workspace/tests/utils.test.ts",
      relativePath: "tests/utils.test.ts",
      startLine: 5,
      endLine: 5,
    })
    await expect(page.locator("[data-testid='file-context-pill']")).toContainText("utils.test.ts:5")

    // Third file: no line selection
    await injectFileContext(page, {
      path: "/workspace/README.md",
      relativePath: "README.md",
    })
    const pill = page.locator("[data-testid='file-context-pill']")
    await expect(pill).toContainText("README.md")
    const label = await pill.textContent()
    expect(label).not.toMatch(/README\.md:\d/)
  })

  // ─── Scenario 6: Context goes null → pill disappears ─────────────────────────

  test("Scenario 6: context goes null → pill disappears", async ({ page }) => {
    await setup(page)
    await injectFileContext(page, {
      path: "/workspace/src/App.tsx",
      relativePath: "src/App.tsx",
    })
    await expect(page.locator("[data-testid='file-context-pill']")).toBeVisible()

    await page.evaluate(() => (window as any).__injectMessage({ type: "activeFileContext", path: null }))
    await waitForRender(page)

    await expect(page.locator("[data-testid='file-context-pill']")).toHaveCount(0)
  })

  // ─── Scenario 7: Toggle persistence across webview reload ────────────────────

  test("Scenario 7: toggle persistence across webview reload", async ({ page }) => {
    await setup(page)
    await injectFileContext(page, {
      path: "/workspace/src/App.tsx",
      relativePath: "src/App.tsx",
      startLine: 1,
      endLine: 5,
    })

    // Default: pill is enabled
    const pill = page.locator("[data-testid='file-context-pill']")
    await expect(pill).not.toHaveClass(/line-through/)

    // Toggle off and capture persisted state
    await pill.click()
    await waitForRender(page)
    const savedState = await page.evaluate(() => (window as any).__testState)
    expect(savedState.fileContextEnabled).toBe(false)

    // Simulate webview reload with saved state.
    // Patch the shim so it preserves window.__testState if already set by addInitScript,
    // then seed the state before navigation.
    await page.route("**/vscode-shim.js", async (route: any) => {
      const response = await route.fetch()
      const body = await response.text()
      const modified = body.replace(
        "window.__testState = {};",
        "window.__testState = window.__testState || {};",
      )
      await route.fulfill({ response, body: modified })
    })
    await page.addInitScript(() => {
      ;(window as any).__testState = { fileContextEnabled: false }
    })

    await page.goto(HARNESS)
    await page.waitForTimeout(500)
    await injectConfig(page, { workspacePath: "/tmp", models: [], agents: [] })
    await injectSessions(page, [makeSession("s1")])
    await injectActiveSession(page, "s1")
    await injectFileContext(page, {
      path: "/workspace/src/App.tsx",
      relativePath: "src/App.tsx",
      startLine: 1,
      endLine: 5,
    })

    // Pill should render disabled — state was restored from getState() on mount
    const reloadedPill = page.locator("[data-testid='file-context-pill']")
    await expect(reloadedPill).toBeVisible()
    await expect(reloadedPill).toHaveClass(/line-through/)
    await expect(reloadedPill).not.toHaveClass(/text-vsc-link/)
  })

  // ─── Visual Goldens (interaction-driven) ─────────────────────────────────────

  test("visual: file-context-after-file-switch", async ({ page }) => {
    await setup(page)
    // Start on one file, then switch to another — verify label updates without rendering artifacts
    await injectFileContext(page, {
      path: "/workspace/src/components/App.tsx",
      relativePath: "src/components/App.tsx",
      startLine: 12,
      endLine: 25,
    })
    await injectFileContext(page, {
      path: "/workspace/src/utils/parser.ts",
      relativePath: "src/utils/parser.ts",
      startLine: 1,
      endLine: 20,
    })
    await expect(page.locator("#root")).toHaveScreenshot("file-context-after-file-switch.png", {
      maxDiffPixels: 100,
    })
  })

  test("visual: file-context-toggle-roundtrip", async ({ page }) => {
    await setup(page)
    await injectFileContext(page, {
      path: "/workspace/src/App.tsx",
      relativePath: "src/App.tsx",
      startLine: 1,
      endLine: 10,
    })
    const pill = page.locator("[data-testid='file-context-pill']")
    // Toggle off then back on — verify no CSS state leakage
    await pill.click()
    await waitForRender(page)
    await pill.click()
    await waitForRender(page)
    await expect(page.locator("#root")).toHaveScreenshot("file-context-toggle-roundtrip.png", {
      maxDiffPixels: 100,
    })
  })
})
