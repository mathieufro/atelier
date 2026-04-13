import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { parseOrphanOpencodePids, parseOrphanClaudeSdkPids, AtelierServerManager } from "../src/atelier-server-manager"
import { type ProcessInfo } from "@atelier/core/process-platform"
import * as processPlatform from "@atelier/core/process-platform"

describe("parseOrphanOpencodePids", () => {
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
    expect(waitForExitSpy).toHaveBeenCalledWith(12345, 2000)
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
    expect(waitForExitSpy).toHaveBeenCalledWith(12345, 2000)
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
