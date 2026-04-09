import type { DetectorProgressSubtype } from "./idle-detector-events.js"

export interface IdleDetectorStagePolicyOverride {
  busyCorroborationWindowMs?: number
  quietWindowMs?: number
  quietCorroborationMs?: number
  doneUnsignaledWindowMs?: number
  reconnectStabilizationWindowMs?: number

  leaseBySubtypeMs?: Partial<Record<DetectorProgressSubtype, number>>
}

export interface IdleDetectorConfig {
  /** Consumed by the orchestrator's external sweep interval, not by the detector itself. */
  sweepIntervalMs: number
  busyCorroborationWindowMs: number
  quietWindowMs: number
  quietCorroborationMs: number
  doneUnsignaledWindowMs: number
  reconnectStabilizationWindowMs: number

  leaseBySubtypeMs: Record<DetectorProgressSubtype, number>
}

export const DEFAULT_IDLE_DETECTOR_CONFIG: IdleDetectorConfig = {
  sweepIntervalMs: 5_000,
  busyCorroborationWindowMs: 15_000,
  quietWindowMs: 45_000,
  quietCorroborationMs: 15_000,
  doneUnsignaledWindowMs: 15_000,
  reconnectStabilizationWindowMs: 10_000,
  leaseBySubtypeMs: {
    assistant_turn: 30_000,
    part_progress: 30_000,
    tool_start: 300_000,       // 5 min — tools can legitimately run for a long time
    tool_running: 300_000,     // 5 min — covers long tool argument streaming (large Write calls)
    tool_terminal: 90_000,     // 90s — post-tool-result gap while API processes next response
    subagent_progress: 300_000, // 5 min — subagents can be long-running
    file_write_adjacent: 90_000, // 90s — covers tool execution + API round-trip after assistant message
    unknown: 30_000,
  },
}

export interface ResolveIdleDetectorConfigInput {
  stage: string
  stageMode: "autonomous" | "interactive" | "compile"
  serverDefaults?: Partial<IdleDetectorStagePolicyOverride>
  pipelineConfig?: Partial<IdleDetectorStagePolicyOverride>
  stageOverride?: Partial<IdleDetectorStagePolicyOverride>
}

function mergeConfig(
  base: IdleDetectorConfig,
  override?: Partial<IdleDetectorStagePolicyOverride>,
): IdleDetectorConfig {
  if (!override) return base
  const { leaseBySubtypeMs, ...scalars } = override
  const defined = Object.fromEntries(Object.entries(scalars).filter(([, v]) => v !== undefined))
  return {
    ...base,
    ...defined,
    leaseBySubtypeMs: leaseBySubtypeMs ? { ...base.leaseBySubtypeMs, ...leaseBySubtypeMs } : base.leaseBySubtypeMs,
  }
}

export function resolveIdleDetectorConfig(input: ResolveIdleDetectorConfigInput): IdleDetectorConfig {
  const fromServer = mergeConfig(DEFAULT_IDLE_DETECTOR_CONFIG, input.serverDefaults)
  const fromPipeline = mergeConfig(fromServer, input.pipelineConfig)
  const resolved = mergeConfig(fromPipeline, input.stageOverride)

  return resolved
}
