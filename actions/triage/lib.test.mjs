import { describe, it, expect, vi } from 'vitest'
import { parseStructuredBlock, buildComment, deriveLabels, ntfyServerAndTopic, buildUserMessage, houseStyle, applyHouseStyle, resolveAuthMode, buildAnthropicClientOptions, ANTHROPIC_OIDC_AUDIENCE, signApprovalToken, verifyApprovalToken, APPROVAL_TOKEN_TTL_SECONDS } from './lib.mjs'

const block = (json) => `<!-- bugpilot:structured\n${json}\nbugpilot:end -->`

describe('parseStructuredBlock', () => {
  it('parses the structured block out of an issue body', () => {
    const body = `## What happened\n\nstuff\n\n${block('{"type":"bug","projectName":"X"}')}\n`
    expect(parseStructuredBlock(body)).toEqual({ type: 'bug', projectName: 'X' })
  })

  it('takes the LAST block when user text smuggled an earlier one in', () => {
    const body = `${block('{"type":"feature"}')}\n\nreal report\n\n${block('{"type":"bug"}')}\n`
    expect(parseStructuredBlock(body)).toEqual({ type: 'bug' })
  })

  it('returns null for a missing block, an empty body, and invalid JSON', () => {
    expect(parseStructuredBlock('no block here')).toBeNull()
    expect(parseStructuredBlock('')).toBeNull()
    expect(parseStructuredBlock(null)).toBeNull()
    expect(parseStructuredBlock(block('{nope'))).toBeNull()
  })
})

describe('deriveLabels', () => {
  it('maps classification and severity to labels', () => {
    expect(deriveLabels({ classification: 'bug', severity: 'high' }))
      .toEqual(['triage:confirmed-bug', 'severity:high'])
  })

  it('returns nothing for an unknown classification with no severity', () => {
    expect(deriveLabels({ classification: 'mystery' })).toEqual([])
  })
})

describe('buildComment', () => {
  it('renders classification, severity, fix and quoted draft', () => {
    const c = buildComment({
      classification: 'bug',
      severity: 'medium',
      reproducible: true,
      proposed_fix: 'Guard the null',
      response_draft: 'Thanks!\nWe are on it.',
    })
    expect(c).toContain('### bugpilot triage')
    expect(c).toContain('**Classification:** Bug')
    expect(c).toContain('**Severity:** medium')
    expect(c).toContain('**Proposed fix:** Guard the null')
    expect(c).toContain('> Thanks!\n> We are on it.')
  })
})

describe('ntfyServerAndTopic', () => {
  it('accepts a bare slug, a host/path, and a full URL', () => {
    expect(ntfyServerAndTopic('my-topic')).toEqual({ server: 'https://ntfy.sh', topic: 'my-topic' })
    expect(ntfyServerAndTopic('ntfy.example.com/bugs')).toEqual({ server: 'https://ntfy.example.com', topic: 'bugs' })
    expect(ntfyServerAndTopic('https://ntfy.sh/other')).toEqual({ server: 'https://ntfy.sh', topic: 'other' })
  })
})

describe('buildUserMessage', () => {
  it('includes issue number, title, body and the structured JSON when present', () => {
    const msg = buildUserMessage({ number: 7, title: 'T', body: 'B' }, { type: 'bug' })
    expect(msg).toContain('Issue #7: T')
    expect(msg).toContain('"type": "bug"')
  })
})

describe('houseStyle', () => {
  it('replaces em and en dashes with a comma and one space', () => {
    expect(houseStyle('You are right — on a narrow viewport it scrolls')).toBe('You are right, on a narrow viewport it scrolls')
    expect(houseStyle('fix–verify loop')).toBe('fix, verify loop')
    expect(houseStyle('a—b')).toBe('a, b')
  })

  it('turns sentence-ending exclamation marks into full stops', () => {
    expect(houseStyle('Thanks for reporting this! We are on it!!')).toBe('Thanks for reporting this. We are on it.')
    expect(houseStyle('(great catch!)')).toBe('(great catch.)')
  })

  it('does not double up punctuation when a dash follows a comma or colon', () => {
    expect(houseStyle('Note: — the widget')).toBe('Note: the widget')
    expect(houseStyle('however, — it works')).toBe('however, it works')
  })

  it('leaves compliant text alone, including hyphens and mid-word marks', () => {
    const clean = 'The tab-widget code window overflows: it needs a resize handle (see #208).'
    expect(houseStyle(clean)).toBe(clean)
    expect(houseStyle('a!b')).toBe('a!b')
  })

  it('passes non-strings through untouched', () => {
    expect(houseStyle(null)).toBeNull()
    expect(houseStyle(undefined)).toBeUndefined()
  })

  it('control: the guard must change the real Groundwork#268 draft, so a broken guard is caught', () => {
    const offending = 'You\'re right — on a narrow viewport the code window falls back to internal scrolling. Keep the great feedback coming!'
    const out = houseStyle(offending)
    expect(out).not.toBe(offending)
    expect(out).not.toMatch(/[—–!]/)
  })
})

