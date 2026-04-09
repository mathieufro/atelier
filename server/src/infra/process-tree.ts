export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (!isAlive(pid)) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return !isAlive(pid)
}

export async function terminateProcessTree(pid: number, options?: { graceMs?: number; forceMs?: number }): Promise<void> {
  const graceMs = options?.graceMs ?? 2500
  const forceMs = options?.forceMs ?? 1000

  try { process.kill(-pid, "SIGTERM") } catch {}
  try { process.kill(pid, "SIGTERM") } catch {}

  if (await waitForExit(pid, graceMs)) return

  try { process.kill(-pid, "SIGKILL") } catch {}
  try { process.kill(pid, "SIGKILL") } catch {}
  await waitForExit(pid, forceMs)
}
