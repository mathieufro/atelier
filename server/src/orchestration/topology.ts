import type { PipelineStage, PipelineType } from "@atelier/core"
import type { IdleDetectorStagePolicyOverride } from "./idle-detector-config.js"

export interface StageDefinition {
  stage: PipelineStage
  mode: "compile" | "autonomous" | "interactive"
  reviewBehavior?: string  // fixer skill name on has_issues
  compiled?: boolean       // uses compiled prompt from preceding compile stage
  artifactType?: string    // suffix for step numbering
  requiresArtifact?: boolean  // signal must include outputPath + file must exist on disk
  detectorOverride?: Partial<IdleDetectorStagePolicyOverride>
}

export const FEATURE_TOPOLOGY: StageDefinition[] = [
  { stage: "compile_brainstorm", mode: "compile", artifactType: "compiled-brainstorm" },
  { stage: "brainstorm", mode: "interactive", compiled: true, artifactType: "spec", requiresArtifact: true },
  { stage: "review_spec", mode: "autonomous", reviewBehavior: "fixing-specs", artifactType: "spec-review", requiresArtifact: true },
  { stage: "establish_conventions", mode: "autonomous", artifactType: "conventions", requiresArtifact: true },
  { stage: "compile_plan", mode: "compile", artifactType: "compiled-plan" },
  { stage: "write_plan", mode: "autonomous", compiled: true, artifactType: "plan", requiresArtifact: true },
  { stage: "review_plan", mode: "autonomous", reviewBehavior: "fixing", artifactType: "plan-review", requiresArtifact: true },
  { stage: "implement", mode: "autonomous" },
  { stage: "review_code", mode: "autonomous", reviewBehavior: "fixing", artifactType: "code-review", requiresArtifact: true },
  { stage: "simplify", mode: "autonomous", artifactType: "simplify", requiresArtifact: true },
  { stage: "e2e_gate", mode: "autonomous", artifactType: "e2e-gate", requiresArtifact: true },
  { stage: "compile_e2e_plan", mode: "compile", artifactType: "compiled-e2e-plan" },
  { stage: "write_e2e_plan", mode: "autonomous", compiled: true, artifactType: "e2e-plan", requiresArtifact: true },
  { stage: "review_e2e_plan", mode: "autonomous", reviewBehavior: "fixing", artifactType: "e2e-plan-review", requiresArtifact: true },
  { stage: "e2e", mode: "autonomous" },
  { stage: "validate", mode: "autonomous", artifactType: "validation" },
]
export const EPIC_TOPOLOGY: StageDefinition[] = [
  { stage: "compile_brainstorm", mode: "compile", artifactType: "compiled-brainstorm" },
  { stage: "brainstorm", mode: "interactive", compiled: true, artifactType: "spec", requiresArtifact: true },
  { stage: "review_spec", mode: "autonomous", reviewBehavior: "fixing-specs", artifactType: "spec-review", requiresArtifact: true },
  { stage: "establish_conventions", mode: "autonomous", artifactType: "conventions", requiresArtifact: true },
  { stage: "compile_roadmap_brainstorm", mode: "compile", artifactType: "compiled-roadmap-brainstorm" },
  { stage: "brainstorm_roadmap", mode: "interactive", compiled: true, artifactType: "roadmap", requiresArtifact: true },
  { stage: "review_roadmap", mode: "autonomous", reviewBehavior: "fixing", artifactType: "roadmap-review", requiresArtifact: true },
  { stage: "validate", mode: "autonomous", artifactType: "validation" },
]

export const TASK_TOPOLOGY: StageDefinition[] = [
  { stage: "compile_task_brainstorm", mode: "compile", artifactType: "compiled-task-brainstorm" },
  { stage: "task_brainstorm", mode: "interactive", compiled: true, artifactType: "task-spec", requiresArtifact: true },
  { stage: "review_task", mode: "autonomous", reviewBehavior: "fixing", artifactType: "task-review", requiresArtifact: true },
  { stage: "establish_conventions", mode: "autonomous", artifactType: "conventions", requiresArtifact: true },
  { stage: "implement", mode: "autonomous" },
  { stage: "review_code", mode: "autonomous", reviewBehavior: "fixing", artifactType: "code-review", requiresArtifact: true },
  { stage: "simplify", mode: "autonomous", artifactType: "simplify", requiresArtifact: true },
  { stage: "validate", mode: "autonomous", artifactType: "validation" },
]

export const PLAN_TOPOLOGY: StageDefinition[] = [
  { stage: "quick_plan", mode: "interactive", artifactType: "plan", requiresArtifact: true },
  { stage: "review_quick_plan", mode: "autonomous", reviewBehavior: "fixing", artifactType: "plan-review", requiresArtifact: true },
  { stage: "plan_gate", mode: "interactive" },
]

export const BUGFIX_TOPOLOGY: StageDefinition[] = [
  { stage: "bugfix", mode: "autonomous", artifactType: "diagnostic" },
]

export function getTopology(pipelineType: PipelineType): StageDefinition[] {
  switch (pipelineType) {
    case "plan": return PLAN_TOPOLOGY
    case "task": return TASK_TOPOLOGY
    case "bugfix": return BUGFIX_TOPOLOGY
    case "epic": return EPIC_TOPOLOGY
    default: return FEATURE_TOPOLOGY
  }
}

/** Stages that produce code and trigger a git commit after completion. */
export const CODE_PRODUCING_STAGES = new Set<string>([
  "implement",
  "fix_code",
  "simplify",
  "e2e",
  "bugfix",
  "validate",
])

export function getNextStage(
  currentIndex: number,
  topology: StageDefinition[],
): StageDefinition | null {
  const next = currentIndex + 1
  return next < topology.length ? topology[next]! : null
}
