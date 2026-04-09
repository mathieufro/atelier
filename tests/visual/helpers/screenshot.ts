import type { Page, Locator } from "@playwright/test"
import { expect } from "@playwright/test"

export async function assertGolden(locatorOrPage: Locator | Page, name: string, opts?: { threshold?: number; maxDiffPixels?: number }) {
  const screenshot = await (locatorOrPage as any).screenshot()
  expect(screenshot).toMatchSnapshot({
    name: `${name}.png`,
    threshold: opts?.threshold ?? 0.001,
    maxDiffPixels: opts?.maxDiffPixels ?? 50,
  })
}

export async function screenshotElement(page: Page, selector: string, name: string, opts?: { threshold?: number }) {
  const el = page.locator(selector).first()
  await assertGolden(el, name, opts)
}