describe('applyHouseStyle', () => {
  it('rewrites the prose fields and leaves the rest of the triage object alone', () => {
    const triage = {
      classification: 'bug',
      severity: 'high',
      reproducible: true,
      proposed_fix: 'Use a resizable container — not internal scrolling',
      response_draft: 'Understood!',
    }
    expect(applyHouseStyle(triage)).toEqual({
      classification: 'bug',
      severity: 'high',
      reproducible: true,
      proposed_fix: 'Use a resizable container, not internal scrolling',
      response_draft: 'Understood.',
    })
  })

  it('tolerates missing prose fields and non-object input', () => {
    expect(applyHouseStyle({ classification: 'spam' })).toEqual({ classification: 'spam' })
    expect(applyHouseStyle(null)).toBeNull()
  })
})

const FED = {
  federationRuleId: 'fdrl_test',
  organizationId: '00000000-0000-0000-0000-000000000000',
  serviceAccountId: 'svac_test',
}

describe('resolveAuthMode', () => {
  it('prefers federation when all three federation inputs are present', () => {
    expect(resolveAuthMode({ ...FED, apiKey: 'sk-ant-x' }).mode).toBe('federation')
  })

  it('falls back to the API key when no federation input is set', () => {
    expect(resolveAuthMode({ apiKey: 'sk-ant-x', federationRuleId: '', organizationId: '' }))
      .toEqual({ mode: 'api-key', apiKey: 'sk-ant-x' })
  })

  it('fails closed on a partial federation config instead of falling back to the key', () => {
    expect(() => resolveAuthMode({ apiKey: 'sk-ant-x', federationRuleId: 'fdrl_test' }))
      .toThrow(/partially configured: missing organizationId, serviceAccountId/)
  })

  it('throws when neither credential is available', () => {
    expect(() => resolveAuthMode({})).toThrow(/No Anthropic credentials/)
  })
})

