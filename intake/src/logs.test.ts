import { describe, it, expect } from 'vitest'
import { logsSchema, MAX_LOG_ENTRIES, MAX_LOG_MESSAGE, renderLogsSection, sanitiseLogs } from './logs'

const entry = (message: string, level: 'error' | 'network' = 'error') => ({ level, message, ts: '10:00:00' })

describe('logsSchema', () => {
  it('accepts captured entries and an absent list', () => {
    expect(logsSchema.safeParse([entry('boom')]).success).toBe(true)
    expect(logsSchema.safeParse(undefined).success).toBe(true)
  })

  it('rejects an unknown level and an oversized list', () => {
    expect(logsSchema.safeParse([{ level: 'info', message: 'x' }]).success).toBe(false)
    expect(logsSchema.safeParse(Array.from({ length: 101 }, () => entry('x'))).success).toBe(false)
  })
})

describe('sanitiseLogs', () => {
  it('returns an empty list for nothing', () => {
    expect(sanitiseLogs(null)).toEqual([])
    expect(sanitiseLogs([])).toEqual([])
  })

  it('keeps only the most recent entries', () => {
    const logs = Array.from({ length: MAX_LOG_ENTRIES + 5 }, (_, i) => entry(`m${i}`))
    const out = sanitiseLogs(logs)
    expect(out).toHaveLength(MAX_LOG_ENTRIES)
    expect(out[0]?.message).toBe('m5')
    expect(out.at(-1)?.message).toBe(`m${MAX_LOG_ENTRIES + 4}`)
  })

  it('truncates long messages and flattens newlines', () => {
    const [out] = sanitiseLogs([entry(`line1\nline2 ${'x'.repeat(2000)}`.slice(0, 2000))])
    expect(out?.message.length).toBe(MAX_LOG_MESSAGE)
    expect(out?.message).not.toContain('\n')
  })

  it('cannot break out of the code fence it is rendered in', () => {
    const out = sanitiseLogs([entry('``` \n# Injected heading\n```')])
    const section = renderLogsSection(out)
    // Exactly the two fences the renderer wrote.
    expect(section.match(/```/g)).toHaveLength(2)
  })
})

describe('renderLogsSection', () => {
  it('renders nothing when there are no logs', () => {
    expect(renderLogsSection([])).toBe('')
  })

  it('renders a collapsed block with level and time', () => {
    const section = renderLogsSection(sanitiseLogs([entry('GET /api/save 500', 'network')]))
    expect(section).toContain('<details>')
    expect(section).toContain('(1)')
    expect(section).toContain('10:00:00 [network] GET /api/save 500')
  })
})
