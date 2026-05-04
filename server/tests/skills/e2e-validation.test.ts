import { describe, it, expect } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"

const SKILL_PATH = path.resolve(import.meta.dirname, "../../../skills/e2e-validation/SKILL.md")
const SKILL = fs.readFileSync(SKILL_PATH, "utf8")

describe("e2e-validation skill", () => {
  it("mandates infrastructure first, then scenarios in plan-listed order", () => {
    expect(SKILL).toMatch(/infrastructure tasks.*before.*scenarios/i)
    expect(SKILL).toMatch(/in plan order/i)
  })

  it("documents partial signal for large E2E plans", () => {
    expect(SKILL).toMatch(/verdict.*partial/i)
    expect(SKILL).toMatch(/fresh session/i)
  })

  it("requires outputPath to be the progress file when signaling partial", () => {
    expect(SKILL).toMatch(/outputPath.*progress/i)
  })
})
