// Automated test for Atelier's Claude Code backend, running in a safely isolated
// VS Code instance that mirrors the user's real profile (extensions + claude state).
//
// SAFETY:
//   - Snapshots all currently running Code.exe PIDs BEFORE launching.
//   - Only kills PIDs that weren't running before (i.e., only this test's window).
//   - Uses a timestamped temp profile, never touches ~/.vscode.
//
// Flags:
//   --skip-build         skip extension rebuild/reinstall
//   --real-profile       mirror user's extensions and settings (default: true)
//   --keep-open          don't kill the isolated window at end
//   --loop               rebuild and re-run on failure (until user hits Ctrl+C)

import { spawn, spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const ATELIER_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname.slice(1)), "..")
const LOG_PATH = path.join(os.tmpdir(), "atelier", "logs", "050729eb7d16", "atelier.log")
const HELPER_LOG = path.join(os.tmpdir(), "atelier-helper.log")
const PID_FILE = path.join(os.homedir(), ".atelier", "050729eb7d16", "atelier.pid")
const USER_EXT_DIR = path.join(os.homedir(), ".vscode", "extensions")
const CODE_CMD = process.env.CODE_CMD || "C:\\Users\\Etienne\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd"

function step(m) { console.log(`\n▶ ${m}`) }
function ok(m)   { console.log(`  ✓ ${m}`) }
function fail(m) { console.log(`  ✗ ${m}`) }
function info(m) { console.log(`    ${m}`) }

function getCodePids() {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-Command", "(Get-Process Code -ErrorAction SilentlyContinue).Id -join ','"], { encoding: "utf8" })
  const ids = (r.stdout || "").trim().split(",").map(s => parseInt(s, 10)).filter(n => n > 0)
  return new Set(ids)
}

function killPid(pid) {
  try { spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" }) } catch {}
}

function killAllExcept(protectedPids) {
  const current = getCodePids()
  for (const pid of current) {
    if (!protectedPids.has(pid)) {
      info(`killing spawned Code.exe pid ${pid}`)
      killPid(pid)
    }
  }
}

function clearAtelierLogs() {
  try { fs.unlinkSync(LOG_PATH) } catch {}
  try { fs.unlinkSync(HELPER_LOG) } catch {}
  try { fs.unlinkSync(PID_FILE) } catch {}
}

function rebuildAndPackage() {
  step("Rebuilding extension")
  for (const task of ["typecheck", "build:ext", "build:vsix"]) {
    const r = spawnSync("bun", ["run", task], { cwd: ATELIER_DIR, stdio: "inherit" })
    if (r.status !== 0) throw new Error(`${task} failed`)
  }
  ok("VSIX packaged")
}

function findVsix() {
  const extDir = path.join(ATELIER_DIR, "extension")
  const vsix = fs.readdirSync(extDir).find((f) => f.startsWith("atelier-extension-") && f.endsWith(".vsix"))
  if (!vsix) throw new Error("No atelier-extension-*.vsix found")
  return path.join(extDir, vsix)
}

function prepareIsolatedProfile(realProfile) {
  const stamp = Date.now()
  const root = path.join(os.tmpdir(), `atelier-autotest-${stamp}`)
  const userData = path.join(root, "user-data")
  const extensions = path.join(root, "extensions")
  fs.mkdirSync(userData, { recursive: true })
  fs.mkdirSync(extensions, { recursive: true })

  if (realProfile && fs.existsSync(USER_EXT_DIR)) {
    step("Mirroring user's extensions into isolated profile")
    const r = spawnSync("powershell.exe", ["-NoProfile", "-Command",
      `Copy-Item -Recurse -Force -Path "${USER_EXT_DIR}\\*" -Destination "${extensions}" -ErrorAction SilentlyContinue`], { stdio: "ignore" })
    const count = fs.readdirSync(extensions).filter(n => !n.endsWith(".json")).length
    ok(`Mirrored ${count} extensions`)
  }

  return { root, userData, extensions }
}

async function waitForLogEvent(predicate, timeoutMs = 30000, pollMs = 150) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const lines = fs.readFileSync(LOG_PATH, "utf-8").trim().split("\n").filter(Boolean)
      for (const line of lines) {
        try {
          const entry = JSON.parse(line)
          if (predicate(entry)) return entry
        } catch {}
      }
    } catch {}
    await new Promise((r) => setTimeout(r, pollMs))
  }
  return null
}

