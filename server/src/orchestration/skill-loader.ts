import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { SkillInfo } from "@atelier/core"

/**
 * Reads YAML frontmatter from all SKILL.md files under the skills directory.
 * Returns a sorted list of skill metadata for autocomplete / catalog display.
 */
export async function loadSkillCatalog(skillsDir: string): Promise<SkillInfo[]> {
  let entries: string[]
  try {
    entries = await fs.readdir(skillsDir)
  } catch {
    return []
  }
  const skills: SkillInfo[] = []
  for (const entry of entries) {
    const skillPath = path.join(skillsDir, entry, "SKILL.md")
    try {
      const raw = (await fs.readFile(skillPath, "utf-8")).replace(/\r\n/g, "\n")
      const match = raw.match(/^---\n([\s\S]*?)\n---/)
      if (!match) continue
      const frontmatter = match[1]!
      const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim()
      const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim()
      const stage = frontmatter.match(/^stage:\s*(.+)$/m)?.[1]?.trim()
      if (name && description && stage) {
        skills.push({ name, description, stage })
      }
    } catch {
      // Skip directories without SKILL.md
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

// Maps pipeline stages to their skill directories under skills/.
// Compile stages (compile_brainstorm, compile_plan) use the "compiling" skill
// to read context and produce a compiled prompt — they don't run OpenCode sessions.
export const STAGE_SKILLS: Record<string, string> = {
  compile_brainstorm: "compiling",
  brainstorm: "brainstorming",
  review_spec: "reviewing-specs",
  fix_spec: "fixing-specs",
  establish_conventions: "establishing-conventions",
  compile_plan: "compiling",
  write_plan: "writing-plans",
  review_plan: "reviewing-plans",
  fix_plan: "fixing",
  implement: "implementing-plans",
  review_code: "reviewing-implementation",
  fix_code: "fixing",
  fix_hooks: "hook-fixing",
  simplify: "simplifying-implementation",
  e2e_gate: "e2e-gating",
  compile_e2e_plan: "compiling",
  write_e2e_plan: "writing-e2e-plans",
  review_e2e_plan: "reviewing-e2e-plans",
  fix_e2e_plan: "fixing",
  e2e: "e2e-validation",
  classify: "classifying",
  validate: "validating",
  compile_roadmap_brainstorm: "compiling",
  brainstorm_roadmap: "brainstorming",
  review_roadmap: "reviewing-roadmaps",
  fix_roadmap: "fixing",
  compile_task_brainstorm: "compiling",
  task_brainstorm: "task-brainstorming",
  review_task: "reviewing-task-plans",
  fix_task: "fixing",
  quick_plan: "quick-planning",
  review_quick_plan: "quick-plan-review",
  fix_quick_plan: "fixing",
  plan_gate: "plan-gate",
  bugfix: "bugfixing",
}

export const SIGNAL_FOOTER = `
## Orchestrator Integration

When you have completed your task and written your output artifact, call the \`atelier_signal\` tool with:
- \`type: "stage_complete"\` and \`outputPath\` set to the path of your output file
- For review stages, include \`verdict: "done" | "has_issues" | "stuck"\`

**Important:** The orchestrator requires \`outputPath\` to be set and the file to exist on disk. Your signal will be rejected if the artifact is missing — write the file first, then signal.

Do not call \`atelier_signal\` until your work is fully complete.

If the signal tool fails or is unavailable, state your completion in your final message and stop. The orchestrator will detect your idle state and check for the output artifact.
`

export async function loadSkill(skillName: string, skillsDir: string): Promise<string> {
  const skillPath = path.join(skillsDir, skillName, "SKILL.md")
  const raw = (await fs.readFile(skillPath, "utf-8")).replace(/\r\n/g, "\n")
  // Strip YAML frontmatter (---\n...\n---) so agents see only the markdown content
  return raw.replace(/^---\n[\s\S]*?\n---\n*/, "")
}
