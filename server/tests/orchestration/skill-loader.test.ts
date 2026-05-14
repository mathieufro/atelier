import { describe, it, expect } from "vitest"
import { loadSkill, loadSkillCatalog, resolveSkillForStage, STAGE_SKILLS, SIGNAL_FOOTER } from "../../src/orchestration/skill-loader.js"
import * as path from "node:path"
import * as fs from "node:fs"
import * as os from "node:os"

const SKILLS_DIR = path.resolve(import.meta.dirname, "../../../skills")

describe("loadSkill", () => {
  it("loads brainstorming-feature skill from disk", async () => {
    const content = await loadSkill("brainstorming-feature", SKILLS_DIR)
    expect(content).toContain("# Feature Brainstorming")
  })

  it("loads compiling-plan skill from disk", async () => {
    const content = await loadSkill("compiling-plan", SKILLS_DIR)
    expect(content).toContain("# Compiling")
  })

  it("strips YAML frontmatter", async () => {
    const content = await loadSkill("brainstorming-feature", SKILLS_DIR)
    expect(content).not.toMatch(/^---\n/)
    expect(content).not.toContain("stage: brainstorm")
    expect(content).toContain("# Feature Brainstorming")
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
    expect(names).toContain("brainstorming-feature")
    expect(names).toContain("implementing-plans")
    expect(names).toContain("bugfixing")
  })

  it("returns correct metadata for brainstorming-feature skill", async () => {
    const catalog = await loadSkillCatalog(SKILLS_DIR)
    const brainstorm = catalog.find((s) => s.name === "brainstorming-feature")
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
    expect(STAGE_SKILLS.compile_brainstorm).toBe("compiling-brainstorm")
    expect(STAGE_SKILLS.compile_plan).toBe("compiling-plan")
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

  it("does not include polymorphic brainstorm stages (use resolveSkillForStage)", () => {
    expect(STAGE_SKILLS.brainstorm).toBeUndefined()
    expect(STAGE_SKILLS.brainstorm_roadmap).toBeUndefined()
  })

  it("maps compile stages to the new split compile skills", () => {
    expect(STAGE_SKILLS.compile_brainstorm).toBe("compiling-brainstorm")
    expect(STAGE_SKILLS.compile_roadmap_brainstorm).toBe("compiling-brainstorm")
    expect(STAGE_SKILLS.compile_task_brainstorm).toBe("compiling-brainstorm")
    expect(STAGE_SKILLS.compile_plan).toBe("compiling-plan")
    expect(STAGE_SKILLS.compile_e2e_plan).toBe("compiling-plan")
  })
})

describe("resolveSkillForStage", () => {
  it("resolves brainstorm to brainstorming-feature for feature pipelines", () => {
    expect(resolveSkillForStage("brainstorm", "feature")).toBe("brainstorming-feature")
  })

  it("resolves brainstorm to brainstorming-epic for epic pipelines", () => {
    expect(resolveSkillForStage("brainstorm", "epic")).toBe("brainstorming-epic")
  })

  it("resolves brainstorm_roadmap to brainstorming-roadmap regardless of pipelineType", () => {
    expect(resolveSkillForStage("brainstorm_roadmap", "epic")).toBe("brainstorming-roadmap")
    expect(resolveSkillForStage("brainstorm_roadmap", "feature")).toBe("brainstorming-roadmap")
  })

  it("falls through to STAGE_SKILLS for non-brainstorm stages", () => {
    expect(resolveSkillForStage("write_plan", "feature")).toBe("writing-plans")
    expect(resolveSkillForStage("implement", "feature")).toBe("implementing-plans")
    expect(resolveSkillForStage("review_spec", "epic")).toBe("reviewing-specs")
  })

  it("returns undefined for unknown stages", () => {
    expect(resolveSkillForStage("nonexistent_stage", "feature")).toBeUndefined()
  })
})

describe("brainstorming skill split", () => {
  it("brainstorming-feature exists with stage: brainstorm", async () => {
    const catalog = await loadSkillCatalog(SKILLS_DIR)
    const skill = catalog.find((s) => s.name === "brainstorming-feature")
    expect(skill).toBeDefined()
    expect(skill?.stage).toBe("brainstorm")
  })

  it("brainstorming-epic exists with stage: brainstorm", async () => {
    const catalog = await loadSkillCatalog(SKILLS_DIR)
    const skill = catalog.find((s) => s.name === "brainstorming-epic")
    expect(skill).toBeDefined()
    expect(skill?.stage).toBe("brainstorm")
  })

  it("brainstorming-roadmap exists with stage: brainstorm_roadmap", async () => {
    const catalog = await loadSkillCatalog(SKILLS_DIR)
    const skill = catalog.find((s) => s.name === "brainstorming-roadmap")
    expect(skill).toBeDefined()
    expect(skill?.stage).toBe("brainstorm_roadmap")
  })

  it("old brainstorming skill is removed", async () => {
    const catalog = await loadSkillCatalog(SKILLS_DIR)
    expect(catalog.find((s) => s.name === "brainstorming")).toBeUndefined()
  })

  it("each split brainstorming skill is loadable (frontmatter strips cleanly)", async () => {
    const feature = await loadSkill("brainstorming-feature", SKILLS_DIR)
    const epic = await loadSkill("brainstorming-epic", SKILLS_DIR)
    const roadmap = await loadSkill("brainstorming-roadmap", SKILLS_DIR)
    expect(feature).not.toMatch(/^---/)
    expect(epic).not.toMatch(/^---/)
    expect(roadmap).not.toMatch(/^---/)
    expect(feature.length).toBeGreaterThan(500)
    expect(epic.length).toBeGreaterThan(500)
    expect(roadmap.length).toBeGreaterThan(500)
  })

  it("each new brainstorming skill uses the rephrased 'your output is a document' section, not the old CRITICAL wording", async () => {
    const feature = await loadSkill("brainstorming-feature", SKILLS_DIR)
    const epic = await loadSkill("brainstorming-epic", SKILLS_DIR)
    const roadmap = await loadSkill("brainstorming-roadmap", SKILLS_DIR)
    for (const content of [feature, epic, roadmap]) {
      expect(content).toMatch(/What "your output is a document" really means/)
      expect(content).not.toMatch(/CRITICAL: Your ONLY Output Is a Document/)
    }
  })
})

describe("compiling skill split", () => {
  it("compiling-brainstorm exists", async () => {
    const catalog = await loadSkillCatalog(SKILLS_DIR)
    expect(catalog.find((s) => s.name === "compiling-brainstorm")).toBeDefined()
  })

  it("compiling-plan exists", async () => {
    const catalog = await loadSkillCatalog(SKILLS_DIR)
    expect(catalog.find((s) => s.name === "compiling-plan")).toBeDefined()
  })

  it("old compiling skill is removed", async () => {
    const catalog = await loadSkillCatalog(SKILLS_DIR)
    expect(catalog.find((s) => s.name === "compiling")).toBeUndefined()
  })

  it("compiling-brainstorm enforces a tight line cap in its content", async () => {
    const content = await loadSkill("compiling-brainstorm", SKILLS_DIR)
    expect(content).toMatch(/30\s*[-–—]\s*40\s*lines/i)
    expect(content).toMatch(/hard cap/i)
  })
})
