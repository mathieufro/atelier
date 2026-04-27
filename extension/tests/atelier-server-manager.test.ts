import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { parseOrphanOpencodePids, parseOrphanClaudeSdkPids, AtelierServerManager, resolveRuntime, setSpawnSyncRunnerForTests } from "../src/atelier-server-manager"
import { type ProcessInfo } from "@atelier/core/process-platform"
import { atelierStateDir } from "@atelier/core/state-dir"
import * as processPlatform from "@atelier/core/process-platform"
import * as childProcess from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { EventEmitter } from "node:events"

function createMockChild(pid = 12345): childProcess.ChildProcess {
  const proc = new EventEmitter() as childProcess.ChildProcess
  ;(proc as any).pid = pid
  ;(proc as any).exitCode = null
  ;(proc as any).stdin = { end: vi.fn() }
  ;(proc as any).stdout = new EventEmitter()
  ;(proc as any).stderr = new EventEmitter()
  return proc
}

function normalizeWindowsPathEntries(entries: string[]): string[] {
  return entries.map((entry) => entry.toLowerCase())
}

describe("parseOrphanOpencodePids", () => {
  const originalPlatform = process.platform
  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "linux" })
  })
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform })
  })

  it("returns PIDs of orphaned opencode serve processes (Unix: ppid=1)", () => {
    const procs: ProcessInfo[] = [
      { pid: 15787, ppid: 1, command: "opencode serve --hostname=127.0.0.1 --port=0" },
      { pid: 15796, ppid: 1, command: "opencode serve --hostname=127.0.0.1 --port=0" },
      { pid: 20800, ppid: 15796, command: "opencode serve --hostname=127.0.0.1 --port=0" },
      { pid: 12345, ppid: 1, command: "opencode serve --hostname=0.0.0.0 --port=4096" },
      { pid: 99999, ppid: 1, command: "node /tmp/foo.js" },
    ]

    expect(parseOrphanOpencodePids(procs)).toEqual([15787, 15796])
  })

  it("returns empty array for no matching processes", () => {
    const procs: ProcessInfo[] = [
      { pid: 99999, ppid: 1, command: "node /tmp/foo.js" },
    ]
    expect(parseOrphanOpencodePids(procs)).toEqual([])
  })

  it("returns empty array for empty input", () => {
    expect(parseOrphanOpencodePids([])).toEqual([])
  })
})

describe("parseOrphanClaudeSdkPids", () => {
  const originalPlatform = process.platform
  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "linux" })
  })
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform })
  })

  it("returns PIDs of orphaned claude-agent-sdk processes (Unix: ppid=1)", () => {
    const procs: ProcessInfo[] = [
      { pid: 100, ppid: 1, command: "node /path/to/@anthropic-ai/claude-agent-sdk/cli.js" },
      { pid: 200, ppid: 1, command: "node /path/to/claude-agent-sdk/cli.js" },
      { pid: 300, ppid: 500, command: "node /path/to/@anthropic-ai/claude-agent-sdk/cli.js" },
      { pid: 400, ppid: 1, command: "node /tmp/other.js" },
    ]

    expect(parseOrphanClaudeSdkPids(procs)).toEqual([100, 200])
  })

  it("returns empty array for no matching processes", () => {
    expect(parseOrphanClaudeSdkPids([])).toEqual([])
  })
})

