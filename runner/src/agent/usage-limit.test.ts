import { describe, expect, test } from "bun:test"
import { detectUsageLimit, parseResetTime } from "./usage-limit"

const NOW = new Date(2026, 10, 12, 10, 0, 0) // local time, 10:00

describe("detectUsageLimit", () => {
  test("ignores ordinary failures", () => {
    expect(detectUsageLimit("TypeError: cannot read properties of undefined", NOW)).toBeNull()
    expect(detectUsageLimit("", NOW)).toBeNull()
    expect(detectUsageLimit(undefined, NOW)).toBeNull()
    expect(detectUsageLimit("API Error: 529 overloaded_error", NOW)).toBeNull()
  })

  test("reads the epoch reset of the older Claude message", () => {
    const epoch = Math.floor(NOW.getTime() / 1000) + 2 * 3600
    const limit = detectUsageLimit(`Claude AI usage limit reached|${epoch}`, NOW)!
    expect(limit.resetAt.getTime()).toBe(epoch * 1000 + 60_000)
  })

  test("reads a clock reset, rolling to tomorrow when it has passed", () => {
    expect(detectUsageLimit("5-hour limit reached ∙ resets 3pm", NOW)!.resetAt.getHours()).toBe(15)
    const tomorrow = parseResetTime("You've hit your limit · resets 9am (Europe/London)", NOW)!
    expect(tomorrow.getDate()).toBe(13)
    expect(tomorrow.getHours()).toBe(9)
  })

  test("reads a relative reset (Codex)", () => {
    const limit = detectUsageLimit("You've hit your usage limit. Try again in 2 hours 5 minutes.", NOW)!
    expect(limit.resetAt.getTime() - NOW.getTime()).toBe((2 * 60 + 5 + 1) * 60_000)
  })

  test("falls back to a default pause when the reset is not stated", () => {
    expect(detectUsageLimit("Weekly limit reached ∙ resets Mon 9am", NOW)!.resetAt.getTime() - NOW.getTime()).toBe(30 * 60_000)
    expect(detectUsageLimit('API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}', NOW)!.resetAt.getTime() - NOW.getTime()).toBe(2 * 60_000)
  })

  test("finds the limit line among other output", () => {
    expect(detectUsageLimit("starting\nsome log\nClaude usage limit reached\nbye", NOW)?.message).toBe("Claude usage limit reached")
  })
})
