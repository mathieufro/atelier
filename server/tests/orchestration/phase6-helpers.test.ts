import { describe, it, expect } from "vitest"
import { resolveSkillForStage, STAGE_SKILLS } from "../../src/orchestration/skill-loader.js"
import { STAGE_TITLES, COMPILED_STAGES, resolveStartStage } from "../../src/orchestration/helpers.js"
import { loadSkill } from "../../src/orchestration/skill-loader.js"
import { getTopology, FEATURE_TOPOLOGY, EPIC_TOPOLOGY } from "../../src/orchestration/topology.js"
import * as path from "node:path"

const SKILLS_DIR = path.resolve(import.meta.dirname, "../../../skills")

describe("STAGE_SKILLS: Phase 6 entries", () => {
  it("maps classify to classifying", () => { expect(STAGE_SKILLS.classify).toBe("classifying") })
  it("maps validate to validating", () => { expect(STAGE_SKILLS.validate).toBe("validating") })
  it("maps compile_roadmap_brainstorm to compiling-brainstorm", () => { expect(STAGE_SKILLS.compile_roadmap_brainstorm).toBe("compiling-brainstorm") })
  it("resolves brainstorm_roadmap to brainstorming-roadmap", () => { expect(resolveSkillForStage("brainstorm_roadmap", "epic")).toBe("brainstorming-roadmap") })
  it("maps review_roadmap to reviewing-roadmaps", () => { expect(STAGE_SKILLS.review_roadmap).toBe("reviewing-roadmaps") })
  it("maps fix_roadmap to fixing", () => { expect(STAGE_SKILLS.fix_roadmap).toBe("fixing") })
})

describe("Phase 6 helpers", () => {
  it("STAGE_TITLES has entries for new stages", () => {
    expect(STAGE_TITLES.classify).toBeDefined()
    expect(STAGE_TITLES.validate).toBeDefined()
    expect(STAGE_TITLES.compile_roadmap_brainstorm).toBeDefined()
    expect(STAGE_TITLES.brainstorm_roadmap).toBeDefined()
    expect(STAGE_TITLES.review_roadmap).toBeDefined()
    expect(STAGE_TITLES.fix_roadmap).toBeDefined()
  })

  it("COMPILED_STAGES includes brainstorm_roadmap", () => {
    expect(COMPILED_STAGES.has("brainstorm_roadmap")).toBe(true)
  })

  it("resolveStartStage maps fix_roadmap to review_roadmap", () => {
    expect(resolveStartStage("fix_roadmap")).toBe("review_roadmap")
  })

  it("resolveStartStage maps brainstorm_roadmap to compile_roadmap_brainstorm", () => {
    expect(resolveStartStage("brainstorm_roadmap")).toBe("compile_roadmap_brainstorm")
  })
})

describe("Phase 6 skills", () => {
  it("loads classifying skill", async () => {
    const content = await loadSkill("classifying", SKILLS_DIR)
    expect(content).toContain("Classification")
    expect(content).not.toContain("---")
  })

  it("loads validating skill", async () => {
    const content = await loadSkill("validating", SKILLS_DIR)
    expect(content).toContain("Validation")
    expect(content).not.toContain("---")
  })
})

describe("Phase 6 topology", () => {
  it("getTopology('epic') returns EPIC_TOPOLOGY", () => {
    expect(getTopology("epic")).toBe(EPIC_TOPOLOGY)
  })

  it("EPIC_TOPOLOGY has 8 stages", () => {
    expect(EPIC_TOPOLOGY).toHaveLength(8)
  })

  it("EPIC_TOPOLOGY starts with compile_brainstorm and ends with validate", () => {
    expect(EPIC_TOPOLOGY[0]!.stage).toBe("compile_brainstorm")
    expect(EPIC_TOPOLOGY[EPIC_TOPOLOGY.length - 1]!.stage).toBe("validate")
  })

  it("EPIC_TOPOLOGY includes roadmap stages", () => {
    const stages = EPIC_TOPOLOGY.map(s => s.stage)
    expect(stages).toContain("compile_roadmap_brainstorm")
    expect(stages).toContain("brainstorm_roadmap")
    expect(stages).toContain("review_roadmap")
  })

  it("EPIC_TOPOLOGY review_roadmap has reviewBehavior fixing", () => {
    const reviewRoadmap = EPIC_TOPOLOGY.find(s => s.stage === "review_roadmap")
    expect(reviewRoadmap?.reviewBehavior).toBe("fixing")
  })

  it("FEATURE_TOPOLOGY ends with validate", () => {
    expect(FEATURE_TOPOLOGY[FEATURE_TOPOLOGY.length - 1]!.stage).toBe("validate")
  })

  it("FEATURE_TOPOLOGY validate is autonomous", () => {
    const validate = FEATURE_TOPOLOGY.find(s => s.stage === "validate")
    expect(validate?.mode).toBe("autonomous")
  })

  it("getTopology('feature') still returns FEATURE_TOPOLOGY", () => {
    expect(getTopology("feature")).toBe(FEATURE_TOPOLOGY)
  })
})
