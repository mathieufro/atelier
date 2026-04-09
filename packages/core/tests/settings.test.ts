import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { readSettings, writeSettings, settingsPath } from "../src/settings.js"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"

describe("settings", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-settings-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe("readSettings", () => {
    it("returns defaults when file does not exist", () => {
      const settings = readSettings(tmpDir)
      expect(settings).toEqual({ serverPort: null, serverUrl: null, gitEnabled: false })
    })

    it("returns defaults on malformed JSON", () => {
      fs.writeFileSync(settingsPath(tmpDir), "not json", "utf-8")
      const settings = readSettings(tmpDir)
      expect(settings).toEqual({ serverPort: null, serverUrl: null, gitEnabled: false })
    })

    it("returns defaults when file contains an array", () => {
      fs.writeFileSync(settingsPath(tmpDir), "[]", "utf-8")
      expect(readSettings(tmpDir)).toEqual({ serverPort: null, serverUrl: null, gitEnabled: false })
    })

    it("reads valid settings", () => {
      writeSettings(tmpDir, { serverPort: 8080, gitEnabled: true })
      const settings = readSettings(tmpDir)
      expect(settings.serverPort).toBe(8080)
      expect(settings.gitEnabled).toBe(true)
    })

    it("fills missing fields with defaults", () => {
      fs.writeFileSync(settingsPath(tmpDir), JSON.stringify({ gitEnabled: true }), "utf-8")
      const settings = readSettings(tmpDir)
      expect(settings.serverPort).toBeNull()
      expect(settings.gitEnabled).toBe(true)
    })

    it("ignores invalid serverPort values", () => {
      fs.writeFileSync(settingsPath(tmpDir), JSON.stringify({ serverPort: -1 }), "utf-8")
      expect(readSettings(tmpDir).serverPort).toBeNull()

      fs.writeFileSync(settingsPath(tmpDir), JSON.stringify({ serverPort: 99999 }), "utf-8")
      expect(readSettings(tmpDir).serverPort).toBeNull()

      fs.writeFileSync(settingsPath(tmpDir), JSON.stringify({ serverPort: "abc" }), "utf-8")
      expect(readSettings(tmpDir).serverPort).toBeNull()
    })

    it("accepts null serverPort", () => {
      writeSettings(tmpDir, { serverPort: null })
      expect(readSettings(tmpDir).serverPort).toBeNull()
    })

    it("ignores non-boolean gitEnabled", () => {
      fs.writeFileSync(settingsPath(tmpDir), JSON.stringify({ gitEnabled: "yes" }), "utf-8")
      expect(readSettings(tmpDir).gitEnabled).toBe(false)
    })
  })

  describe("writeSettings", () => {
    it("creates directory if it does not exist", () => {
      const nested = path.join(tmpDir, "a", "b")
      writeSettings(nested, { serverPort: 3000 })
      expect(readSettings(nested).serverPort).toBe(3000)
    })

    it("overwrites existing settings", () => {
      writeSettings(tmpDir, { serverPort: 8080, gitEnabled: false })
      writeSettings(tmpDir, { serverPort: 9090, gitEnabled: true })
      const settings = readSettings(tmpDir)
      expect(settings.serverPort).toBe(9090)
      expect(settings.gitEnabled).toBe(true)
    })

    it("writes formatted JSON with trailing newline", () => {
      writeSettings(tmpDir, { gitEnabled: true })
      const raw = fs.readFileSync(settingsPath(tmpDir), "utf-8")
      expect(raw).toContain("\n")
      expect(raw.endsWith("\n")).toBe(true)
      // Formatted = has indentation
      expect(raw).toContain("  ")
    })
  })

  describe("settingsPath", () => {
    it("returns path inside stateDir", () => {
      expect(settingsPath("/foo/bar")).toBe("/foo/bar/settings.json")
    })
  })
})
