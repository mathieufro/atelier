import { spawn } from "node:child_process"
import { describe, it, expect } from "vitest"
import { isAlive, waitForExit, listProcesses, terminateProcessTree } from "../src/process-platform"

describe("isAlive", () => {
  it("returns true for the current process", () => {
    expect(isAlive(process.pid)).toBe(true)
  })

  it("returns false for a known-dead PID", () => {
    expect(isAlive(999_999)).toBe(false)
  })

  it("returns false for PID 0", () => {
    // On Unix, process.kill(0, 0) sends signal to the process group — the guard prevents this.
    // On Windows, PID 0 is the System Idle Process. Either way, not a valid user process.
    expect(isAlive(0)).toBe(false)
  })

  it("returns false for negative PIDs", () => {
    // Negative PIDs target process groups on Unix — the guard prevents this side-effect.
    expect(isAlive(-1)).toBe(false)
    expect(isAlive(-process.pid)).toBe(false)
  })
})

describe("waitForExit", () => {
  it("returns true immediately for an already-dead PID", async () => {
    const result = await waitForExit(999_999, 500)
    expect(result).toBe(true)
  })

  it("returns false when a live process does not exit within timeout", async () => {
    const result = await waitForExit(process.pid, 200)
    expect(result).toBe(false)
  })
})

describe("listProcesses", () => {
  it("returns the current process in the list", () => {
    const procs = listProcesses()
    const self = procs.find((p) => p.pid === process.pid)
    expect(self).toBeDefined()
    expect(self!.pid).toBe(process.pid)
  })

  it("filters processes with a predicate", () => {
    const procs = listProcesses((p) => p.pid === process.pid)
    expect(procs.length).toBe(1)
    expect(procs[0]!.pid).toBe(process.pid)
  })

  it("returns an empty array when no processes match the filter", () => {
    const procs = listProcesses(() => false)
    expect(procs).toEqual([])
  })

  it("every ProcessInfo has numeric pid and ppid and string command", () => {
    const procs = listProcesses()
    expect(procs.length).toBeGreaterThan(0)
    for (const p of procs) {
      expect(typeof p.pid).toBe("number")
      expect(Number.isFinite(p.pid)).toBe(true)
      expect(typeof p.ppid).toBe("number")
      expect(Number.isFinite(p.ppid)).toBe(true)
      expect(typeof p.command).toBe("string")
    }
  })
})

describe("terminateProcessTree", () => {
  it("terminates a detached long-running process", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      detached: process.platform !== "win32",
      stdio: "ignore",
      windowsHide: true,
    })
    child.unref()

    expect(child.pid).toBeDefined()
    const pid = child.pid!
    expect(isAlive(pid)).toBe(true)

    await terminateProcessTree(pid, { graceMs: 300, forceMs: 300 })

    expect(await waitForExit(pid, 2000)).toBe(true)
    expect(isAlive(pid)).toBe(false)
  })

  it("returns false via waitForExit when process stays alive past timeout", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      detached: process.platform !== "win32",
      stdio: "ignore",
      windowsHide: true,
    })
    child.unref()

    expect(child.pid).toBeDefined()
    const pid = child.pid!
    expect(isAlive(pid)).toBe(true)

    // Very short timeout — process should still be alive
    expect(await waitForExit(pid, 100)).toBe(false)

    // Clean up
    await terminateProcessTree(pid, { graceMs: 300, forceMs: 300 })
    expect(await waitForExit(pid, 2000)).toBe(true)
  })

  it("does not throw for already-dead PID", async () => {
    await expect(
      terminateProcessTree(999_999, { graceMs: 100, forceMs: 100 })
    ).resolves.toBeUndefined()
  })
})
