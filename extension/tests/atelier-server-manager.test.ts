import { describe, expect, it } from "vitest"
import { parseOrphanOpencodePids } from "../src/atelier-server-manager"

describe("parseOrphanOpencodePids", () => {
  it("returns only strict orphan opencode serve matches", () => {
    const ps = [
      " 15787     1 opencode serve --hostname=127.0.0.1 --port=0",
      " 15796     1 opencode serve --hostname=127.0.0.1 --port=0",
      " 20800 15796 opencode serve --hostname=127.0.0.1 --port=0",
      " 12345     1 opencode serve --hostname=0.0.0.0 --port=4096",
      " 99999     1 node /tmp/foo.js",
      "",
    ].join("\n")

    expect(parseOrphanOpencodePids(ps)).toEqual([15787, 15796])
  })

  it("handles malformed rows safely", () => {
    const ps = [
      "not a process row",
      "abc def ghi",
      " 11111     1 opencode serve --hostname=127.0.0.1 --port=0",
    ].join("\n")

    expect(parseOrphanOpencodePids(ps)).toEqual([11111])
  })
})
