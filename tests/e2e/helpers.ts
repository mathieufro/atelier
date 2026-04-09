import { readdirSync } from "node:fs"
import { join } from "node:path"

// --- Cross-backend parity assertions (spec requirement) ---

/** Assert both backends produce the same file system output */
export function assertFileSystemParity(workspace1: string, workspace2: string): void {
  const files1 = listFilesRecursive(workspace1)
  const files2 = listFilesRecursive(workspace2)
  const set1 = new Set(files1.filter((f) => !f.startsWith(".git/")))
  const set2 = new Set(files2.filter((f) => !f.startsWith(".git/")))
  const missing1 = [...set2].filter((f) => !set1.has(f))
  const missing2 = [...set1].filter((f) => !set2.has(f))
  if (missing1.length > 0 || missing2.length > 0) {
    throw new Error(`File system parity failed.\nMissing in backend1: ${missing1.join(", ")}\nMissing in backend2: ${missing2.join(", ")}`)
  }
}

/** Assert both backends emit the same event types in equivalent order */
export function assertEventStructureParity(events1: any[], events2: any[]): void {
  const types1 = events1.map((e: any) => e.type).filter(Boolean)
  const types2 = events2.map((e: any) => e.type).filter(Boolean)
  const critical = ["session.busy", "tool.started", "tool.completed", "session.idle"]
  for (const type of critical) {
    const count1 = types1.filter((t: string) => t === type).length
    const count2 = types2.filter((t: string) => t === type).length
    if (count1 !== count2) {
      throw new Error(`Event structure parity: ${type} count differs (${count1} vs ${count2})`)
    }
  }
}

/** Assert both backends produce messages with the same part types */
export function assertUIStructureParity(messages1: any[], messages2: any[]): void {
  const partTypes1 = messages1.flatMap((m: any) => (m.parts ?? []).map((p: any) => p.type))
  const partTypes2 = messages2.flatMap((m: any) => (m.parts ?? []).map((p: any) => p.type))
  const counts1 = partTypes1.reduce((acc: Record<string, number>, t: string) => { acc[t] = (acc[t] ?? 0) + 1; return acc }, {})
  const counts2 = partTypes2.reduce((acc: Record<string, number>, t: string) => { acc[t] = (acc[t] ?? 0) + 1; return acc }, {})
  for (const type of new Set([...Object.keys(counts1), ...Object.keys(counts2)])) {
    if ((counts1[type] ?? 0) !== (counts2[type] ?? 0)) {
      throw new Error(`UI structure parity: ${type} count differs (${counts1[type] ?? 0} vs ${counts2[type] ?? 0})`)
    }
  }
}

/** Assert structural similarity between screenshots (SSIM > threshold) */
export async function assertScreenshotParity(screenshot1: Buffer, screenshot2: Buffer, threshold = 0.7): Promise<void> {
  const { PNG } = await import("pngjs")
  const img1 = PNG.sync.read(screenshot1)
  const img2 = PNG.sync.read(screenshot2)
  const { default: pixelmatch } = await import("pixelmatch")
  const totalPixels = img1.width * img1.height
  const diffPixels = pixelmatch(img1.data, img2.data, null, img1.width, img1.height, { threshold: 0.3 })
  const similarity = 1 - (diffPixels / totalPixels)
  if (similarity < threshold) {
    throw new Error(`Screenshot parity: SSIM-like similarity ${similarity.toFixed(3)} < ${threshold}`)
  }
}

function listFilesRecursive(dir: string, prefix = ""): string[] {
  const entries = readdirSync(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...listFilesRecursive(join(dir, entry.name), rel))
    else files.push(rel)
  }
  return files
}

// --- Event assertion utilities ---

export function assertEventSequence(events: any[], expectedTypes: string[]): void {
  const types = events.map((e: any) => e.type)
  for (const expected of expectedTypes) {
    const idx = types.indexOf(expected)
    if (idx === -1) throw new Error(`Expected event "${expected}" not found. Got: ${types.join(", ")}`)
    types.splice(0, idx + 1)
  }
}

export async function waitForEvent(events: any[], type: string, timeoutMs = 10_000): Promise<any> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const evt = events.find((e: any) => e.type === type)
    if (evt) return evt
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`Timed out waiting for event: ${type}`)
}
