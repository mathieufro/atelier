import { describe, it, expect } from "vitest"
import { inferLanguageFromDiff, parseUnifiedDiff, hasMixedChanges, computeLineDiff } from "./DiffView.jsx"

describe("inferLanguageFromDiff", () => {
  it("infers language from unified diff file headers", () => {
    const diff = [
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,1 +1,1 @@",
      "-const a = 1",
      "+const b = 2",
    ].join("\n")

    expect(inferLanguageFromDiff(diff)).toBe("typescript")
  })

  it("infers language from apply_patch headers", () => {
    const diff = [
      "*** Begin Patch",
      "*** Update File: server/src/index.ts",
      "@@ -1,1 +1,1 @@",
      "-const x = 1",
      "+const y = 2",
      "*** End Patch",
    ].join("\n")

    expect(inferLanguageFromDiff(diff)).toBe("typescript")
  })
})

describe("hasMixedChanges", () => {
  it("returns true when diff has both additions and removals", () => {
    const diff = [
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,1 +1,1 @@",
      "-const a = 1",
      "+const b = 2",
    ].join("\n")

    expect(hasMixedChanges(parseUnifiedDiff(diff))).toBe(true)
  })

  it("returns false when diff has only additions", () => {
    const diff = [
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1,2 @@",
      "+const a = 1",
      "+const b = 2",
    ].join("\n")

    expect(hasMixedChanges(parseUnifiedDiff(diff))).toBe(false)
  })

  it("returns false when diff has only removals", () => {
    const diff = [
      "--- a/src/old.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-const a = 1",
      "-const b = 2",
    ].join("\n")

    expect(hasMixedChanges(parseUnifiedDiff(diff))).toBe(false)
  })
})

describe("computeLineDiff", () => {
  it("marks unchanged lines as context, not as removed+added", () => {
    const old = '#include "a.hpp"\n#include "b.hpp"\n#include "c.hpp"'
    const new_ = '#include "a.hpp"\n#include "b_new.hpp"\n#include "c.hpp"'

    const diff = computeLineDiff(old, new_, "test.cpp")
    const hunks = parseUnifiedDiff(diff)
    const lines = hunks[0]!.lines

    // a.hpp and c.hpp should be context, not removed
    expect(lines.filter(l => l.type === "context")).toHaveLength(2)
    expect(lines.filter(l => l.type === "remove")).toHaveLength(1)
    expect(lines.filter(l => l.type === "add")).toHaveLength(1)
    expect(lines.find(l => l.type === "remove")!.content).toBe('#include "b.hpp"')
    expect(lines.find(l => l.type === "add")!.content).toBe('#include "b_new.hpp"')
  })

  it("handles pure addition (empty old_string)", () => {
    const diff = computeLineDiff("", "new line 1\nnew line 2")
    const hunks = parseUnifiedDiff(diff)
    const lines = hunks[0]!.lines

    expect(lines.filter(l => l.type === "add")).toHaveLength(2)
    expect(lines.filter(l => l.type === "remove")).toHaveLength(0)
  })

  it("handles pure removal (empty new_string)", () => {
    const diff = computeLineDiff("old line 1\nold line 2", "")
    const hunks = parseUnifiedDiff(diff)
    const lines = hunks[0]!.lines

    expect(lines.filter(l => l.type === "remove")).toHaveLength(2)
    expect(lines.filter(l => l.type === "add")).toHaveLength(0)
  })

  it("includes file path in diff headers", () => {
    const diff = computeLineDiff("a", "b", "src/test.cpp")
    expect(diff).toContain("--- a/src/test.cpp")
    expect(diff).toContain("+++ b/src/test.cpp")
  })

  it("handles identical strings (all context)", () => {
    const diff = computeLineDiff("line 1\nline 2", "line 1\nline 2")
    const hunks = parseUnifiedDiff(diff)
    const lines = hunks[0]!.lines

    expect(lines.every(l => l.type === "context")).toBe(true)
  })
})
