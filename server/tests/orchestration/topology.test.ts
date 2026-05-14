import { describe, it, expect } from "vitest"
import {
  FEATURE_TOPOLOGY,
  EPIC_TOPOLOGY,
  PLAN_TOPOLOGY,
  TASK_TOPOLOGY,
  BUGFIX_TOPOLOGY,
  getNextStage,
  getTopology,
  CODE_PRODUCING_STAGES,
  type StageDefinition,
} from "../../src/orchestration/topology.js"
import { STAGE_TITLES, COMPILED_STAGES, extractTopicSlug, resolveStartStage } from "../../src/orchestration/helpers.js"

import { STAGE_SKILLS, loadSkill } from "../../src/orchestration/skill-loader.js"
import type { PipelineStage } from "@atelier/core"
import * as path from "node:path"

const SKILLS_DIR = path.resolve(import.meta.dirname, "../../../skills")

describe("Topology definitions", () => {
  describe("FEATURE_TOPOLOGY", () => {
    it("has the correct stage sequence", () => {
      const stages = FEATURE_TOPOLOGY.map(s => s.stage)
      expect(stages).toEqual([
        "compile_brainstorm", "brainstorm", "review_spec",
        "establish_conventions", "compile_plan", "write_plan",
        "review_plan", "implement", "review_code", "simplify",
        "e2e_gate", "compile_e2e_plan", "write_e2e_plan", "review_e2e_plan", "e2e", "validate",
      ])
    })

    it("compile stages have mode compile", () => {
      const compiles = FEATURE_TOPOLOGY.filter(s => s.stage.startsWith("compile_"))
      for (const s of compiles) {
        expect(s.mode).toBe("compile")
      }
    })

    it("brainstorm is interactive", () => {
      const brainstorm = FEATURE_TOPOLOGY.find(s => s.stage === "brainstorm")!
      expect(brainstorm.mode).toBe("interactive")
    })

    it("review stages have reviewBehavior", () => {
      const reviewSpec = FEATURE_TOPOLOGY.find(s => s.stage === "review_spec")!
      expect(reviewSpec.reviewBehavior).toBe("fixing-specs")
      const reviewPlan = FEATURE_TOPOLOGY.find(s => s.stage === "review_plan")!
      expect(reviewPlan.reviewBehavior).toBe("fixing")
      const reviewCode = FEATURE_TOPOLOGY.find(s => s.stage === "review_code")!
      expect(reviewCode.reviewBehavior).toBe("fixing")
    })

    it("establish_conventions is autonomous with no condition", () => {
      const ec = FEATURE_TOPOLOGY.find(s => s.stage === "establish_conventions")!
      expect(ec.mode).toBe("autonomous")
    })
  })

  describe("getNextStage", () => {
    it("returns the next stage", () => {
      const topology: StageDefinition[] = [
        { stage: "compile_brainstorm", mode: "compile" },
        { stage: "brainstorm", mode: "interactive", compiled: true },
      ]
      const next = getNextStage(0, topology)
      expect(next).toEqual(topology[1])
    })

    it("returns null when past end of topology", () => {
      const topology: StageDefinition[] = [
        { stage: "compile_brainstorm", mode: "compile" },
      ]
      const next = getNextStage(0, topology)
      expect(next).toBeNull()
    })

    it("returns null for empty topology", () => {
      const next = getNextStage(0, [])
      expect(next).toBeNull()
    })

    it("returns the stage at currentIndex + 1", () => {
      const topology: StageDefinition[] = [
        { stage: "brainstorm", mode: "interactive" },
        { stage: "review_spec", mode: "autonomous" },
        { stage: "compile_plan", mode: "compile" },
      ]
      const next = getNextStage(1, topology)
      expect(next?.stage).toBe("compile_plan")
    })
  })

  describe("getTopology", () => {
    it("returns FEATURE_TOPOLOGY for feature pipeline", () => {
      expect(getTopology("feature")).toBe(FEATURE_TOPOLOGY)
    })

    it("returns PLAN_TOPOLOGY for plan pipeline", () => {
      expect(getTopology("plan")).toBe(PLAN_TOPOLOGY)
    })
  })

  describe("CODE_PRODUCING_STAGES", () => {
    it("contains implement, fix_code, simplify", () => {
      expect(CODE_PRODUCING_STAGES.has("implement")).toBe(true)
      expect(CODE_PRODUCING_STAGES.has("fix_code")).toBe(true)
      expect(CODE_PRODUCING_STAGES.has("simplify")).toBe(true)
    })

    it("does not contain non-code stages", () => {
      expect(CODE_PRODUCING_STAGES.has("brainstorm")).toBe(false)
      expect(CODE_PRODUCING_STAGES.has("review_code")).toBe(false)
      expect(CODE_PRODUCING_STAGES.has("write_plan")).toBe(false)
    })
  })

  describe("fix_hooks stage mappings", () => {
    it("STAGE_TITLES includes fix_hooks", () => {
      expect(STAGE_TITLES["fix_hooks"]).toBeDefined()
    })

    it("STAGE_SKILLS maps fix_hooks to hook-fixing", () => {
      expect(STAGE_SKILLS["fix_hooks"]).toBe("hook-fixing")
    })
  })

  describe("extractTopicSlug", () => {
    it("extracts slug from standard pipeline dir", () => {
      expect(extractTopicSlug(".atelier/pipelines/2026-03-10-weather-dashboard-3266")).toBe("weather-dashboard")
    })

    it("handles multi-word slugs", () => {
      expect(extractTopicSlug(".atelier/pipelines/2026-01-01-auth-api-endpoints-a1b2")).toBe("auth-api-endpoints")
    })

    it("falls back to full dirname if pattern doesn't match", () => {
      expect(extractTopicSlug("some-other-dir")).toBe("some-other-dir")
    })
  })

  // --- Phase 4: E2E stage tests ---

  describe("PipelineStage union (Task 1)", () => {
    it("accepts compile_e2e_plan, review_e2e_plan, fix_e2e_plan as valid stages", () => {
      const a: PipelineStage = "compile_e2e_plan"
      const b: PipelineStage = "review_e2e_plan"
      const c: PipelineStage = "fix_e2e_plan"
      expect(a).toBe("compile_e2e_plan")
      expect(b).toBe("review_e2e_plan")
      expect(c).toBe("fix_e2e_plan")
    })
  })

  describe("FEATURE_TOPOLOGY E2E stages (Task 2)", () => {
    it("has exactly 15 entries", () => {
      expect(FEATURE_TOPOLOGY).toHaveLength(16)
    })

    it("e2e_gate sits between simplify and compile_e2e_plan", () => {
      const stages = FEATURE_TOPOLOGY.map(s => s.stage)
      const gateIdx = stages.indexOf("e2e_gate")
      expect(gateIdx).toBeGreaterThan(stages.indexOf("simplify"))
      expect(gateIdx).toBeLessThan(stages.indexOf("compile_e2e_plan"))
    })

    it("e2e_gate has mode autonomous and correct artifactType", () => {
      const s = FEATURE_TOPOLOGY.find(s => s.stage === "e2e_gate")!
      expect(s.mode).toBe("autonomous")
      expect(s.artifactType).toBe("e2e-gate")
    })

    it("stages 11-14 are the E2E stages in order", () => {
      const stages = FEATURE_TOPOLOGY.map(s => s.stage)
      expect(stages.slice(11, 15)).toEqual(["compile_e2e_plan", "write_e2e_plan", "review_e2e_plan", "e2e"])
    })

    it("compile_e2e_plan has mode compile and correct artifactType", () => {
      const s = FEATURE_TOPOLOGY.find(s => s.stage === "compile_e2e_plan")!
      expect(s.mode).toBe("compile")
      expect(s.artifactType).toBe("compiled-e2e-plan")
    })

    it("write_e2e_plan has mode autonomous, compiled flag, and correct artifactType", () => {
      const s = FEATURE_TOPOLOGY.find(s => s.stage === "write_e2e_plan")!
      expect(s.mode).toBe("autonomous")
      expect(s.compiled).toBe(true)
      expect(s.artifactType).toBe("e2e-plan")
    })

    it("review_e2e_plan has mode autonomous, reviewBehavior fixing, and correct artifactType", () => {
      const s = FEATURE_TOPOLOGY.find(s => s.stage === "review_e2e_plan")!
      expect(s.mode).toBe("autonomous")
      expect(s.reviewBehavior).toBe("fixing")
      expect(s.artifactType).toBe("e2e-plan-review")
    })

    it("e2e has mode autonomous and no artifactType", () => {
      const s = FEATURE_TOPOLOGY.find(s => s.stage === "e2e")!
      expect(s.mode).toBe("autonomous")
      expect(s.artifactType).toBeUndefined()
    })
  })

  describe("CODE_PRODUCING_STAGES E2E (Task 3)", () => {
    it("contains e2e", () => {
      expect(CODE_PRODUCING_STAGES.has("e2e")).toBe(true)
    })
  })

  describe("e2e_gate stage mappings", () => {
    it("STAGE_TITLES includes e2e_gate", () => {
      expect(STAGE_TITLES["e2e_gate"]).toBeDefined()
    })

    it("STAGE_SKILLS maps e2e_gate to e2e-gating", () => {
      expect(STAGE_SKILLS["e2e_gate"]).toBe("e2e-gating")
    })

    it("can load e2e-gating skill", async () => {
      const content = await loadSkill("e2e-gating", SKILLS_DIR)
      expect(content.length).toBeGreaterThan(0)
      expect(content).toContain("E2E Gate")
    })

  })

  describe("STAGE_SKILLS E2E mappings (Task 4)", () => {
    it("maps all 5 E2E stages", () => {
      expect(STAGE_SKILLS["compile_e2e_plan"]).toBe("compiling-plan")
      expect(STAGE_SKILLS["write_e2e_plan"]).toBe("writing-e2e-plans")
      expect(STAGE_SKILLS["review_e2e_plan"]).toBe("reviewing-e2e-plans")
      expect(STAGE_SKILLS["fix_e2e_plan"]).toBe("fixing")
      expect(STAGE_SKILLS["e2e"]).toBe("e2e-validation")
    })

    it("can load all 3 E2E skills", async () => {
      const names = ["writing-e2e-plans", "reviewing-e2e-plans", "e2e-validation"]
      for (const name of names) {
        const content = await loadSkill(name, SKILLS_DIR)
        expect(content.length).toBeGreaterThan(0)
      }
    })
  })

  describe("STAGE_TITLES E2E entries (Task 5b)", () => {
    it("has entries for all 5 new stages", () => {
      expect(STAGE_TITLES["compile_e2e_plan"]).toBeDefined()
      expect(STAGE_TITLES["write_e2e_plan"]).toBeDefined()
      expect(STAGE_TITLES["review_e2e_plan"]).toBeDefined()
      expect(STAGE_TITLES["fix_e2e_plan"]).toBeDefined()
      expect(STAGE_TITLES["e2e"]).toBeDefined()
    })
  })

  describe("COMPILED_STAGES E2E (Task 5c)", () => {
    it("contains write_e2e_plan", () => {
      expect(COMPILED_STAGES.has("write_e2e_plan")).toBe(true)
    })
  })

  describe("resolveStartStage E2E (Task 5d-5e)", () => {
    it("resolves fix_e2e_plan to review_e2e_plan", () => {
      expect(resolveStartStage("fix_e2e_plan")).toBe("review_e2e_plan")
    })

    it("resolves write_e2e_plan to compile_e2e_plan", () => {
      expect(resolveStartStage("write_e2e_plan")).toBe("compile_e2e_plan")
    })

    it("preserves existing behavior for brainstorm", () => {
      expect(resolveStartStage("brainstorm")).toBe("compile_brainstorm")
    })

    it("preserves existing behavior for write_plan", () => {
      expect(resolveStartStage("write_plan")).toBe("compile_plan")
    })
  })

  // --- Phase 7: Plan Mode Pipeline ---

  describe("PipelineStage union (Phase 7)", () => {
    it("accepts all new Phase 7 stages as valid PipelineStage values", () => {
      const stages: PipelineStage[] = [
        "compile_task_brainstorm",
        "task_brainstorm",
        "review_task",
        "fix_task",
        "quick_plan",
        "review_quick_plan",
        "fix_quick_plan",
        "plan_gate",
      ]
      expect(stages).toHaveLength(8)
      for (const s of stages) {
        expect(typeof s).toBe("string")
      }
    })
  })

  describe("PLAN_TOPOLOGY", () => {
    it("has the correct stage sequence", () => {
      const stages = PLAN_TOPOLOGY.map(s => s.stage)
      expect(stages).toEqual(["quick_plan", "review_quick_plan", "plan_gate"])
    })

    it("quick_plan is interactive with artifactType plan", () => {
      const qp = PLAN_TOPOLOGY.find(s => s.stage === "quick_plan")!
      expect(qp.mode).toBe("interactive")
      expect(qp.artifactType).toBe("plan")
    })

    it("review_quick_plan has reviewBehavior fixing", () => {
      const rqp = PLAN_TOPOLOGY.find(s => s.stage === "review_quick_plan")!
      expect(rqp.mode).toBe("autonomous")
      expect(rqp.reviewBehavior).toBe("fixing")
      expect(rqp.artifactType).toBe("plan-review")
    })

    it("plan_gate is interactive with no artifactType", () => {
      const pg = PLAN_TOPOLOGY.find(s => s.stage === "plan_gate")!
      expect(pg.mode).toBe("interactive")
      expect(pg.artifactType).toBeUndefined()
    })
  })

  describe("TASK_TOPOLOGY", () => {
    it("has the correct stage sequence", () => {
      const stages = TASK_TOPOLOGY.map(s => s.stage)
      expect(stages).toEqual([
        "compile_task_brainstorm", "task_brainstorm", "review_task",
        "establish_conventions", "implement", "review_code", "simplify", "validate",
      ])
    })

    it("compile_task_brainstorm has mode compile", () => {
      expect(TASK_TOPOLOGY.find(s => s.stage === "compile_task_brainstorm")!.mode).toBe("compile")
    })

    it("task_brainstorm is interactive and compiled", () => {
      const tb = TASK_TOPOLOGY.find(s => s.stage === "task_brainstorm")!
      expect(tb.mode).toBe("interactive")
      expect(tb.compiled).toBe(true)
      expect(tb.artifactType).toBe("task-spec")
    })

    it("review_task has reviewBehavior fixing", () => {
      const rt = TASK_TOPOLOGY.find(s => s.stage === "review_task")!
      expect(rt.reviewBehavior).toBe("fixing")
      expect(rt.artifactType).toBe("task-review")
    })
  })

  describe("BUGFIX_TOPOLOGY", () => {
    it("has a single bugfix stage", () => {
      const stages = BUGFIX_TOPOLOGY.map(s => s.stage)
      expect(stages).toEqual(["bugfix"])
    })

    it("bugfix is autonomous with artifactType diagnostic", () => {
      const bf = BUGFIX_TOPOLOGY[0]!
      expect(bf.mode).toBe("autonomous")
      expect(bf.artifactType).toBe("diagnostic")
    })
  })

  describe("getTopology (Phase 7)", () => {
    it("returns TASK_TOPOLOGY for task", () => {
      expect(getTopology("task")).toBe(TASK_TOPOLOGY)
    })

    it("returns BUGFIX_TOPOLOGY for bugfix", () => {
      expect(getTopology("bugfix")).toBe(BUGFIX_TOPOLOGY)
    })

    it("still returns FEATURE_TOPOLOGY for feature", () => {
      expect(getTopology("feature")).toBe(FEATURE_TOPOLOGY)
    })

    it("still returns EPIC_TOPOLOGY for epic", () => {
      expect(getTopology("epic")).toBe(EPIC_TOPOLOGY)
    })
  })

  describe("CODE_PRODUCING_STAGES (Phase 7)", () => {
    it("contains bugfix", () => {
      expect(CODE_PRODUCING_STAGES.has("bugfix")).toBe(true)
    })
  })


  describe("STAGE_TITLES (Phase 7)", () => {
    it("has entries for all new Phase 7 stages", () => {
      const newStages = [
        "compile_task_brainstorm", "task_brainstorm", "review_task", "fix_task",
        "quick_plan", "review_quick_plan", "fix_quick_plan", "plan_gate", "bugfix",
      ]
      for (const stage of newStages) {
        expect(STAGE_TITLES[stage]).toBeDefined()
      }
    })
  })

  describe("FIXER_TO_REVIEW (Phase 7)", () => {
    it("resolves fix_task to review_task", () => {
      expect(resolveStartStage("fix_task")).toBe("review_task")
    })

    it("resolves fix_quick_plan to review_quick_plan", () => {
      expect(resolveStartStage("fix_quick_plan")).toBe("review_quick_plan")
    })
  })

  describe("COMPILED_STAGES (Phase 7)", () => {
    it("contains task_brainstorm", () => {
      expect(COMPILED_STAGES.has("task_brainstorm")).toBe(true)
    })

    it("does not contain quick_plan (not compiled)", () => {
      expect(COMPILED_STAGES.has("quick_plan")).toBe(false)
    })
  })

  describe("COMPILED_TO_COMPILE (Phase 7)", () => {
    it("resolves task_brainstorm to compile_task_brainstorm", () => {
      expect(resolveStartStage("task_brainstorm")).toBe("compile_task_brainstorm")
    })
  })

  describe("STAGE_SKILLS (Phase 7)", () => {
    it("maps all new Phase 7 stages to correct skill directories", () => {
      expect(STAGE_SKILLS["compile_task_brainstorm"]).toBe("compiling-brainstorm")
      expect(STAGE_SKILLS["task_brainstorm"]).toBe("task-brainstorming")
      expect(STAGE_SKILLS["review_task"]).toBe("reviewing-task-plans")
      expect(STAGE_SKILLS["fix_task"]).toBe("fixing")
      expect(STAGE_SKILLS["quick_plan"]).toBe("quick-planning")
      expect(STAGE_SKILLS["review_quick_plan"]).toBe("quick-plan-review")
      expect(STAGE_SKILLS["fix_quick_plan"]).toBe("fixing")
      expect(STAGE_SKILLS["plan_gate"]).toBe("plan-gate")
      expect(STAGE_SKILLS["bugfix"]).toBe("bugfixing")
    })
  })

  describe("Phase 7 skills", () => {
    it("can load all five new skills", async () => {
      const names = ["task-brainstorming", "reviewing-task-plans", "quick-planning", "quick-plan-review", "plan-gate"]
      for (const name of names) {
        const content = await loadSkill(name, SKILLS_DIR)
        expect(content.length).toBeGreaterThan(100)
      }
    })

    it("task-brainstorming skill mentions spec-plan hybrid", async () => {
      const content = await loadSkill("task-brainstorming", SKILLS_DIR)
      expect(content).toContain("spec-plan hybrid")
    })

    it("quick-planning skill mentions TDD", async () => {
      const content = await loadSkill("quick-planning", SKILLS_DIR)
      expect(content).toContain("TDD")
    })

    it("plan-gate skill mentions Execute Plan and Done", async () => {
      const content = await loadSkill("plan-gate", SKILLS_DIR)
      expect(content).toContain("Execute Plan")
      expect(content).toContain("Done")
    })

    it("quick-plan-review skill mentions goal compliance", async () => {
      const content = await loadSkill("quick-plan-review", SKILLS_DIR)
      expect(content.toLowerCase()).toContain("goal compliance")
    })
  })

  describe("Updated skills (Phase 7)", () => {
    it("classifying skill mentions task and bugfix detection heuristics", async () => {
      const content = await loadSkill("classifying", SKILLS_DIR)
      expect(content.toLowerCase()).toContain("task")
      expect(content.toLowerCase()).toContain("bugfix")
    })

    it("bugfixing skill mentions outcome signaling", async () => {
      const content = await loadSkill("bugfixing", SKILLS_DIR)
      expect(content).toContain("outcome")
      expect(content).toContain("fixed_unverified")
    })
  })

  describe("writing-e2e-plans skill strengthening (Task 15)", () => {
    it("contains assertion depth rule and real-usage grounding", async () => {
      const content = await loadSkill("writing-e2e-plans", SKILLS_DIR)
      expect(content).toContain("Assertion depth rule")
      expect(content).toContain("Real-usage grounding")
    })
  })

  describe("Topology — validate stage configuration", () => {
    it.each([
      ["FEATURE_TOPOLOGY", FEATURE_TOPOLOGY],
      ["EPIC_TOPOLOGY", EPIC_TOPOLOGY],
      ["TASK_TOPOLOGY", TASK_TOPOLOGY],
    ])("%s has validate as autonomous mode", (_name, topology) => {
      const validate = topology.find(s => s.stage === "validate")
      expect(validate).toBeDefined()
      expect(validate!.mode).toBe("autonomous")
    })

    it("FEATURE_TOPOLOGY validate has artifactType 'validation' without requiresArtifact", () => {
      const validate = FEATURE_TOPOLOGY.find(s => s.stage === "validate")!
      expect(validate.artifactType).toBe("validation")
      expect(validate.requiresArtifact).toBeUndefined()
    })

    it("CODE_PRODUCING_STAGES includes validate", () => {
      expect(CODE_PRODUCING_STAGES.has("validate")).toBe(true)
    })
  })
})
