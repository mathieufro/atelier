import type { Message, UserMessage, Mode, PermissionRuleset } from "./types.js"

export function isUserMessage(msg: Message): msg is UserMessage {
  return msg.role === "user"
}

export function formatDuration(
  startMs: number,
  endMs: number | undefined,
): string {
  if (endMs === undefined) return ""
  const diff = endMs - startMs
  if (diff <= 0) return "0ms"
  if (diff < 1000) return `${Math.round(diff)}ms`
  if (diff < 60000) return `${(diff / 1000).toFixed(1)}s`
  return `${(diff / 60000).toFixed(1)}m`
}

export function modeToPermissionRuleset(mode: Mode): PermissionRuleset {
  switch (mode) {
    case "build":
    case "feature":
    case "bugfix":
      return [{ permission: "*", pattern: "*", action: "allow" }]
    case "plan":
      return [
        { permission: "bash", pattern: "*", action: "deny" },
        { permission: "edit", pattern: "*", action: "deny" },
        { permission: "write", pattern: "*", action: "deny" },
      ]
  }
}

/**
 * Map a permission ruleset back to the closest matching Mode.
 *
 * This mapping is lossy: `"feature"` mode shares the same allow-all ruleset as
 * `"build"` mode, so a ruleset produced by `modeToPermissionRuleset("feature")`
 * will round-trip back as `"build"`.
 */
export function permissionRulesetToMode(ruleset: PermissionRuleset | undefined): Mode {
  if (!ruleset || ruleset.length === 0) return "build"
  const PLAN_PERMS = new Set(["bash", "edit", "write"])
  if (
    ruleset.length === 3 &&
    ruleset.every((r) => r.action === "deny" && PLAN_PERMS.has(r.permission))
  ) return "plan"
  return "build"
}
