// Pure helpers, extracted so they can be unit-tested: index.mjs executes
// run() on import, which makes it untestable directly.

import { oidcFederationProvider } from '@anthropic-ai/sdk/lib/credentials/oidc-federation'

export function parseStructuredBlock(body) {
  if (!body) return null
  // Take the LAST match: the worker appends the genuine block at the end of
  // the issue body, so a marker smuggled into user-supplied text (which sits
  // above it) can never shadow it. The worker also neutralises the markers
  // in user text; this is the parser-side half of the same defence.
  const matches = [...body.matchAll(/<!-- bugpilot:structured\n([\s\S]*?)\nbugpilot:end -->/g)]
  if (!matches.length) return null
  try {
    return JSON.parse(matches[matches.length - 1][1])
  } catch {
    return null
  }
}

export function buildUserMessage(issue, structured) {
  const structuredBlock = structured
    ? `\n\nMachine-readable context:\n\`\`\`json\n${JSON.stringify(structured, null, 2)}\n\`\`\``
    : ''

  return `Issue #${issue.number}: ${issue.title}\n\n${issue.body}${structuredBlock}`
}

export function buildComment(triage) {
  const lines = ['### bugpilot triage', '']

  const classLabel = {
    bug: 'Bug',
    feature: 'Feature request',
    'not-feasible': 'Not feasible',
    spam: 'Spam',
    'needs-info': 'Needs more information',
  }[triage.classification] ?? triage.classification

  lines.push(`**Classification:** ${classLabel}`)

  if (triage.severity) {
    lines.push(`**Severity:** ${triage.severity}`)
  }
  if (triage.reproducible !== undefined && triage.reproducible !== null) {
    lines.push(`**Reproducible:** ${triage.reproducible ? 'Yes' : 'Unclear from report'}`)
  }
  if (triage.proposed_fix) {
    lines.push('', `**Proposed fix:** ${triage.proposed_fix}`)
  }
  if (triage.response_draft) {
    lines.push('', '**Draft response to reporter:**', '')
    lines.push(`> ${triage.response_draft.replace(/\n/g, '\n> ')}`)
  }

  return lines.join('\n')
}

export function deriveLabels(triage) {
  const labels = []
  const classMap = {
    bug: 'triage:confirmed-bug',
    feature: 'triage:feature-request',
    'not-feasible': 'triage:not-feasible',
    spam: 'triage:spam',
    'needs-info': 'triage:needs-info',
  }
  if (classMap[triage.classification]) labels.push(classMap[triage.classification])
  if (triage.severity) labels.push(`severity:${triage.severity}`)
  return labels
}

// Approval tokens for the ntfy "Approve" webhook callback.
//
// WEBHOOK_SECRET must never travel through the notification itself: the
// ntfy "http" action's headers are part of the message payload published to
// the topic, so anyone who can read that topic (a public ntfy.sh topic has
// no read control at all) could lift a raw shared secret and replay it
// against the Worker indefinitely, for any issue. Instead the Approve
// button carries a signed, expiring, issue-scoped token: HMAC-SHA256 over
// `{owner, repo, issueNumber, exp}`, keyed by WEBHOOK_SECRET. Leaking the
// token only buys an attacker a POST that re-runs apply-fix on the one
// issue it was minted for, and only until it expires: it is never a
// reusable credential the way the raw secret was.
//
// Wire format (canonical; the Worker's independent verify implementation in
// backend/src/index.ts must produce/accept byte-identical tokens for the
// same input):
//   `${base64url(JSON.stringify({o, r, n, exp}))}.${base64url(HMAC-SHA256(webhookSecret, thatPayload))}`
export const APPROVAL_TOKEN_TTL_SECONDS = 60 * 60 * 48 // 48h: long enough to notice and tap Approve, short enough to bound a leak.

function base64UrlEncode(bytes) {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlDecode(str) {
  const pad = (4 - (str.length % 4)) % 4
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function hmacKey(secret, usages) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usages,
  )
}

export async function signApprovalToken({
  webhookSecret,
  owner,
  repo,
  issueNumber,
  now = Date.now(),
  ttlSeconds = APPROVAL_TOKEN_TTL_SECONDS,
}) {
  const payload = { o: owner, r: repo, n: issueNumber, exp: Math.floor(now / 1000) + ttlSeconds }
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)))
  const key = await hmacKey(webhookSecret, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64))
  return `${payloadB64}.${base64UrlEncode(new Uint8Array(sig))}`
}

// Returns the verified payload, or null on anything wrong: malformed token,
// bad signature, or expiry. Never throws, so a caller can treat null as a
// flat 401 without a try/catch of its own.
export async function verifyApprovalToken({ token, webhookSecret, now = Date.now() }) {
  if (typeof token !== 'string' || !token) return null
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [payloadB64, sigB64] = parts

  let payload
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64)))
  } catch {
    return null
  }
  if (
    typeof payload !== 'object' || payload === null ||
    typeof payload.o !== 'string' || !payload.o ||
    typeof payload.r !== 'string' || !payload.r ||
    !Number.isInteger(payload.n) || payload.n <= 0 ||
    !Number.isInteger(payload.exp)
  ) {
    return null
  }

  let sigBytes
  try {
    sigBytes = base64UrlDecode(sigB64)
  } catch {
    return null
  }

  const key = await hmacKey(webhookSecret, ['verify'])
  const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(payloadB64))
  if (!valid) return null
  if (Math.floor(now / 1000) >= payload.exp) return null

  return { owner: payload.o, repo: payload.r, issueNumber: payload.n, exp: payload.exp }
}

