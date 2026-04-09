import * as fs from "node:fs"
import * as path from "node:path"

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "as", "for", "to", "in", "on", "of",
  "with", "is", "it", "my", "me", "i", "we", "our", "this", "that",
])

/**
 * Generate a task slug from a user prompt (fallback when compiler doesn't provide one).
 * Takes first ~5 meaningful words, kebab-case.
 */
export function generateTaskSlug(prompt: string): string {
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter(w => w.length > 0 && !STOP_WORDS.has(w))
    .slice(0, 5)

  const slug = words.join("-") || "pipeline"
  return slug.slice(0, 60)
}

/**
 * Generate a short readable title from a user message.
 * Takes the first line, strips markdown, truncates to ~60 chars on a word boundary.
 */
export function generateSessionTitle(message: string): string {
  // Take first non-empty line
  const firstLine = message.split("\n").map(l => l.trim()).find(l => l.length > 0)
  if (!firstLine) return "Chat"

  // Strip markdown formatting
  const cleaned = firstLine
    .replace(/^#+\s*/, "")          // heading markers
    .replace(/[*_~`]/g, "")         // bold/italic/strike/code
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links → text
    .trim()

  if (!cleaned) return "Chat"
  if (cleaned.length <= 60) return cleaned

  // Truncate on word boundary
  const truncated = cleaned.slice(0, 60).replace(/\s+\S*$/, "")
  return (truncated || cleaned.slice(0, 60)) + "…"
}

/**
 * Resolve a unique pipeline directory path.
 * If `baseDir` already exists on disk, appends -2, -3, etc.
 */
export function resolveUniquePipelineDir(workspacePath: string, baseDir: string): string {
  if (!fs.existsSync(path.resolve(workspacePath, baseDir))) return baseDir

  for (let i = 2; i <= 99; i++) {
    const candidate = `${baseDir}-${i}`
    if (!fs.existsSync(path.resolve(workspacePath, candidate))) return candidate
  }
  // Extremely unlikely fallback
  return `${baseDir}-${Date.now()}`
}