async function runOnce(skipBuild, realProfile) {
  if (!skipBuild) {
    rebuildAndPackage()
  }

  const protectedPids = getCodePids()
  step(`Protected user VS Code PIDs: [${[...protectedPids].join(", ")}]`)

  clearAtelierLogs()
  const profile = prepareIsolatedProfile(realProfile)

  step("Installing extension into isolated profile")
  const vsix = findVsix()
  const installR = spawnSync(`"${CODE_CMD}"`, [
    "--user-data-dir", `"${profile.userData}"`,
    "--extensions-dir", `"${profile.extensions}"`,
    "--install-extension", `"${vsix}"`,
    "--force",
  ], { stdio: ["ignore", "pipe", "pipe"], shell: true, encoding: "utf8" })
  if (installR.status !== 0) {
    fail(`Install failed: ${installR.stdout}${installR.stderr}`)
    return { pass: false, reason: "install_failed" }
  }
  ok("Extension installed")

  step("Launching isolated VS Code with user's profile mirrored")
  spawn(`"${CODE_CMD}"`, [
    "--user-data-dir", `"${profile.userData}"`,
    "--extensions-dir", `"${profile.extensions}"`,
    "--new-window",
    "--disable-workspace-trust",
    `"${ATELIER_DIR}"`,
  ], {
    env: { ...process.env, ATELIER_AUTO_OPEN_PANEL: "1" },
    stdio: "ignore",
    shell: true,
  }).unref()

  step("Waiting for server_started (60s — many extensions take longer)")
  const started = await waitForLogEvent((e) => e.action === "server_started", 60000)
  if (!started) {
    fail("server did not start")
    killAllExcept(protectedPids)
    return { pass: false, reason: "server_didnt_start" }
  }
  ok(`server on port ${started.data?.port}`)

  step("Waiting for config_models_aggregated (25s)")
  const aggregated = await waitForLogEvent((e) => e.action === "config_models_aggregated", 25000)

  const modelCount = aggregated?.data?.modelCount ?? -1
  if (modelCount > 0) {
    ok(`PASS — modelCount=${modelCount}`)
    killAllExcept(protectedPids)
    return { pass: true, modelCount }
  }

  fail(`FAIL — modelCount=${modelCount}`)
  step("Diagnostics")
  // Helper log
  try {
    const helperLog = fs.readFileSync(HELPER_LOG, "utf-8")
    const lastBlock = helperLog.trim().split("\n").slice(-30).join("\n")
    console.log("\n--- Helper log (last 30 lines) ---")
    console.log(lastBlock)
  } catch { console.log("(helper log missing)") }
  // Server log (look for supportedModels_failed)
  try {
    const lines = fs.readFileSync(LOG_PATH, "utf-8").trim().split("\n")
    const failures = lines.filter(l => l.includes("supportedModels_failed")).slice(-3)
    console.log("\n--- supportedModels_failed entries ---")
    for (const f of failures) console.log(f)
  } catch {}

  killAllExcept(protectedPids)
  return { pass: false, reason: "no_models", modelCount }
}

async function main() {
  const skipBuild = process.argv.includes("--skip-build")
  const realProfile = !process.argv.includes("--no-real-profile")
  const loop = process.argv.includes("--loop")

  let attempt = 0
  while (true) {
    attempt++
    console.log(`\n════════════════ Attempt ${attempt} ════════════════`)
    const result = await runOnce(skipBuild && attempt === 1 ? true : false, realProfile)
    if (result.pass) {
      console.log(`\n✓✓✓ Passed on attempt ${attempt} — ${result.modelCount} models`)
      process.exit(0)
    }
    if (!loop) {
      console.log(`\n✗ Failed — stopping (pass --loop to retry)`)
      process.exit(1)
    }
    console.log(`\n…retrying in 2s with fresh rebuild`)
    await new Promise(r => setTimeout(r, 2000))
  }
}

main().catch((err) => { console.error("autotest error:", err); process.exit(1) })
