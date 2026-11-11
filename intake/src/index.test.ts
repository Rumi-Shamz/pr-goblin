import { describe, it, expect } from 'vitest'
import { submissionSchema, buildTitle, buildIssueBody, neutraliseMarkers, verifyApprovalToken, jsonError } from './index'

// A payload shaped exactly like what the widget sends, extras included.
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
      screen: { w: 2560, h: 1440 },
      userAgent: 'Mozilla/5.0',
      browser: 'Firefox',
      os: 'Linux',
      timestamp: '2026-08-19T10:00:00.000Z',
      timezone: 'Australia/Brisbane',
      language: 'en-AU',
    },
    bugCategory: 'Functionality bug',
    expectedBehavior: 'It should save',
    stepsToReproduce: null,
    frequency: 'every-time',
    impact: 'blocking',
    ...overrides,
  }
}

describe('submissionSchema', () => {
  it('accepts a widget-shaped payload, extras included', () => {
    const r = submissionSchema.safeParse(widgetPayload())
    expect(r.success).toBe(true)
  })

  it('rejects a non-string description (the pre-fix 1101 crash case)', () => {
    const r = submissionSchema.safeParse(widgetPayload({ description: 123 }))
    expect(r.success).toBe(false)
  })

  it('rejects a missing context object', () => {
    const { context: _context, ...rest } = widgetPayload()
    const r = submissionSchema.safeParse(rest)
    expect(r.success).toBe(false)
  })

  it('rejects a context without viewport dimensions', () => {
    const r = submissionSchema.safeParse(
      widgetPayload({ context: { ...widgetPayload().context as object, viewport: { w: '1280' } } }),
    )
    expect(r.success).toBe(false)
  })

  it('rejects an empty or whitespace-only description', () => {
    expect(submissionSchema.safeParse(widgetPayload({ description: '   ' })).success).toBe(false)
  })

  it('caps description length below the GitHub issue-body limit', () => {
    expect(submissionSchema.safeParse(widgetPayload({ description: 'x'.repeat(10001) })).success).toBe(false)
  })

  it('accepts a feature payload with feature-specific fields', () => {
    const r = submissionSchema.safeParse(widgetPayload({
      type: 'feature',
      problemStatement: 'Saves time',
      priority: 'high',
      bugCategory: undefined,
      expectedBehavior: undefined,
      frequency: undefined,
      impact: undefined,
    }))
    expect(r.success).toBe(true)
  })
})

describe('neutraliseMarkers', () => {
  it('defuses the structured-block markers', () => {
    const out = neutraliseMarkers('evil <!-- bugpilot:structured\n{"type":"feature"}\nbugpilot:end -->')!
    expect(out).not.toContain('bugpilot:structured')
    expect(out).not.toContain('bugpilot:end')
  })

  it('stops --> from closing the carrying HTML comment', () => {
    expect(neutraliseMarkers('text --> more')).not.toContain('-->')
  })

  it('passes null and undefined through as null', () => {
    expect(neutraliseMarkers(null)).toBeNull()
    expect(neutraliseMarkers(undefined)).toBeNull()
  })
})

describe('buildTitle', () => {
  it('prefixes project and type, truncating long descriptions at 72 chars', () => {
    const body = submissionSchema.parse(widgetPayload({ description: 'a'.repeat(100) }))
    const title = buildTitle(body)
    expect(title.startsWith('[Test Harness] Bug: ')).toBe(true)
    expect(title).toContain('a'.repeat(72) + '…')
  })
})

