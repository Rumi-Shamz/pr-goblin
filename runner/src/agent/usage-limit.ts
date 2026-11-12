// agent/usage-limit.ts — Recognise "you have run out of quota" in an agent's output.
//
// A subscription sign-in (Claude Pro/Max, ChatGPT plans) has rolling usage
// caps that reset hours later, and an API key can hit a rate limit. Either way
// the ticket is fine; the agent just cannot work right now. Treating that as a
// failure burns the retries in minutes and parks the ticket, so the kernel asks
// this module first and, on a match, pauses until the reset instead.

export interface UsageLimit {
  /** When to try again. */
  resetAt: Date
  /** The line that matched, for logs. */
  message: string
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
/** Used when a subscription cap is recognised but its reset time is not. */
const DEFAULT_CAP_PAUSE = 30 * MINUTE
/** Used for a plain API rate limit (HTTP 429), which clears quickly. */
const DEFAULT_RATE_PAUSE = 2 * MINUTE
const MAX_PAUSE = 7 * 24 * HOUR
/** Start a little after the stated reset, not on the dot. */
const MARGIN = MINUTE

// Subscription caps: "Claude AI usage limit reached|1736553600",
// "5-hour limit reached ∙ resets 3pm", "You've hit your limit · resets 11am (Europe/London)",
// "Weekly limit reached", Codex "You've hit your usage limit … try again in 2 hours".
const CAP_PATTERNS = [
  /usage limit reached/i,
  /hit your (?:usage )?limit/i,
  /\b(?:\d+-hour|weekly|daily|session) limit reached/i,
  /usage_limit_reached/i,
  /out of (?:extra )?usage/i,
]

// API rate limits. Overload (529) is deliberately not here: it is transient
// and the ordinary retry handles it.
const RATE_PATTERNS = [
  /rate_limit_error/i,
  /\b429\b.*(?:rate|limit|too many)/i,
  /too many requests/i,
]

export function detectUsageLimit(text: string | undefined, now: Date = new Date()): UsageLimit | null {
  if (!text) return null
  const lines = text.split('\n')
  const capLine = lines.find((l) => CAP_PATTERNS.some((p) => p.test(l)))
  const rateLine = capLine ? undefined : lines.find((l) => RATE_PATTERNS.some((p) => p.test(l)))
  const line = capLine ?? rateLine
  if (!line) return null

  const parsed = parseResetTime(line, now)
  const fallback = capLine ? DEFAULT_CAP_PAUSE : DEFAULT_RATE_PAUSE
  let delay = parsed ? parsed.getTime() - now.getTime() + MARGIN : fallback
  delay = Math.min(Math.max(delay, MINUTE), MAX_PAUSE)
  return { resetAt: new Date(now.getTime() + delay), message: line.trim().slice(0, 200) }
}

/** Best effort: the reset time the message states, or null. */
export function parseResetTime(line: string, now: Date): Date | null {
  // "…limit reached|1736553600" (epoch seconds)
  const epoch = line.match(/\|(\d{10})\b/)
  if (epoch) return new Date(Number(epoch[1]) * 1000)

  // "try again in 2 hours 5 minutes", "in 45 minutes", "in 3h 20m"
  const rel = line.match(/(?:try again|retry|resets?)\s+in\s+([^.;\n]+)/i)
  if (rel) {
    let ms = 0
    for (const m of rel[1].matchAll(/(\d+)\s*(d(?:ays?)?|h(?:ours?|rs?)?|m(?:in(?:ute)?s?)?|s(?:ec(?:ond)?s?)?)\b/gi)) {
      const n = Number(m[1])
      const unit = m[2][0].toLowerCase()
      ms += n * (unit === 'd' ? 24 * HOUR : unit === 'h' ? HOUR : unit === 'm' ? MINUTE : 1000)
    }
    if (ms > 0) return new Date(now.getTime() + ms)
  }

  // "resets 3pm", "resets at 3:30 PM", "try again at 15:00". Read in local time;
  // a time already past today means tomorrow. A named day ("resets Mon 9am") is
  // not parsed, and falls back to the default pause, which simply checks again.
  const clock = line.match(/(?:resets?|try again)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i)
  if (clock && (clock[2] || clock[3])) {
    let hour = Number(clock[1])
    const minute = Number(clock[2] ?? 0)
    const meridiem = clock[3]?.toLowerCase()
    if (meridiem === 'pm' && hour < 12) hour += 12
    if (meridiem === 'am' && hour === 12) hour = 0
    if (hour > 23 || minute > 59) return null
    const at = new Date(now)
    at.setHours(hour, minute, 0, 0)
    if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1)
    return at
  }
  return null
}
