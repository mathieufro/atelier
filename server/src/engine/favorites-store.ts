import { favoriteKeyOf, type FavoritePair, type FavoriteRecord } from "@atelier/core"
import * as fs from "node:fs/promises"
import * as path from "node:path"

export class FavoritesStore {
  private filePath: string
  private writeChain = Promise.resolve<void>(undefined)

  constructor(filePath: string) {
    this.filePath = filePath
  }

  async listFavorites(): Promise<FavoriteRecord[]> {
    return this.readFile()
  }

  async upsertFavorite(pair: FavoritePair): Promise<FavoriteRecord[]> {
    return this.mutateSerially((rows) => {
      const key = favoriteKeyOf(pair)
      const next = rows.filter((row) => row.favoriteKey !== key)
      next.unshift({ ...pair, favoriteKey: key })
      return next
    })
  }

  async removeFavorite(favoriteKey: string): Promise<FavoriteRecord[]> {
    return this.mutateSerially((rows) => rows.filter((row) => row.favoriteKey !== favoriteKey))
  }

  async reorderFavorites(favoriteKeys: string[]): Promise<FavoriteRecord[]> {
    return this.mutateSerially((rows) => {
      const rowMap = new Map(rows.map((row) => [row.favoriteKey, row] as const))
      return favoriteKeys.map((key) => {
        const row = rowMap.get(key)
        if (!row) throw new Error("favoriteKeys contains unknown values")
        return row
      })
    })
  }

  private normalize(row: FavoriteRecord): FavoriteRecord {
    return {
      favoriteKey: row.favoriteKey,
      providerID: row.providerID,
      modelID: row.modelID,
      variant: row.variant === "__none__" ? undefined : row.variant,
    }
  }

  private async readFile(): Promise<FavoriteRecord[]> {
    try {
      const raw = await fs.readFile(this.filePath, "utf-8")
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed
        .filter((row: unknown) => row && typeof row === "object")
        .map((row: unknown) => {
          const r = row as FavoriteRecord
          if (!r.providerID || !r.modelID) return null
          return this.normalize({
            providerID: r.providerID,
            modelID: r.modelID,
            variant: typeof r.variant === "string" ? r.variant : undefined,
            favoriteKey: favoriteKeyOf({ providerID: r.providerID, modelID: r.modelID, variant: r.variant }),
          })
        })
        .filter((r): r is FavoriteRecord => r !== null)
    } catch {
      return []
    }
  }

  private async writeFile(favorites: FavoriteRecord[]): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    await fs.writeFile(this.filePath, JSON.stringify(favorites, null, 2), "utf-8")
  }

  private mutateSerially(
    mutate: (current: FavoriteRecord[]) => FavoriteRecord[] | Promise<FavoriteRecord[]>,
  ): Promise<FavoriteRecord[]> {
    const run = this.writeChain.then(async () => {
      const current = await this.readFile()
      const next = await mutate(current)
      await this.writeFile(next)
      return next
    })
    this.writeChain = run.then(() => undefined, () => undefined)
    return run
  }
}
