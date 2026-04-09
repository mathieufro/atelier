import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { FavoritesStore } from "../../src/engine/favorites-store.js"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

describe("FavoritesStore", () => {
  let tmpDir: string
  let favPath: string
  let store: FavoritesStore

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "favorites-"))
    favPath = path.join(tmpDir, "favorites.json")
    store = new FavoritesStore(favPath)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("lists empty favorites initially", async () => {
    const list = await store.listFavorites()
    expect(list).toEqual([])
  })

  it("upserts a favorite", async () => {
    const result = await store.upsertFavorite({ providerID: "anthropic", modelID: "claude-sonnet-4-6" })
    expect(result).toHaveLength(1)
    expect(result[0].providerID).toBe("anthropic")
    expect(result[0].modelID).toBe("claude-sonnet-4-6")
    expect(result[0].variant).toBeUndefined()
  })

  it("upserts existing favorite moves to front", async () => {
    await store.upsertFavorite({ providerID: "anthropic", modelID: "claude-sonnet-4-6" })
    await store.upsertFavorite({ providerID: "openai", modelID: "gpt-4o" })
    const result = await store.upsertFavorite({ providerID: "anthropic", modelID: "claude-sonnet-4-6" })
    expect(result).toHaveLength(2)
    expect(result[0].modelID).toBe("claude-sonnet-4-6") // moved to front
  })

  it("removes a favorite", async () => {
    await store.upsertFavorite({ providerID: "anthropic", modelID: "claude-sonnet-4-6" })
    const result = await store.removeFavorite("anthropic::claude-sonnet-4-6::__none__")
    expect(result).toEqual([])
  })

  it("reorders favorites", async () => {
    await store.upsertFavorite({ providerID: "a", modelID: "m1" })
    await store.upsertFavorite({ providerID: "b", modelID: "m2" })
    // After upsert: m2 is first, m1 is second
    const result = await store.reorderFavorites(["a::m1::__none__", "b::m2::__none__"])
    expect(result[0].modelID).toBe("m1")
    expect(result[1].modelID).toBe("m2")
  })

  it("normalizes __none__ variant to undefined", async () => {
    // Write raw file with __none__ variant
    fs.writeFileSync(favPath, JSON.stringify([
      { providerID: "a", modelID: "m1", variant: "__none__", favoriteKey: "a::m1::__none__" }
    ]))
    const store2 = new FavoritesStore(favPath)
    const list = await store2.listFavorites()
    expect(list[0].variant).toBeUndefined()
  })

  it("persists to disk", async () => {
    await store.upsertFavorite({ providerID: "a", modelID: "m1" })
    const store2 = new FavoritesStore(favPath)
    const list = await store2.listFavorites()
    expect(list).toHaveLength(1)
  })
})
