import { describe, it, expect, vi } from "vitest"
import { parseOrphanOpencodePids, parseOrphanClaudeSdkPids } from "../src/atelier-server-manager"
import { isAlive, type ProcessInfo } from "@atelier/core/process-platform"

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
  // not by checking ppid === 1. These tests stub the platform to exercise that branch.

  it("parseOrphanOpencodePids detects orphans with dead parent on Windows", () => {
    vi.stubGlobal("process", { ...process, platform: "win32" })

    const procs: ProcessInfo[] = [
      // ppid 99999 is (almost certainly) dead — orphan
      { pid: 100, ppid: 999_999, command: "opencode serve --hostname=127.0.0.1 --port=0" },
      // ppid is the current process — alive, not an orphan
      { pid: 200, ppid: process.pid, command: "opencode serve --hostname=127.0.0.1 --port=0" },
    ]

    expect(parseOrphanOpencodePids(procs)).toEqual([100])
    vi.unstubAllGlobals()
  })

  it("parseOrphanClaudeSdkPids detects orphans with dead parent on Windows", () => {
    vi.stubGlobal("process", { ...process, platform: "win32" })

    const procs: ProcessInfo[] = [
      { pid: 300, ppid: 999_999, command: "node C:\\path\\to\\@anthropic-ai\\claude-agent-sdk\\cli.js" },
      { pid: 400, ppid: process.pid, command: "node C:\\path\\to\\@anthropic-ai\\claude-agent-sdk\\cli.js" },
    ]

    expect(parseOrphanClaudeSdkPids(procs)).toEqual([300])
    vi.unstubAllGlobals()
  })
})
