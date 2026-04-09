export interface EventMatcher {
  type: string
  [key: string]: unknown
}

export function findEvent(events: Array<Record<string, unknown>>, matcher: EventMatcher): Record<string, unknown> | undefined {
  return events.find((e) => {
    for (const [key, value] of Object.entries(matcher)) {
      if ((e as any)[key] !== value) return false
    }
    return true
  })
}

export function findEvents(events: Array<Record<string, unknown>>, type: string): Array<Record<string, unknown>> {
  return events.filter((e) => (e as any).type === type)
}
