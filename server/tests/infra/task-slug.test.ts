import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { generateTaskSlug, generateSessionTitle, resolveUniquePipelineDir } from "../../src/infra/task-slug.js"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"

describe("generateTaskSlug", () => {
  it("generates slug from prompt", () => {
    expect(generateTaskSlug("Build a Twitter clone as a todolist app")).toBe("build-twitter-clone-todolist-app")
  })

  it("filters stop words", () => {
    expect(generateTaskSlug("Add the user authentication to my app")).toBe("add-user-authentication-app")
  })

  it("limits to 5 words", () => {
    expect(generateTaskSlug("one two three four five six seven")).toBe("one-two-three-four-five")
  })

  it("handles empty prompt", () => {
    expect(generateTaskSlug("")).toBe("pipeline")
  })

  it("handles prompt with only stop words", () => {
    expect(generateTaskSlug("the a an")).toBe("pipeline")
  })

  it("strips special characters", () => {
    expect(generateTaskSlug("Fix the bug in auth!")).toBe("fix-bug-auth")
  })

  it("caps length at 60 characters", () => {
    const long = "superlongwordthatgoeson " + "andkeepsgoing ".repeat(10)
    const slug = generateTaskSlug(long)
    expect(slug.length).toBeLessThanOrEqual(60)
  })
})

describe("generateSessionTitle", () => {
  it("returns first line of message as title", () => {
    expect(generateSessionTitle("Fix the login bug")).toBe("Fix the login bug")
  })

  it("strips markdown heading markers", () => {
    expect(generateSessionTitle("## Add dark mode")).toBe("Add dark mode")
  })

  it("strips markdown formatting", () => {
    expect(generateSessionTitle("Fix **bold** and _italic_ text")).toBe("Fix bold and italic text")
  })

  it("strips markdown links", () => {
    expect(generateSessionTitle("Check [this doc](http://example.com) please")).toBe("Check this doc please")
  })

  it("truncates long messages on word boundary", () => {
    const long = "Implement a comprehensive authentication system with OAuth2 and JWT tokens for the new API"
    const title = generateSessionTitle(long)
    expect(title.length).toBeLessThanOrEqual(65) // 60 + ellipsis + tolerance
    expect(title).toContain("…")
  })

  it("uses first non-empty line", () => {
    expect(generateSessionTitle("\n\n  Hello world  \nmore stuff")).toBe("Hello world")
  })

  it("returns 'Chat' for empty message", () => {
    expect(generateSessionTitle("")).toBe("Chat")
    expect(generateSessionTitle("   \n  \n  ")).toBe("Chat")
  })

  it("returns 'Chat' for markdown-only content", () => {
    expect(generateSessionTitle("## ")).toBe("Chat")
  })
})

describe("resolveUniquePipelineDir", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "slug-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("returns baseDir when it does not exist", () => {
    expect(resolveUniquePipelineDir(tmpDir, ".atelier/2026-02-28-todo")).toBe(".atelier/2026-02-28-todo")
  })

  it("appends -2 when baseDir exists", () => {
    fs.mkdirSync(path.join(tmpDir, ".atelier/2026-02-28-todo"), { recursive: true })
    expect(resolveUniquePipelineDir(tmpDir, ".atelier/2026-02-28-todo")).toBe(".atelier/2026-02-28-todo-2")
  })

  it("appends -3 when both baseDir and -2 exist", () => {
    fs.mkdirSync(path.join(tmpDir, ".atelier/2026-02-28-todo"), { recursive: true })
    fs.mkdirSync(path.join(tmpDir, ".atelier/2026-02-28-todo-2"), { recursive: true })
    expect(resolveUniquePipelineDir(tmpDir, ".atelier/2026-02-28-todo")).toBe(".atelier/2026-02-28-todo-3")
  })
})
