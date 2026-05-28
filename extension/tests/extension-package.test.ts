import { describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

describe("extension package manifest", () => {
  const manifestPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../package.json",
  )

  it("declares workspace extension host placement for Remote SSH", () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      extensionKind?: unknown
    }

    expect(manifest.extensionKind).toEqual(["workspace"])
  })
})
