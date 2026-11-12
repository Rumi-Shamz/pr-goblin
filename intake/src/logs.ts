// logs.ts — console and network errors the widget captured before the report.
//
// These are the single most useful thing for whoever (or whatever) fixes the
// bug, and the reporter never has to know they exist. They are also
// attacker-controlled text, so they are capped hard and rendered inside a
// fenced block where markdown cannot do anything.

import { z } from 'zod'

export const MAX_LOG_ENTRIES = 30
export const MAX_LOG_MESSAGE = 500

export const logEntrySchema = z.object({
  level: z.enum(['error', 'warn', 'exception', 'rejection', 'network']),
  message: z.string().max(2000),
  ts: z.string().max(40).nullish(),
})

export const logsSchema = z.array(logEntrySchema).max(100).nullish()

export type LogEntry = z.infer<typeof logEntrySchema>

/** Keep the most recent entries, trim each message, and make it safe inside a ``` fence. */
export function sanitiseLogs(logs: LogEntry[] | null | undefined): LogEntry[] {
  if (!logs || logs.length === 0) return []
  return logs.slice(-MAX_LOG_ENTRIES).map((entry) => ({
    level: entry.level,
    ts: entry.ts ?? null,
    message: entry.message
      .replace(/```/g, "'''")
      .replace(/\r?\n/g, ' ⏎ ')
      .slice(0, MAX_LOG_MESSAGE),
  }))
}

/** A collapsed markdown section, or '' when there is nothing to show. */
export function renderLogsSection(logs: LogEntry[]): string {
  if (logs.length === 0) return ''
  const lines = logs.map((l) => `${l.ts ? `${l.ts} ` : ''}[${l.level}] ${l.message}`)
  return `<details>
<summary>Console and network errors before the report (${logs.length})</summary>

\`\`\`text
${lines.join('\n')}
\`\`\`

</details>

`
}