describe("orphan detection — Windows path", () => {
  // On Windows, orphans are detected by checking if the parent PID is dead (!isAlive(ppid)),
  // not by checking ppid === 1. These tests stub only the platform property to exercise that
  // branch while keeping process.kill intact for isAlive() calls.
  const originalPlatform = process.platform

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform })
  })

  it("parseOrphanOpencodePids detects orphans with dead parent on Windows", () => {
    Object.defineProperty(process, "platform", { value: "win32" })

    const procs: ProcessInfo[] = [
      // ppid 999_999 is (almost certainly) dead — orphan
      { pid: 100, ppid: 999_999, command: "opencode serve --hostname=127.0.0.1 --port=0" },
      // ppid is the current process — alive, not an orphan
      { pid: 200, ppid: process.pid, command: "opencode serve --hostname=127.0.0.1 --port=0" },
    ]

    expect(parseOrphanOpencodePids(procs)).toEqual([100])
  })

  it("parseOrphanOpencodePids matches full Windows CommandLine paths", () => {
    Object.defineProperty(process, "platform", { value: "win32" })

    const procs: ProcessInfo[] = [
      // Windows CommandLine includes the full executable path
      { pid: 100, ppid: 999_999, command: "C:\\Users\\user\\.opencode\\bin\\opencode.exe serve --hostname=127.0.0.1 --port=0" },
      // Different hostname — should NOT match
      { pid: 200, ppid: 999_999, command: "C:\\Users\\user\\.opencode\\bin\\opencode.exe serve --hostname=0.0.0.0 --port=4096" },
    ]

    expect(parseOrphanOpencodePids(procs)).toEqual([100])
  })

  it("parseOrphanClaudeSdkPids detects orphans with dead parent on Windows", () => {
    Object.defineProperty(process, "platform", { value: "win32" })

    const procs: ProcessInfo[] = [
      { pid: 300, ppid: 999_999, command: "node C:\\path\\to\\@anthropic-ai\\claude-agent-sdk\\cli.js" },
      { pid: 400, ppid: process.pid, command: "node C:\\path\\to\\@anthropic-ai\\claude-agent-sdk\\cli.js" },
    ]

    expect(parseOrphanClaudeSdkPids(procs)).toEqual([300])
  })
})

describe("AtelierServerManager.stop() — Windows path", () => {
  const originalPlatform = process.platform
  let manager: AtelierServerManager

  beforeEach(() => {
    manager = new AtelierServerManager()
    // Set the manager into "running" state with a mock process
    const mgr = manager as any
    mgr._state = "running"
    mgr._atelierUrl = "http://127.0.0.1:9999"
    mgr.proc = { pid: 12345 }
  })

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform })
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("on Windows: HTTP shutdown succeeds and process exits within 2s — returns early without terminateProcessTree", async () => {
    Object.defineProperty(process, "platform", { value: "win32" })
    const terminateSpy = vi.spyOn(processPlatform, "terminateProcessTree").mockResolvedValue(undefined)
    const waitForExitSpy = vi.spyOn(processPlatform, "waitForExit").mockResolvedValue(true)
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal("fetch", fetchSpy)

    await manager.stop()

    expect(fetchSpy).toHaveBeenCalledWith("http://127.0.0.1:9999/shutdown", { method: "POST" })
    expect(waitForExitSpy).toHaveBeenCalledWith(12345, 5000)
    // terminateProcessTree should NOT be called — graceful shutdown succeeded
    expect(terminateSpy).not.toHaveBeenCalled()
    expect(manager.state).toBe("stopped")
  })

  it("on Windows: HTTP shutdown succeeds but process does not exit — falls through to terminateProcessTree", async () => {
    Object.defineProperty(process, "platform", { value: "win32" })
    const terminateSpy = vi.spyOn(processPlatform, "terminateProcessTree").mockResolvedValue(undefined)
    const waitForExitSpy = vi.spyOn(processPlatform, "waitForExit").mockResolvedValue(false)
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal("fetch", fetchSpy)

    await manager.stop()

    expect(fetchSpy).toHaveBeenCalledWith("http://127.0.0.1:9999/shutdown", { method: "POST" })
    expect(waitForExitSpy).toHaveBeenCalledWith(12345, 5000)
    // Process didn't exit — terminateProcessTree should be called as fallback
    expect(terminateSpy).toHaveBeenCalledWith(12345)
    expect(manager.state).toBe("stopped")
  })

  it("on Windows: HTTP shutdown fails (network error) — falls through to terminateProcessTree", async () => {
    Object.defineProperty(process, "platform", { value: "win32" })
    const terminateSpy = vi.spyOn(processPlatform, "terminateProcessTree").mockResolvedValue(undefined)
    const fetchSpy = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"))
    vi.stubGlobal("fetch", fetchSpy)

    await manager.stop()

    expect(fetchSpy).toHaveBeenCalledWith("http://127.0.0.1:9999/shutdown", { method: "POST" })
    // Fetch failed — terminateProcessTree should be called directly
    expect(terminateSpy).toHaveBeenCalledWith(12345)
    expect(manager.state).toBe("stopped")
  })

  it("on Unix: does not attempt HTTP shutdown, calls terminateProcessTree directly", async () => {
    // Keep platform as-is (not win32 in CI)
    Object.defineProperty(process, "platform", { value: "linux" })
    const terminateSpy = vi.spyOn(processPlatform, "terminateProcessTree").mockResolvedValue(undefined)
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)

    await manager.stop()

    // No HTTP shutdown attempt on Unix
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(terminateSpy).toHaveBeenCalledWith(12345)
    expect(manager.state).toBe("stopped")
  })
})

