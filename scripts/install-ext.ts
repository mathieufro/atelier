import * as fs from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"

const extDir = path.join(import.meta.dir, "..", "extension")
const vsix = fs.readdirSync(extDir).find((f) => f.startsWith("atelier-extension-") && f.endsWith(".vsix"))
if (!vsix) {
  console.error("No atelier-extension-*.vsix found in extension/. Run 'bun run build:vsix' first.")
  process.exit(1)
}
const vsixPath = path.join(extDir, vsix)
console.log(`Installing ${vsix}...`)
// On Windows, the VS Code CLI is `code.cmd` (the bash `code` wrapper rejects --install-extension)
const codeCmd = process.platform === "win32" ? "code.cmd" : "code"
const result = spawnSync(codeCmd, ["--install-extension", vsixPath], {
  stdio: "inherit",
  shell: true,
})
process.exit(result.status ?? 1)
