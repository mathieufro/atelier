import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises"
import { join, dirname } from "node:path"
import { tmpdir } from "node:os"
import { execSync } from "node:child_process"

export interface Workspace {
  path: string
  cleanup(): Promise<void>
}

export async function createWorkspace(name: string, files?: Record<string, string>): Promise<Workspace> {
  const dir = await mkdtemp(join(tmpdir(), `atelier-e2e-${name}-`))
  for (const [filePath, content] of Object.entries(files ?? {})) {
    const full = join(dir, filePath)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, content)
  }
  execSync("git init && git config user.email 'test@test' && git config user.name 'test' && git add -A && git commit -m 'init' --allow-empty", { cwd: dir, stdio: "ignore" })
  return { path: dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}
