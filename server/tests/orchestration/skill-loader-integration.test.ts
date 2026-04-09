import { describe, it, expect } from "vitest"
import { loadSkill } from "../../src/orchestration/skill-loader.js"
import * as path from "node:path"

const SKILLS_DIR = path.resolve(import.meta.dirname, "../../../skills")

describe("Skill loading for new Phase 3a skills", () => {
  it("loads fixing-specs skill", async () => {
    const content = await loadSkill("fixing-specs", SKILLS_DIR)
    expect(content).toContain("Fixing Specs")
  })
})
