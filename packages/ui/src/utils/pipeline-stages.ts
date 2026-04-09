/**
 * UI-side pipeline topology data.
 *
 * Mirrors the server's topology.ts but only includes user-configurable stages
 * (classify is excluded). Individual compile_* stages are collapsed into a
 * single virtual "compile" entry — the server resolves it for all compile stages.
 */

/** Human-readable labels for every pipeline stage. */
export const STAGE_LABELS: Record<string, string> = {
  // Feature / shared
  brainstorm: "Brainstorm",
  review_spec: "Review Spec",
  fix_spec: "Fix Spec",
  establish_conventions: "Conventions",
  write_plan: "Write Plan",
  review_plan: "Review Plan",
  fix_plan: "Fix Plan",
  implement: "Implement",
  review_code: "Code Review",
  fix_code: "Fix Code",
  simplify: "Simplify",
  e2e_gate: "E2E Gate",
  write_e2e_plan: "E2E Plan",
  review_e2e_plan: "Review E2E",
  fix_e2e_plan: "Fix E2E Plan",
  e2e: "E2E Tests",
  validate: "Validate",
  // Task
  task_brainstorm: "Task Brainstorm",
  review_task: "Review Task",
  fix_task: "Fix Task",
  // Epic
  brainstorm_roadmap: "Roadmap",
  review_roadmap: "Review Roadmap",
  fix_roadmap: "Fix Roadmap",
  // Plan
  quick_plan: "Quick Plan",
  review_quick_plan: "Review Plan",
  fix_quick_plan: "Fix Plan",
  plan_gate: "Plan Gate",
  // Bugfix
  bugfix: "Bugfix",
  // Virtual compile group (single picker entry for all compile_* stages)
  compile: "Compile",
  // Compile stages (header label only)
  compile_brainstorm: "Compiling Brainstorm",
  compile_plan: "Compiling Plan",
  compile_task_brainstorm: "Compiling Task",
  compile_e2e_plan: "Compiling E2E",
  compile_roadmap_brainstorm: "Compiling Roadmap",
  // Classify
  classify: "Classifying",
  fix_hooks: "Fix Hooks",
}

/**
 * User-configurable stages per pipeline type.
 * Excludes classify. A single virtual "compile" entry covers all compile_* stages.
 * Includes dynamically-inserted fix stages after their corresponding review stages
 * so users can pre-configure models.
 */
export const PIPELINE_TOPOLOGIES: Record<string, string[]> = {
  feature: [
    "compile",
    "brainstorm",
    "review_spec", "fix_spec",
    "establish_conventions",
    "write_plan",
    "review_plan", "fix_plan",
    "implement",
    "review_code", "fix_code",
    "simplify",
    "e2e_gate",
    "write_e2e_plan",
    "review_e2e_plan", "fix_e2e_plan",
    "e2e",
    "validate",
  ],
  task: [
    "compile",
    "task_brainstorm",
    "review_task", "fix_task",
    "establish_conventions",
    "implement",
    "review_code", "fix_code",
    "simplify",
    "validate",
  ],
  epic: [
    "compile",
    "brainstorm",
    "review_spec", "fix_spec",
    "establish_conventions",
    "brainstorm_roadmap",
    "review_roadmap", "fix_roadmap",
    "validate",
  ],
  plan: ["quick_plan", "review_quick_plan", "fix_quick_plan", "plan_gate"],
  bugfix: ["bugfix"],
}

/** Get the list of configurable stages for a pipeline type. */
export function getTopologyForType(pipelineType: string): Array<{ stage: string; label: string }> {
  const stages = PIPELINE_TOPOLOGIES[pipelineType] ?? PIPELINE_TOPOLOGIES["feature"]!
  return stages.map(stage => ({
    stage,
    label: STAGE_LABELS[stage] ?? stage.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
  }))
}
