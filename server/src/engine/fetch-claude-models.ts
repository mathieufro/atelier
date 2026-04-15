// One-shot helper: calls the Claude Agent SDK's supportedModels() and prints
// the result as JSON to stdout. Run as a fresh subprocess to avoid stdio
// inheritance issues when the server is itself a child process.
//
// Usage: bun run server/src/engine/fetch-claude-models.ts
// On success: prints `{ "models": [...] }` to stdout and exits 0.
// On failure: prints `{ "error": "..." }` to stdout and exits 1.

// Strip Claude Code extension env vars so the SDK runs as an independent session
// instead of trying to attach to the extension's IPC pipe.
for (const key of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_EXECPATH", "CLAUDE_CODE_SSE_PORT"]) {
  delete process.env[key]
}
process.env.CLAUDE_CODE_AUTO_CONNECT_IDE = "0"
process.env.CLAUDE_CODE_IDE_SKIP_VALID_CHECK = "1"
process.env.CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL = "1"

import * as path from "node:path"

// Ensure the runtime executable's directory is on PATH so the Claude Agent SDK
// can resolve "bun" when spawning its CLI subprocess.
{
  const execDir = path.dirname(process.execPath)
  const currentPath = process.env.PATH ?? ""
  if (!currentPath.split(path.delimiter).includes(execDir)) {
    process.env.PATH = `${execDir}${path.delimiter}${currentPath}`
  }
}

import { query } from "@anthropic-ai/claude-agent-sdk"

/** Write JSON to stdout and wait for drain before exiting — on Windows with
 *  piped stdio, process.exit() can fire before the buffer is flushed. */
async function writeAndExit(payload: unknown, code: number): Promise<void> {
  const line = JSON.stringify(payload) + "\n"
  await new Promise<void>((resolve) => {
    const ok = process.stdout.write(line, () => resolve())
    if (ok === false) {
      process.stdout.once("drain", () => resolve())
    }
  })
  process.exit(code)
}

async function main() {
  let q: any
  try {
    q = (query as any)({ prompt: "hi", options: { maxTurns: 1 } })
    if (typeof q.supportedModels !== "function") {
      throw new Error("supportedModels not available on query object")
    }
    const models = await q.supportedModels()
    await writeAndExit({ models }, 0)
  } catch (err) {
    await writeAndExit({ error: err instanceof Error ? err.message : String(err) }, 1)
  } finally {
    try { q?.close() } catch {}
  }
}

main().catch(async (err) => {
  await writeAndExit({ error: err instanceof Error ? err.message : String(err) }, 1)
})