describe("resolveRuntime", () => {
  const originalPlatform = process.platform

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform })
  })

  it("resolves bun.exe from PATH before falling back to guessed install directories", () => {
    Object.defineProperty(process, "platform", { value: "win32" })

    const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-runtime-"))
    const fakeBun = path.join(fakeDir, "bun.EXE")
    fs.writeFileSync(fakeBun, "")

    try {
      expect(resolveRuntime("bun", {
        PATH: fakeDir,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      })).toBe(fakeBun)
    } finally {
      fs.rmSync(fakeDir, { recursive: true, force: true })
    }
  })

  it("resolves bun.exe from Scoop and npm fallback directories on Windows", () => {
    Object.defineProperty(process, "platform", { value: "win32" })

    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-runtime-home-"))
    const fakeAppData = path.join(fakeHome, "AppData", "Roaming")
    const runtime = "atelier-bun"
    const scoopShim = path.join(fakeHome, "scoop", "shims", `${runtime}.exe`)
    const npmBun = path.join(fakeAppData, "npm", `${runtime}.exe`)
    fs.mkdirSync(path.dirname(scoopShim), { recursive: true })
    fs.mkdirSync(path.dirname(npmBun), { recursive: true })
    fs.writeFileSync(scoopShim, "")
    fs.writeFileSync(npmBun, "")

    try {
      expect(resolveRuntime(runtime, {
        PATH: "",
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        USERPROFILE: fakeHome,
        APPDATA: fakeAppData,
      })).toBe(scoopShim)

      fs.rmSync(scoopShim, { force: true })

      expect(resolveRuntime(runtime, {
        PATH: "",
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        USERPROFILE: fakeHome,
        APPDATA: fakeAppData,
      })).toBe(npmBun)
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true })
    }
  })
})

