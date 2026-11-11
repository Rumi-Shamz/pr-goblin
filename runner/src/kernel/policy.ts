// kernel/policy.ts — decides when a ticket may be worked and how.
//
// Pure functions, no I/O. The kernel calls decide() for every polled item.
//
// Two questions are answered per ticket:
//   lane — when does it run?   urgent (now) | normal (now) | batch (window) | hold (never, until a human acts)
//   mode — what may the agent do?   implement (write code, open PR) | investigate (read-only, plan on the ticket)
//
// The trust rule: a ticket carrying the "untrusted" label came from someone
// outside the team (e.g. a public feedback widget). Its text is attacker-
// influenced, so it never gets a code-writing agent on its own. If it is also
// urgent, an agent investigates read-only so a human has a head start;
// otherwise it waits for a human to triage it and remove the label.

import type { SourceItem } from "./types"

export type Lane = "urgent" | "normal" | "batch" | "hold"
export type TaskMode = "implement" | "investigate"

export interface PolicyConfig {
  /** Labels that mark a ticket urgent. Tracker priority 1 (Urgent) always counts. */
  urgentLabels: string[]
  /** Labels that put a ticket in the batch lane. A trailing ":" or "/" scope is allowed, e.g. "batch:ui". */
  batchLabels: string[]
  /** Label marking a report from an untrusted reporter. */
  untrustedLabel: string
  /** Label the runner adds once an untrusted urgent ticket has been investigated, so it is not investigated twice. */
  investigatedLabel: string
  /** Local-time window in which batch tickets are released. start === end disables the window. */
  batchWindow: { startHour: number; endHour: number }
  /** Release the batch early once this many batch tickets are waiting. 0 disables. */
  batchMinCount: number
  /** Most batch tickets released in one cycle. */
  batchMaxSize: number
}

export const DEFAULT_POLICY: PolicyConfig = {
  urgentLabels: ["critical", "severity:critical", "urgent"],
  batchLabels: ["batch"],
  untrustedLabel: "untrusted",
  investigatedLabel: "goblin:investigated",
  batchWindow: { startHour: 2, endHour: 5 },
  batchMinCount: 0,
  batchMaxSize: 5,
}

export interface Decision {
  lane: Lane
  mode: TaskMode
  /** Short human-readable reason, for logs. */
  reason: string
}

function norm(label: string): string {
  return label.trim().toLowerCase()
}

function hasLabel(labels: string[], wanted: string[]): boolean {
  const set = new Set(labels.map(norm))
  return wanted.some(w => set.has(norm(w)))
}

/** "batch" matches "batch", "batch:ui" and "batch/ui". */
function hasBatchLabel(labels: string[], batchLabels: string[]): boolean {
  const wanted = batchLabels.map(norm)
  return labels.map(norm).some(l =>
    wanted.some(w => l === w || l.startsWith(`${w}:`) || l.startsWith(`${w}/`)),
  )
}

export function isUrgent(item: Pick<SourceItem, "labels" | "priority">, cfg: PolicyConfig): boolean {
  return item.priority === 1 || hasLabel(item.labels, cfg.urgentLabels)
}

export function isUntrusted(item: Pick<SourceItem, "labels">, cfg: PolicyConfig): boolean {
  return hasLabel(item.labels, [cfg.untrustedLabel])
}

/** Classify one ticket. Says nothing about whether a batch is currently released. */
export function decide(item: Pick<SourceItem, "labels" | "priority">, cfg: PolicyConfig = DEFAULT_POLICY): Decision {
  const urgent = isUrgent(item, cfg)

  if (isUntrusted(item, cfg)) {
    if (hasLabel(item.labels, [cfg.investigatedLabel])) {
      return { lane: "hold", mode: "investigate", reason: "untrusted: investigated, waiting for human triage" }
    }
    return urgent
      ? { lane: "urgent", mode: "investigate", reason: "untrusted + urgent: read-only investigation" }
      : { lane: "hold", mode: "investigate", reason: "untrusted: waiting for human triage" }
  }

  if (urgent) return { lane: "urgent", mode: "implement", reason: "urgent" }
  if (hasBatchLabel(item.labels, cfg.batchLabels)) {
    return { lane: "batch", mode: "implement", reason: "batch lane" }
  }
  return { lane: "normal", mode: "implement", reason: "normal" }
}

/** True when `now` falls inside the batch window. Handles windows that cross midnight. */
export function inBatchWindow(now: Date, cfg: PolicyConfig = DEFAULT_POLICY): boolean {
  const { startHour, endHour } = cfg.batchWindow
  if (startHour === endHour) return false
  const h = now.getHours()
  return startHour < endHour ? h >= startHour && h < endHour : h >= startHour || h < endHour
}

/** Whether waiting batch tickets may run now. */
export function batchReleased(waitingCount: number, now: Date, cfg: PolicyConfig = DEFAULT_POLICY): boolean {
  if (waitingCount === 0) return false
  if (inBatchWindow(now, cfg)) return true
  return cfg.batchMinCount > 0 && waitingCount >= cfg.batchMinCount
}

export interface Admitted<T> {
  item: T
  decision: Decision
}

/**
 * Filter a poll result down to the tickets that may be worked right now,
 * in dispatch order: urgent first, then normal, then the released batch.
 */
export function admit<T extends Pick<SourceItem, "labels" | "priority">>(
  items: T[],
  now: Date,
  cfg: PolicyConfig = DEFAULT_POLICY,
): { admitted: Admitted<T>[]; held: Admitted<T>[]; batchWaiting: Admitted<T>[] } {
  const classified = items.map(item => ({ item, decision: decide(item, cfg) }))
  const byLane = (lane: Lane) => classified.filter(c => c.decision.lane === lane)

  const batch = byLane("batch")
  const released = batchReleased(batch.length, now, cfg)
  const batchNow = released ? batch.slice(0, cfg.batchMaxSize) : []

  return {
    admitted: [...byLane("urgent"), ...byLane("normal"), ...batchNow],
    held: byLane("hold"),
    batchWaiting: released ? batch.slice(cfg.batchMaxSize) : batch,
  }
}
