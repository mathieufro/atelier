import { spawn } from "node:child_process"
import { describe, it, expect } from "vitest"
import { isAlive, waitForExit, listProcesses, terminateProcessTree, parseUnixPsOutput, parseWindowsCsvOutput } from "../src/process-platform"

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

describe("parseUnixPsOutput", () => {
  it("parses standard ps output with header", () => {
    const stdout = [
      "  PID  PPID COMMAND",
      "    1     0 /sbin/init",
      " 1234   100 /usr/bin/node server.js",
      "  567     1 opencode serve --hostname=127.0.0.1 --port=0",
    ].join("\n")

    const procs = parseUnixPsOutput(stdout)
    expect(procs).toEqual([
      { pid: 1, ppid: 0, command: "/sbin/init" },
      { pid: 1234, ppid: 100, command: "/usr/bin/node server.js" },
      { pid: 567, ppid: 1, command: "opencode serve --hostname=127.0.0.1 --port=0" },
    ])
  })

  it("skips malformed lines", () => {
    const stdout = [
      "  PID  PPID COMMAND",
      "not-a-pid 100 something",
      "  123",
      "",
      " 456   789 valid command",
    ].join("\n")

    const procs = parseUnixPsOutput(stdout)
    expect(procs).toEqual([
      { pid: 456, ppid: 789, command: "valid command" },
    ])
  })

  it("returns empty array for empty output", () => {
    expect(parseUnixPsOutput("")).toEqual([])
  })

  it("returns empty array for header-only output", () => {
    expect(parseUnixPsOutput("  PID  PPID COMMAND\n")).toEqual([])
  })

  it("handles commands with multiple spaces", () => {
    const stdout = "  PID  PPID COMMAND\n 100     1 /usr/bin/node  --max-old-space-size=4096  app.js\n"
    const procs = parseUnixPsOutput(stdout)
    expect(procs).toHaveLength(1)
    expect(procs[0]!.command).toBe("/usr/bin/node  --max-old-space-size=4096  app.js")
  })
})

describe("parseWindowsCsvOutput", () => {
  it("parses standard CSV output with header", () => {
    const stdout = [
      '"ProcessId","ParentProcessId","CommandLine"',
      '"1234","100","C:\\Program Files\\nodejs\\node.exe server.js"',
      '"5678","1234","opencode serve --hostname=127.0.0.1 --port=0"',
    ].join("\n")

    const procs = parseWindowsCsvOutput(stdout)
    expect(procs).toEqual([
      { pid: 1234, ppid: 100, command: "C:\\Program Files\\nodejs\\node.exe server.js" },
      { pid: 5678, ppid: 1234, command: "opencode serve --hostname=127.0.0.1 --port=0" },
    ])
  })

  it("handles null CommandLine (empty quoted field)", () => {
    const stdout = [
      '"ProcessId","ParentProcessId","CommandLine"',
      '"4","0",""',
    ].join("\n")

    const procs = parseWindowsCsvOutput(stdout)
    expect(procs).toEqual([
      { pid: 4, ppid: 0, command: "" },
    ])
  })

  it("handles null CommandLine (unquoted trailing comma variant)", () => {
    const stdout = [
      '"ProcessId","ParentProcessId","CommandLine"',
      '"4","0",',
    ].join("\n")

    const procs = parseWindowsCsvOutput(stdout)
    expect(procs).toEqual([
      { pid: 4, ppid: 0, command: "" },
    ])
  })

  it("handles \\r\\n line endings from PowerShell", () => {
    const stdout = '"ProcessId","ParentProcessId","CommandLine"\r\n"100","50","node.exe app.js"\r\n"200","50","bun.exe run server"\r\n'

    const procs = parseWindowsCsvOutput(stdout)
    expect(procs).toEqual([
      { pid: 100, ppid: 50, command: "node.exe app.js" },
      { pid: 200, ppid: 50, command: "bun.exe run server" },
    ])
  })

  it("skips malformed lines", () => {
    const stdout = [
      '"ProcessId","ParentProcessId","CommandLine"',
      "not csv at all",
      '"abc","def","ghi"',
      "",
      '"999","1","valid.exe"',
    ].join("\n")

    const procs = parseWindowsCsvOutput(stdout)
    expect(procs).toEqual([
      { pid: 999, ppid: 1, command: "valid.exe" },
    ])
  })

  it("returns empty array for empty output", () => {
    expect(parseWindowsCsvOutput("")).toEqual([])
  })

  it("returns empty array for header-only output", () => {
    expect(parseWindowsCsvOutput('"ProcessId","ParentProcessId","CommandLine"\n')).toEqual([])
  })

  it("handles commands with commas and escaped quotes", () => {
    const stdout = [
      '"ProcessId","ParentProcessId","CommandLine"',
      '"100","1","bun.exe run tool --payload ""{""ATELIER_SESSION_ID"":""abc,123""}"""',
    ].join("\n")

    const procs = parseWindowsCsvOutput(stdout)
    expect(procs).toHaveLength(1)
    expect(procs[0]!.command).toBe('bun.exe run tool --payload "{"ATELIER_SESSION_ID":"abc,123"}"')
  })
})