describe("AtelierServerManager.start()", () => {
  const originalPlatform = process.platform
  const originalPath = process.env.PATH
  const originalBunInstall = process.env.BUN_INSTALL
  let workspaceDir: string
  let pathDir: string
  let fallbackRoot: string
  let manager: AtelierServerManager

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-workspace-"))
    pathDir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-path-"))
    fallbackRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-fallback-"))
    manager = new AtelierServerManager()
  })

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform })
    process.env.PATH = originalPath
    if (originalBunInstall === undefined) delete process.env.BUN_INSTALL
    else process.env.BUN_INSTALL = originalBunInstall
    setSpawnSyncRunnerForTests(null)
    try { fs.rmSync(workspaceDir, { recursive: true, force: true }) } catch {}
    try { fs.rmSync(pathDir, { recursive: true, force: true }) } catch {}
    try { fs.rmSync(fallbackRoot, { recursive: true, force: true }) } catch {}
    try { fs.rmSync(atelierStateDir(workspaceDir), { recursive: true, force: true }) } catch {}
    vi.restoreAllMocks()
  })

  it("prefers the original PATH runtime over guessed directories during start on Windows", async () => {
    Object.defineProperty(process, "platform", { value: "win32" })

    const pathBun = path.join(pathDir, "bun.EXE")
    const fallbackBun = path.join(fallbackRoot, "bin", "bun.EXE")
    fs.writeFileSync(pathBun, "")
    fs.mkdirSync(path.dirname(fallbackBun), { recursive: true })
    fs.writeFileSync(fallbackBun, "")

    process.env.PATH = pathDir
    process.env.BUN_INSTALL = fallbackRoot

    vi.spyOn(manager as any, "killOrphanProcesses").mockResolvedValue(undefined)
    vi.spyOn(manager as any, "killStaleProcess").mockResolvedValue(undefined)
    vi.spyOn(manager as any, "waitForPidFile").mockResolvedValue("http://127.0.0.1:7777")
    vi.spyOn(manager as any, "pollHealth").mockResolvedValue(undefined)

    const child = createMockChild()
    const spawnSpy = vi.spyOn(manager as any, "spawnProcess").mockReturnValue(child)

    await manager.start({ cwd: workspaceDir })

    expect(spawnSpy).toHaveBeenCalled()
    expect(spawnSpy.mock.calls[0]![0]).toBe(pathBun)
    expect(spawnSpy.mock.calls[0]![2]).toMatchObject({
      cwd: workspaceDir,
      shell: false,
      windowsHide: true,
    })
  })

  it("resolves the Windows runtime after merging registry PATH entries", async () => {
    Object.defineProperty(process, "platform", { value: "win32" })

    const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-registry-path-"))
    const registryBun = path.join(registryDir, "bun.EXE")
    fs.writeFileSync(registryBun, "")
    process.env.PATH = ""
    delete process.env.BUN_INSTALL

    const regSpy = vi.fn().mockImplementation((command, args) => {
      const key = args?.[1]
      if (String(command).toLowerCase().endsWith("reg.exe") && key === "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment") {
        return {
          status: 0,
          stdout: `\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment\r\n    Path    REG_EXPAND_SZ    ${registryDir}\r\n`,
          stderr: "",
        } as childProcess.SpawnSyncReturns<string>
      }
      if (String(command).toLowerCase().endsWith("reg.exe") && key === "HKCU\\Environment") {
        return {
          status: 1,
          stdout: "",
          stderr: "missing",
        } as childProcess.SpawnSyncReturns<string>
      }
      throw new Error(`Unexpected spawnSync call: ${String(command)} ${args?.join(" ") ?? ""}`)
    })
    setSpawnSyncRunnerForTests(regSpy as any)

    vi.spyOn(manager as any, "killOrphanProcesses").mockResolvedValue(undefined)
    vi.spyOn(manager as any, "killStaleProcess").mockResolvedValue(undefined)
    vi.spyOn(manager as any, "waitForPidFile").mockResolvedValue("http://127.0.0.1:7777")
    vi.spyOn(manager as any, "pollHealth").mockResolvedValue(undefined)

    const child = createMockChild()
    const spawnSpy = vi.spyOn(manager as any, "spawnProcess").mockReturnValue(child)

    try {
      await manager.start({ cwd: workspaceDir })
    } finally {
      fs.rmSync(registryDir, { recursive: true, force: true })
    }

    expect(spawnSpy).toHaveBeenCalled()
    expect(spawnSpy.mock.calls[0]![0]).toBe(registryBun)
  })

  it.skipIf(process.platform !== "win32")("merges missing Windows registry PATH entries into the spawned server env", async () => {
    Object.defineProperty(process, "platform", { value: "win32" })

    const pathBun = path.join(pathDir, "bun.EXE")
    fs.writeFileSync(pathBun, "")
    process.env.PATH = pathDir

    const machineDir = "C:\\Program Files\\CMake\\bin"
    const userDir = "C:\\Users\\Etienne\\AppData\\Local\\Programs\\Microsoft VS Code\\bin"

    const regSpy = vi.fn().mockImplementation((command, args) => {
      const key = args?.[1]
      if (String(command).toLowerCase().endsWith("reg.exe") && key === "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment") {
        return {
          status: 0,
          stdout: `\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment\r\n    Path    REG_EXPAND_SZ    ${machineDir};%SystemRoot%\\System32\r\n`,
          stderr: "",
        } as childProcess.SpawnSyncReturns<string>
      }
      if (String(command).toLowerCase().endsWith("reg.exe") && key === "HKCU\\Environment") {
        return {
          status: 0,
          stdout: `\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    ${userDir}\r\n`,
          stderr: "",
        } as childProcess.SpawnSyncReturns<string>
      }
      throw new Error(`Unexpected spawnSync call: ${String(command)} ${args?.join(" ") ?? ""}`)
    })
    setSpawnSyncRunnerForTests(regSpy as any)

    vi.spyOn(manager as any, "killOrphanProcesses").mockResolvedValue(undefined)
    vi.spyOn(manager as any, "killStaleProcess").mockResolvedValue(undefined)
    vi.spyOn(manager as any, "waitForPidFile").mockResolvedValue("http://127.0.0.1:7777")
    vi.spyOn(manager as any, "pollHealth").mockResolvedValue(undefined)

    const child = createMockChild()
    const spawnSpy = vi.spyOn(manager as any, "spawnProcess").mockReturnValue(child)

    await manager.start({ cwd: workspaceDir })

    expect(regSpy).toHaveBeenCalledTimes(2)
    const spawnedEnv = spawnSpy.mock.calls[0]![2].env as NodeJS.ProcessEnv
    const pathEntries = normalizeWindowsPathEntries((spawnedEnv.PATH ?? "").split(path.delimiter))
    expect(pathEntries).toContain(machineDir.toLowerCase())
    expect(pathEntries).toContain(userDir.toLowerCase())
    expect(pathEntries).toContain(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32").toLowerCase())
  })

  it.skipIf(process.platform !== "win32")("adds core Windows system directories even when registry lookup fails", async () => {
    Object.defineProperty(process, "platform", { value: "win32" })

    const pathBun = path.join(pathDir, "bun.EXE")
    fs.writeFileSync(pathBun, "")
    process.env.PATH = pathDir

    const regSpy = vi.fn().mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "missing",
    } as childProcess.SpawnSyncReturns<string>)
    setSpawnSyncRunnerForTests(regSpy as any)

    vi.spyOn(manager as any, "killOrphanProcesses").mockResolvedValue(undefined)
    vi.spyOn(manager as any, "killStaleProcess").mockResolvedValue(undefined)
    vi.spyOn(manager as any, "waitForPidFile").mockResolvedValue("http://127.0.0.1:7777")
    vi.spyOn(manager as any, "pollHealth").mockResolvedValue(undefined)

    const child = createMockChild()
    const spawnSpy = vi.spyOn(manager as any, "spawnProcess").mockReturnValue(child)

    await manager.start({ cwd: workspaceDir })

    expect(regSpy).toHaveBeenCalledTimes(2)
    const spawnedEnv = spawnSpy.mock.calls[0]![2].env as NodeJS.ProcessEnv
    const pathEntries = normalizeWindowsPathEntries((spawnedEnv.PATH ?? "").split(path.delimiter))
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows"
    expect(pathEntries).toContain(path.join(systemRoot, "System32").toLowerCase())
    expect(pathEntries).toContain(systemRoot.toLowerCase())
    expect(pathEntries).toContain(path.join(systemRoot, "System32", "Wbem").toLowerCase())
    expect(pathEntries).toContain(path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0").toLowerCase())
  })
})
