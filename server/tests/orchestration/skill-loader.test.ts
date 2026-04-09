import { describe, it, expect } from "vitest"
import { loadSkill, loadSkillCatalog, STAGE_SKILLS, SIGNAL_FOOTER } from "../../src/orchestration/skill-loader.js"
import * as path from "node:path"
import * as fs from "node:fs"
import * as os from "node:os"

const SKILLS_DIR = path.resolve(import.meta.dirname, "../../../skills")

describe("loadSkill", () => {
  it("loads brainstorming skill from disk", async () => {
    const content = await loadSkill("brainstorming", SKILLS_DIR)
    expect(content).toContain("# Brainstorming")
    expect(content).toContain("You are guiding a brainstorm session")
  })

  it("loads compiling skill from disk", async () => {
    const content = await loadSkill("compiling", SKILLS_DIR)
    expect(content).toContain("# Compiling")
  })

  it("strips YAML frontmatter", async () => {
    const content = await loadSkill("brainstorming", SKILLS_DIR)
    expect(content).not.toMatch(/^---\n/)
    expect(content).not.toContain("stage: brainstorm")
    expect(content).toContain("# Brainstorming")
  })

  it("throws for non-existent skill", async () => {
    await expect(loadSkill("nonexistent", SKILLS_DIR)).rejects.toThrow()
  })
})

describe("SIGNAL_FOOTER", () => {
  it("contains atelier_signal instruction", () => {
    expect(SIGNAL_FOOTER).toContain("atelier_signal")
    expect(SIGNAL_FOOTER).toContain("stage_complete")
  })

  it("mentions verdict parameter", () => {
    expect(SIGNAL_FOOTER).toContain("verdict")
  })

  it("does not mention stage_blocked", () => {
    expect(SIGNAL_FOOTER).not.toContain("stage_blocked")
  })

  it("contains fallback instruction for when signal tool fails", () => {
    expect(SIGNAL_FOOTER).toContain("signal tool fails")
    expect(SIGNAL_FOOTER).toContain("state your completion")
  })
})

describe("loadSkillCatalog", () => {
  it("loads all skills from disk with name, description, and stage", async () => {
    const catalog = await loadSkillCatalog(SKILLS_DIR)
    expect(catalog.length).toBeGreaterThanOrEqual(15)
    for (const skill of catalog) {
      expect(skill.name).toBeTruthy()
      expect(skill.description).toBeTruthy()
      expect(skill.stage).toBeTruthy()
    }
  })

  it("returns skills sorted by name", async () => {
    const catalog = await loadSkillCatalog(SKILLS_DIR)
    const names = catalog.map((s) => s.name)
    expect(names).toEqual([...names].sort())
  })

  it("includes known skills", async () => {
    const catalog = await loadSkillCatalog(SKILLS_DIR)
    const names = catalog.map((s) => s.name)
    expect(names).toContain("brainstorming")
    expect(names).toContain("implementing-plans")
    expect(names).toContain("bugfixing")
  })

  it("returns correct metadata for brainstorming skill", async () => {
    const catalog = await loadSkillCatalog(SKILLS_DIR)
    const brainstorm = catalog.find((s) => s.name === "brainstorming")
    expect(brainstorm).toBeDefined()
    expect(brainstorm!.stage).toBe("brainstorm")
    expect(brainstorm!.description).toContain("brainstorm")
  })

  it("returns empty array for non-existent directory", async () => {
    const catalog = await loadSkillCatalog("/nonexistent/path")
    expect(catalog).toEqual([])
  })

  it("skips directories without SKILL.md", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-test-"))
    try {
      fs.mkdirSync(path.join(tmpDir, "valid"))
      fs.writeFileSync(path.join(tmpDir, "valid", "SKILL.md"), "---\nname: test-skill\ndescription: A test\nstage: on-demand\n---\n# Test")
      fs.mkdirSync(path.join(tmpDir, "no-skill"))
      const catalog = await loadSkillCatalog(tmpDir)
      expect(catalog).toHaveLength(1)
      expect(catalog[0].name).toBe("test-skill")
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("skips SKILL.md files with incomplete frontmatter", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-test-"))
    try {
      fs.mkdirSync(path.join(tmpDir, "incomplete"))
      fs.writeFileSync(path.join(tmpDir, "incomplete", "SKILL.md"), "---\nname: missing-desc\nstage: on-demand\n---\n# No description")
      const catalog = await loadSkillCatalog(tmpDir)
      expect(catalog).toHaveLength(0)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe("STAGE_SKILLS", () => {
  it("maps original pipeline stages to skill names", () => {
    expect(STAGE_SKILLS.compile_brainstorm).toBe("compiling")
    expect(STAGE_SKILLS.brainstorm).toBe("brainstorming")
    expect(STAGE_SKILLS.compile_plan).toBe("compiling")
    expect(STAGE_SKILLS.write_plan).toBe("writing-plans")
    expect(STAGE_SKILLS.implement).toBe("implementing-plans")
  })

  it("maps all Phase 3a stages to skills", () => {
    expect(STAGE_SKILLS["review_spec"]).toBe("reviewing-specs")
    expect(STAGE_SKILLS["fix_spec"]).toBe("fixing-specs")
    expect(STAGE_SKILLS["establish_conventions"]).toBe("establishing-conventions")
    expect(STAGE_SKILLS["review_plan"]).toBe("reviewing-plans")
    expect(STAGE_SKILLS["fix_plan"]).toBe("fixing")
    expect(STAGE_SKILLS["review_code"]).toBe("reviewing-implementation")
    expect(STAGE_SKILLS["fix_code"]).toBe("fixing")
    expect(STAGE_SKILLS["simplify"]).toBe("simplifying-implementation")
  })
})