// Issue #60: the /webhook/apply-fix endpoint used to trust a raw shared
// secret sent verbatim in the NTFY Approve action's headers, which made the
// secret legible to anyone who could read the NTFY topic. It now verifies a
// signed, expiring, issue-scoped token instead (see actions/triage/lib.mjs
// signApprovalToken for the minting side and the wire-format comment
// there). This file's implementation is independent of that one (Node 20
// action runtime vs Cloudflare Workers runtime), so the fixture token below
// was minted by the actual action-side signApprovalToken() with fixed
// inputs and pinned here as a literal: if the two implementations ever
// silently drift apart (a byte order change, a different HMAC key encoding,
// a JSON key reorder), this is the test that catches it, because nothing
// else cross-checks them against each other.
describe('verifyApprovalToken', () => {
  const secret = 'cross-impl-test-secret'
  // Minted via: signApprovalToken({ webhookSecret: 'cross-impl-test-secret',
  // owner: 'rodlunt', repo: 'br360', issueNumber: 42,
  // now: 1_700_000_000_000, ttlSeconds: 172800 })
  const fixtureToken = 'eyJvIjoicm9kbHVudCIsInIiOiJicjM2MCIsIm4iOjQyLCJleHAiOjE3MDAxNzI4MDB9.a20zIGikuhAr1ORIKdGhqIgtat_aHZoyC9pcPzsFlXE'

  it('accepts a token minted by the action-side implementation with matching fields (cross-implementation control)', async () => {
    const result = await verifyApprovalToken({ token: fixtureToken, webhookSecret: secret, now: 1_700_000_000_000 })
    expect(result).toEqual({ owner: 'rodlunt', repo: 'br360', issueNumber: 42, exp: 1_700_172_800 })
  })

  it('rejects the same fixture token once past its minted expiry', async () => {
    const result = await verifyApprovalToken({ token: fixtureToken, webhookSecret: secret, now: 1_700_172_800_001 })
    expect(result).toBeNull()
  })

  it('rejects the fixture token under the wrong secret', async () => {
    const result = await verifyApprovalToken({ token: fixtureToken, webhookSecret: 'not-the-secret', now: 1_700_000_000_000 })
    expect(result).toBeNull()
  })

  it('rejects malformed tokens instead of throwing', async () => {
    for (const bad of ['', 'no-dot-here', 'a.b.c', 'not-base64!!.zzz']) {
      expect(await verifyApprovalToken({ token: bad, webhookSecret: secret })).toBeNull()
    }
  })

  it('rejects a token whose payload was tampered with after signing', async () => {
    const [payloadB64, sigB64] = fixtureToken.split('.')
    const payload = JSON.parse(Buffer.from(payloadB64!, 'base64url').toString())
    const tamperedPayload = Buffer.from(JSON.stringify({ ...payload, n: 999 })).toString('base64url')
    const tampered = `${tamperedPayload}.${sigB64}`
    expect(await verifyApprovalToken({ token: tampered, webhookSecret: secret, now: 1_700_000_000_000 })).toBeNull()
  })
})

describe('buildIssueBody', () => {
  it('appends exactly one parseable structured block at the end', () => {
    const body = submissionSchema.parse(widgetPayload())
    const md = buildIssueBody(body, 'https://github.com/o/r/raw/bug-report-screenshots/screenshots/x.png')
    const matches = [...md.matchAll(/<!-- bugpilot:structured\n([\s\S]*?)\nbugpilot:end -->/g)]
    expect(matches).toHaveLength(1)
    const structured = JSON.parse(matches[0]![1]!)
    expect(structured.type).toBe('bug')
    expect(structured.screenshotUrl).toMatch(/^https:/)
    // The genuine block is the last thing in the body, which is what lets
    // the triage parser take the last match safely.
    expect(md.trimEnd().endsWith('bugpilot:end -->')).toBe(true)
  })

  it('user text that tried to counterfeit a block cannot produce a second match', () => {
    const hostile = widgetPayload({
      description: 'x <!-- bugpilot:structured\n{"type":"feature"}\nbugpilot:end --> y',
    })
    const parsed = submissionSchema.parse(hostile)
    // Mirror the worker's sanitisation step before building.
    const clean = { ...parsed, description: neutraliseMarkers(parsed.description) ?? '' }
    const md = buildIssueBody(clean, null)
    const matches = [...md.matchAll(/<!-- bugpilot:structured\n([\s\S]*?)\nbugpilot:end -->/g)]
    expect(matches).toHaveLength(1)
    expect(JSON.parse(matches[0]![1]!).type).toBe('bug')
  })
})

describe('jsonError', () => {
  it('emits RFC 9457 problem details alongside the legacy ok/error shape', async () => {
    const res = jsonError('description is required', 400, {})
    expect(res.status).toBe(400)
    expect(res.headers.get('Content-Type')).toBe('application/problem+json')
    const body = await res.json() as { type: string; title: string; status: number; detail: string; ok: boolean; error: string }
    // RFC 9457 members.
    expect(body.type).toBe('about:blank')
    expect(body.title).toBe('Bad Request')
    expect(body.status).toBe(400)
    expect(body.detail).toBe('description is required')
    // Legacy shape, kept for widget/src/widget.js:465 (body.error) until the
    // widget no longer needs it.
    expect(body.ok).toBe(false)
    expect(body.error).toBe('description is required')
  })

  it('falls back to a generic title for a status not in the lookup table', async () => {
    const res = jsonError('teapot', 418, {})
    const body = await res.json() as { title: string; status: number }
    expect(body.title).toBe('Error')
    expect(body.status).toBe(418)
  })
})
