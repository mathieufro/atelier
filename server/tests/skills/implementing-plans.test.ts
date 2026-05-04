import { describe, it, expect } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"

const SKILL_PATH = path.resolve(import.meta.dirname, "../../../skills/implementing-plans/SKILL.md")
const SKILL = fs.readFileSync(SKILL_PATH, "utf8")

describe("implementing-plans skill", () => {
  it("mandates strict in-plan-order execution", () => {
    expect(SKILL).toMatch(/in plan order/i)
    expect(SKILL).toMatch(/no prioriti[sz]ation/i)
  })

  it("documents the partial signal as the expected path for large plans", () => {
    expect(SKILL).toMatch(/verdict.*partial/i)
    expect(SKILL).toMatch(/fresh session/i)
    expect(SKILL).toMatch(/no penalty/i)
  })

  it("requires outputPath to be the progress file when signaling partial", () => {
    expect(SKILL).toMatch(/outputPath.*progress/i)
  })

  it("forbids skipping ahead to later tasks when blocked", () => {
    expect(SKILL).toMatch(/do not (skip|jump) (ahead|to)/i)
  })
})
