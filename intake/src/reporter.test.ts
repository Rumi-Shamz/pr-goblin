import { describe, it, expect } from 'vitest'
import { submissionSchema, buildIssueBody, formatReporter, reporterStructured } from './index'

function widgetPayload(overrides: Record<string, unknown> = {}) {
  return {
    type: 'bug',
    description: 'The save button does nothing',
    screenshot: null,
    projectName: 'Test Harness',
    context: {
      url: 'https://example.com/app',
      referrer: null,
      viewport: { w: 1280, h: 800 },
      userAgent: 'Mozilla/5.0',
      browser: 'Firefox',
      os: 'Linux',
      timestamp: '2026-08-19T10:00:00.000Z',
    },
    expectedBehavior: 'It should save',
    frequency: 'every-time',
    impact: 'blocking',
    ...overrides,
  }
}

describe('reporter (optional user identity)', () => {
  it('schema accepts a payload with no user at all (BR360 unchanged)', () => {
    const r = submissionSchema.safeParse(widgetPayload())
    expect(r.success).toBe(true)
    expect(r.success && r.data.user).toBeUndefined()
  })

  it('schema strips angle brackets and caps each field at 120 chars', () => {
    const r = submissionSchema.safeParse(widgetPayload({
      user: { name: '<b>Ada</b> Lovelace', login: 'ada' },
    }))
    expect(r.success).toBe(true)
    expect(r.success && r.data.user).toEqual({ name: 'bAda/b Lovelace', login: 'ada' })
    const long = submissionSchema.safeParse(widgetPayload({ user: { name: 'x'.repeat(121) } }))
    expect(long.success).toBe(false)
  })

  it('renders a **Reporter:** login (name) line after the environment table and reporter in the JSON block', () => {
    const parsed = submissionSchema.parse(widgetPayload({ user: { name: 'Ada Lovelace', login: 'ada' } }))
    const body = buildIssueBody(parsed, null)
    expect(body).toContain('| Project | Test Harness |\n\n**Reporter:** ada (Ada Lovelace)\n\n')
    const m = body.match(/<!-- bugpilot:structured\n([\s\S]*?)\nbugpilot:end -->/)
    expect(m).not.toBeNull()
    const json = JSON.parse(m![1])
    expect(json.reporter).toEqual({ name: 'Ada Lovelace', login: 'ada' })
    // Existing keys the triage action reads are still present (CLAUDE.md contract).
    for (const k of ['url', 'viewport', 'userAgent', 'browser', 'os', 'timestamp', 'projectName', 'screenshotUrl']) {
      expect(json).toHaveProperty(k)
    }
  })

  it('renders the feature body with the Reporter line too', () => {
    const parsed = submissionSchema.parse(widgetPayload({
      type: 'feature', description: 'Dark mode', priority: 'nice', user: { login: 'ada' },
    }))
    const body = buildIssueBody(parsed, null)
    expect(body).toContain('| Submitted | 2026-08-19T10:00:00.000Z |\n\n**Reporter:** ada\n\n')
    expect(body).toMatch(/"reporter":\{"name":null,"login":"ada"\}/)
  })

  it('omits the line and the reporter key entirely when there is no user', () => {
    const body = buildIssueBody(submissionSchema.parse(widgetPayload()), null)
    expect(body).not.toContain('Reporter')
    expect(body).not.toContain('"reporter"')
    // and the body is byte-identical to a payload with an empty user object
    const empty = buildIssueBody(submissionSchema.parse(widgetPayload({ user: { name: '', login: '' } })), null)
    expect(empty).toBe(body)
  })

  it('formatReporter composes login (name) and returns null for nothing', () => {
    expect(formatReporter({ name: 'Ada', login: 'ada' })).toBe('ada (Ada)')
    expect(formatReporter({ name: 'Ada', login: null })).toBe('Ada')
    expect(formatReporter({ name: null, login: 'ada' })).toBe('ada')
    expect(formatReporter({ name: '', login: '' })).toBeNull()
    expect(formatReporter(null)).toBeNull()
  })

  it('reporterStructured is undefined (so JSON omits it) without a user', () => {
    expect(reporterStructured(null)).toBeUndefined()
    expect(reporterStructured({ name: '', login: '' })).toBeUndefined()
    expect(reporterStructured({ name: 'Ada', login: null })).toEqual({ name: 'Ada', login: null })
  })
})
