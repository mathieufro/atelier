import type { PresetRecord, StageModelConfig } from "@atelier/core"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as crypto from "node:crypto"

export class PresetStore {
  private presetsDir: string
  private writeChain = Promise.resolve<void>(undefined)

  constructor(presetsDir: string) {
    this.presetsDir = presetsDir
  }

  async listPresets(pipelineType: string): Promise<PresetRecord[]> {
    const typeDir = path.join(this.presetsDir, pipelineType)
    try {
      const files = await fs.readdir(typeDir)
      const presets: PresetRecord[] = []
      for (const file of files) {
        if (!file.endsWith(".json")) continue
        try {
          const content = await fs.readFile(path.join(typeDir, file), "utf-8")
          const preset = JSON.parse(content) as PresetRecord
          presets.push(preset)
        } catch {
          // Corrupt file — skip
        }
      }
      return presets.sort((a, b) => a.name.localeCompare(b.name))
    } catch {
      return []
    }
  }

  async savePreset(
    pipelineType: string,
    name: string,
    stageModels: Record<string, StageModelConfig>,
  ): Promise<PresetRecord> {
    const typeDir = path.join(this.presetsDir, pipelineType)
    await fs.mkdir(typeDir, { recursive: true })
    
    // Check for existing preset with same name
    const existing = await this.listPresets(pipelineType)
    const match = existing.find(p => p.name === name)
    
    const preset: PresetRecord = {
      id: match?.id ?? crypto.randomUUID(),
      name,
      pipelineType,
      stageModels,
      createdAt: match?.createdAt ?? Date.now(),
    }
    
    const filePath = path.join(typeDir, `${preset.id}.json`)
    await this.serializeWrite(filePath, preset)
    return preset
  }

  async deletePreset(presetId: string): Promise<void> {
    // Search all pipeline type directories for the preset
    try {
      const typeDirs = await fs.readdir(this.presetsDir)
      for (const typeDir of typeDirs) {
        const filePath = path.join(this.presetsDir, typeDir, `${presetId}.json`)
        try {
          await fs.unlink(filePath)
          return
        } catch {
          // Not in this directory
        }
      }
    } catch {
      // Presets directory doesn't exist
    }
  }

  private async serializeWrite(filePath: string, preset: PresetRecord): Promise<void> {
    await this.writeChain
    this.writeChain = fs.writeFile(filePath, JSON.stringify(preset, null, 2), "utf-8")
    await this.writeChain
  }
}