describe('buildAnthropicClientOptions', () => {
  it('returns a plain apiKey option in api-key mode', () => {
    const { options, mode } = buildAnthropicClientOptions({ apiKey: 'sk-ant-x' })
    expect(mode).toBe('api-key')
    expect(options).toEqual({ apiKey: 'sk-ant-x' })
  })

  it('exchanges a fresh GitHub OIDC token for an Anthropic access token via the jwt-bearer grant', async () => {
    const calls = []
    let n = 0
    const getIDToken = vi.fn(async (aud) => `jwt-${++n}-for-${aud}`)
    const fetch = vi.fn(async (url, init) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ access_token: 'sk-ant-oat01-short', expires_in: 600, token_type: 'Bearer' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    const { options, mode } = buildAnthropicClientOptions({ ...FED, workspaceId: 'wrkspc_1' }, { getIDToken, fetch })
    expect(mode).toBe('federation')
    // apiKey: null keeps a stray ANTHROPIC_API_KEY on the runner from outranking federation.
    expect(options.apiKey).toBeNull()

    const first = await options.credentials()
    expect(first.token).toBe('sk-ant-oat01-short')
    expect(first.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000) + 500)

    expect(getIDToken).toHaveBeenCalledWith(ANTHROPIC_OIDC_AUDIENCE)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/oauth/token')
    expect(calls[0].init.method).toBe('POST')
    expect(JSON.parse(calls[0].init.body)).toEqual({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: 'jwt-1-for-https://api.anthropic.com',
      federation_rule_id: 'fdrl_test',
      organization_id: '00000000-0000-0000-0000-000000000000',
      service_account_id: 'svac_test',
      workspace_id: 'wrkspc_1',
    })

    // A second exchange must present a NEW GitHub JWT (jti is single-use server-side).
    await options.credentials()
    expect(JSON.parse(calls[1].init.body).assertion).toBe('jwt-2-for-https://api.anthropic.com')
  })

  it('surfaces a denied exchange as an error rather than a token', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'Authentication failed' } }), { status: 401 }))
    const { options } = buildAnthropicClientOptions(FED, { getIDToken: async () => 'jwt', fetch })
    await expect(options.credentials()).rejects.toThrow(/status 401/)
  })

  it('fails when GitHub hands back an empty OIDC token (id-token: write missing)', async () => {
    const fetch = vi.fn()
    const { options } = buildAnthropicClientOptions(FED, { getIDToken: async () => '', fetch })
    await expect(options.credentials()).rejects.toThrow(/id-token: write/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('control: the mocked endpoint is actually consulted, so an unreachable exchange is not reported as success', async () => {
    const fetch = vi.fn(async () => { throw new Error('ECONNREFUSED') })
    const { options } = buildAnthropicClientOptions(FED, { getIDToken: async () => 'jwt', fetch })
    await expect(options.credentials()).rejects.toThrow(/Failed to reach token endpoint/)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

// Issue #60: the raw webhook secret must never appear in the NTFY Approve
// action, since the notification payload (including its action headers) is
// legible to anyone who can read the topic. A signed, expiring, issue-scoped
// token stands in for it. These tests are the defence for that: the control
// case proves the secret genuinely never appears in the wire value, and the
// tamper cases prove the signature actually binds every field it claims to.
describe('signApprovalToken / verifyApprovalToken', () => {
  const secret = 'wh-secret-do-not-leak-me'
  const params = { webhookSecret: secret, owner: 'rodlunt', repo: 'br360', issueNumber: 42 }

  it('round-trips: a freshly signed token verifies and returns the same fields', async () => {
    const token = await signApprovalToken(params)
    const result = await verifyApprovalToken({ token, webhookSecret: secret })
    expect(result).toEqual({ owner: 'rodlunt', repo: 'br360', issueNumber: 42, exp: expect.any(Number) })
  })

  it('control: the raw secret never appears as a substring of the token sent to NTFY', async () => {
    const token = await signApprovalToken(params)
    expect(token).not.toContain(secret)
    // and not just plain-text: not even the base64url encoding of it, which
    // would be an equally bad leak dressed up as an encoding.
    const secretB64 = Buffer.from(secret).toString('base64url')
    expect(token).not.toContain(secretB64)
  })

  it('rejects a token signed with a different secret', async () => {
    const token = await signApprovalToken(params)
    expect(await verifyApprovalToken({ token, webhookSecret: 'wrong-secret' })).toBeNull()
  })

  it('rejects a token whose issue number was tampered with after signing', async () => {
    const token = await signApprovalToken(params)
    const [payloadB64, sigB64] = token.split('.')
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString())
    const tamperedPayload = Buffer.from(JSON.stringify({ ...payload, n: 999 })).toString('base64url')
    const tampered = `${tamperedPayload}.${sigB64}`
    expect(await verifyApprovalToken({ token: tampered, webhookSecret: secret })).toBeNull()
  })

  it('rejects a token whose owner/repo was tampered with, so a leaked token cannot be redirected to another repo', async () => {
    const token = await signApprovalToken(params)
    const [payloadB64, sigB64] = token.split('.')
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString())
    const tamperedPayload = Buffer.from(JSON.stringify({ ...payload, r: 'some-other-repo' })).toString('base64url')
    const tampered = `${tamperedPayload}.${sigB64}`
    expect(await verifyApprovalToken({ token: tampered, webhookSecret: secret })).toBeNull()
  })

  it('rejects an expired token', async () => {
    const now = Date.now()
    const token = await signApprovalToken({ ...params, now, ttlSeconds: 10 })
    const stillValid = await verifyApprovalToken({ token, webhookSecret: secret, now: now + 9_000 })
    expect(stillValid).not.toBeNull()
    const expired = await verifyApprovalToken({ token, webhookSecret: secret, now: now + 10_001 })
    expect(expired).toBeNull()
  })

  it('defaults to a 48 hour TTL', async () => {
    expect(APPROVAL_TOKEN_TTL_SECONDS).toBe(60 * 60 * 48)
  })

  it('rejects malformed tokens instead of throwing: wrong shape, bad base64, non-JSON payload, missing fields', async () => {
    for (const bad of ['', 'no-dot-here', 'a.b.c', 'not-base64!!.zzz', `${Buffer.from('not json').toString('base64url')}.sig`]) {
      expect(await verifyApprovalToken({ token: bad, webhookSecret: secret })).toBeNull()
    }
    const incomplete = Buffer.from(JSON.stringify({ o: 'rodlunt' })).toString('base64url')
    expect(await verifyApprovalToken({ token: `${incomplete}.sig`, webhookSecret: secret })).toBeNull()
  })
})