export function ntfyServerAndTopic(topicUrl) {
  let resolved = topicUrl
  if (!resolved.includes('://')) {
    const firstSegment = resolved.split('/')[0]
    resolved = firstSegment.includes('.') ? `https://${resolved}` : `https://ntfy.sh/${resolved}`
  }
  const u = new URL(resolved)
  return { server: `${u.protocol}//${u.host}`, topic: u.pathname.replace(/^\//, '') }
}

// House style guard for prose the model produces. The system prompt asks
// for Australian English, no em or en dashes and no exclamation marks, but
// the model does not always comply, so the mechanical part is enforced
// here. A dash is replaced with ", " (a comma or colon rewrite cannot be
// done mechanically, and a comma reads correctly in almost every case) and
// a sentence-ending exclamation mark becomes a full stop. Banned words are
// not rewritten: there is no safe mechanical substitute for a word, so the
// prompt is the only defence for those.
export function houseStyle(text) {
  if (typeof text !== 'string') return text
  return text
    // A spaced dash ("a — b", "a – b") collapses to a comma with one space.
    .replace(/\s*[—–]\s*/g, ', ')
    // A comma we just produced directly after another comma or a colon
    // is noise: "however, , b" and "note: , b".
    .replace(/([,:])\s*,\s+/g, '$1 ')
    // A run of exclamation marks at the end of a sentence becomes one full stop.
    .replace(/!+(?=\s|$|["')\]])/g, '.')
}

export function applyHouseStyle(triage) {
  if (!triage || typeof triage !== 'object') return triage
  const out = { ...triage }
  for (const key of ['proposed_fix', 'response_draft']) {
    if (typeof out[key] === 'string') out[key] = houseStyle(out[key])
  }
  return out
}

// Credential resolution: workload identity federation first, API key as
// the fallback. See README "Using workload identity federation".
//
// The four federation inputs travel together. A partial set is a
// misconfiguration and throws rather than quietly falling back to the key,
// because a silent fallback is exactly the kind of failure that looks like
// success (the job goes green on a key the consumer thought they had
// retired). Only when none of the federation inputs is present does the
// API key get used, and when that is absent too the action stops.


// The audience the GitHub OIDC token is requested with. It must match the
// federation rule's match.audience in the Claude Console.
export const ANTHROPIC_OIDC_AUDIENCE = 'https://api.anthropic.com'

export function resolveAuthMode(inputs) {
  const federation = {
    federationRuleId: inputs.federationRuleId || '',
    organizationId: inputs.organizationId || '',
    serviceAccountId: inputs.serviceAccountId || '',
    workspaceId: inputs.workspaceId || '',
  }
  const required = ['federationRuleId', 'organizationId', 'serviceAccountId']
  const present = required.filter((k) => federation[k])
  if (present.length === required.length) return { mode: 'federation', federation }
  if (present.length > 0) {
    const missing = required.filter((k) => !federation[k])
    throw new Error(
      `Workload identity federation is partially configured: missing ${missing.join(', ')}. ` +
        'Supply all of anthropic-federation-rule-id, anthropic-organization-id and anthropic-service-account-id, or none of them.',
    )
  }
  if (inputs.apiKey) return { mode: 'api-key', apiKey: inputs.apiKey }
  throw new Error(
    'No Anthropic credentials: set anthropic-api-key, or the three workload identity federation inputs ' +
      '(and grant the job id-token: write).',
  )
}

// Returns the options object to pass to `new Anthropic(...)`. `getIDToken`
// is @actions/core's getIDToken (injected so tests can stub it) and `fetch`
// is the fetch the SDK's exchange should use (injected so tests can mock
// the token endpoint). A fresh GitHub JWT is requested on every exchange:
// GitHub tokens carry a jti and Anthropic rejects a re-presented one, so
// caching the JWT across refreshes would break long jobs.
export function buildAnthropicClientOptions(inputs, { getIDToken, fetch: fetchImpl = globalThis.fetch, baseURL } = {}) {
  const resolved = resolveAuthMode(inputs)
  if (resolved.mode === 'api-key') return { options: { apiKey: resolved.apiKey }, mode: 'api-key' }

  if (typeof getIDToken !== 'function') {
    throw new Error('getIDToken is required for workload identity federation')
  }
  const f = resolved.federation
  const apiBase = (baseURL || process.env.ANTHROPIC_BASE_URL || ANTHROPIC_OIDC_AUDIENCE).replace(/\/+$/, '')
  const credentials = oidcFederationProvider({
    identityTokenProvider: async () => {
      const jwt = await getIDToken(ANTHROPIC_OIDC_AUDIENCE)
      if (!jwt) {
        throw new Error(
          'GitHub returned an empty OIDC token. Check the job has `permissions: id-token: write`.',
        )
      }
      return jwt
    },
    federationRuleId: f.federationRuleId,
    organizationId: f.organizationId,
    serviceAccountId: f.serviceAccountId,
    workspaceId: f.workspaceId || undefined,
    baseURL: apiBase,
    fetch: fetchImpl,
  })
  // apiKey: null stops the SDK reading ANTHROPIC_API_KEY from the runner
  // environment, which would otherwise outrank the credentials provider.
  return { options: { apiKey: null, credentials }, mode: 'federation' }
}
