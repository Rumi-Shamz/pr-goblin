import { z } from 'zod'

export interface Env {
  GITHUB_TOKEN: string
  GITHUB_REPO: string
  ALLOWED_ORIGIN: string
  WEBHOOK_SECRET?: string
  APPLY_FIX_WORKFLOW?: string
}

// Runtime schema for the /feedback payload. Presence-only guards proved
// insufficient: a non-string description reached .trim() and crashed as a
// Cloudflare 1101 (see CLAUDE.md operational gotcha 1). Length caps keep a
// hostile payload from blowing GitHub's 65k issue-body limit into a 502.
// Context is a loose object because the widget sends extras (screen size)
// that the worker does not consume.
export const contextSchema = z.looseObject({
  url: z.string().max(2000),
  viewport: z.object({ w: z.number(), h: z.number() }),
  userAgent: z.string().max(1000),
  browser: z.string().max(100),
  os: z.string().max(100),
  timestamp: z.string().max(100),
  timezone: z.string().max(100).nullish(),
  language: z.string().max(50).nullish(),
  referrer: z.string().max(2000).nullish(),
})

// Optional reporter identity from a signed-in host. Plain text only: angle
// brackets are stripped so a name cannot smuggle markup into the issue body.
const plainText = (max: number) =>
  z.string().max(max).transform((s) => s.replace(/[<>]/g, '').trim()).nullish()

export const userSchema = z.object({
  name: plainText(120),
  login: plainText(120),
}).nullish()

export const submissionSchema = z.object({
  type: z.enum(['bug', 'feature']).optional(),
  user: userSchema,
  description: z.string().trim().min(1, 'description is required').max(10000),
  screenshot: z.string().nullish(),
  projectName: z.string().max(200).nullish(),
  context: contextSchema,
  bugCategory: z.string().max(100).nullish(),
  expectedBehavior: z.string().max(10000).nullish(),
  stepsToReproduce: z.string().max(10000).nullish(),
  frequency: z.string().max(50).nullish(),
  impact: z.string().max(50).nullish(),
  problemStatement: z.string().max(10000).nullish(),
  priority: z.string().max(50).nullish(),
})

type SubmissionPayload = z.infer<typeof submissionSchema>

// Verifies the signed, expiring, issue-scoped approval token the ntfy
// "Approve" action presents to /webhook/apply-fix. Canonical wire format is
// defined once in actions/triage/lib.mjs (signApprovalToken /
// verifyApprovalToken): the two implementations are independent (Node 20
// action runtime vs Workers runtime) but must produce byte-identical tokens
// for the same input. index.test.ts pins a token minted by the action-side
// implementation as a literal fixture so the two cannot silently drift
// apart (see that file for why the secret is never sent over ntfy at all).
export interface ApprovalTokenPayload {
  owner: string
  repo: string
  issueNumber: number
  exp: number
}

function base64UrlDecode(str: string): Uint8Array {
  const pad = (4 - (str.length % 4)) % 4
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

// Never throws: any malformed, forged or expired token comes back as null
// so the caller can treat it as a flat 401 without its own try/catch.
export async function verifyApprovalToken(
  { token, webhookSecret, now = Date.now() }: { token: string; webhookSecret: string; now?: number },
): Promise<ApprovalTokenPayload | null> {
  if (!token) return null
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [payloadB64, sigB64] = parts as [string, string]

  let payload: unknown
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64)))
  } catch {
    return null
  }
  if (
    typeof payload !== 'object' || payload === null ||
    typeof (payload as Record<string, unknown>).o !== 'string' || !(payload as Record<string, unknown>).o ||
    typeof (payload as Record<string, unknown>).r !== 'string' || !(payload as Record<string, unknown>).r ||
    !Number.isInteger((payload as Record<string, unknown>).n) || ((payload as Record<string, unknown>).n as number) <= 0 ||
    !Number.isInteger((payload as Record<string, unknown>).exp)
  ) {
    return null
  }
  const p = payload as { o: string; r: string; n: number; exp: number }

  let sigBytes: Uint8Array
  try {
    sigBytes = base64UrlDecode(sigB64)
  } catch {
    return null
  }

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(webhookSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  )
  const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(payloadB64))
  if (!valid) return null
  if (Math.floor(now / 1000) >= p.exp) return null

  return { owner: p.o, repo: p.r, issueNumber: p.n, exp: p.exp }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Fail fast on missing configuration with a nameable error. Without this,
    // .split on an undefined env var throws on every request and surfaces as
    // an undiagnosable Cloudflare 1101 (CLAUDE.md operational gotcha 1).
    const fallbackCors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }
    for (const name of ['ALLOWED_ORIGIN', 'GITHUB_REPO', 'GITHUB_TOKEN'] as const) {
      if (!env[name]) {
        console.error(`[bugpilot] worker misconfigured: ${name} is not set`)
        return jsonError(`Worker misconfigured: ${name} is not set`, 500, fallbackCors)
      }
    }

    const requestOrigin = request.headers.get('Origin') ?? ''
    const allowed = env.ALLOWED_ORIGIN === '*' ? ['*'] : env.ALLOWED_ORIGIN.split(',').map(s => s.trim())
    const corsOrigin = allowed.includes('*') ? '*' : (allowed.includes(requestOrigin) ? requestOrigin : allowed[0])
    const corsHeaders = {
      'Access-Control-Allow-Origin': corsOrigin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders })
    }

    // Top-level error boundary: an uncaught throw here becomes a Cloudflare
    // 1101, which is indistinguishable from a dead GITHUB_TOKEN from outside.
    // Every unexpected failure must leave as logged, sanitised JSON instead.
    try {
      const url = new URL(request.url)

      if (request.method === 'POST' && url.pathname === '/feedback') {
        return await handleFeedback(request, env, corsHeaders)
      }

      if (request.method === 'POST' && url.pathname === '/webhook/apply-fix') {
        return await handleApplyFix(request, env, corsHeaders)
      }

      return new Response('Not found', { status: 404, headers: corsHeaders })
    } catch (err) {
      console.error('[bugpilot] unhandled error', err)
      return jsonError('Internal error', 500, corsHeaders)
    }
  },
}

async function handleFeedback(
  request: Request,
  env: Env,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return jsonError('Invalid JSON body', 400, corsHeaders)
  }

  // One schema validates the whole payload: types, presence and length caps.
  // Hand-rolled payloads (curl tests, third-party integrations) get a 400
  // naming every violating field instead of a generic Cloudflare 1101.
  const parsed = submissionSchema.safeParse(raw)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || 'payload'}: ${i.message}`)
      .join('; ')
    console.warn(`[bugpilot] /feedback validation failed (${request.headers.get('CF-Connecting-IP') ?? 'unknown ip'}): ${detail}`)
    return jsonError(`Invalid payload: ${detail}`, 400, corsHeaders)
  }
  // Neutralise the structured-block markers in user text so a submitter
  // cannot counterfeit the machine-readable block the triage action parses,
  // or break out of the HTML comment that carries the genuine one.
  const body: SubmissionPayload = {
    ...parsed.data,
    description: neutraliseMarkers(parsed.data.description) ?? '',
    projectName: neutraliseMarkers(parsed.data.projectName),
    bugCategory: neutraliseMarkers(parsed.data.bugCategory),
    expectedBehavior: neutraliseMarkers(parsed.data.expectedBehavior),
    stepsToReproduce: neutraliseMarkers(parsed.data.stepsToReproduce),
    problemStatement: neutraliseMarkers(parsed.data.problemStatement),
    user: parsed.data.user
      ? {
          name: neutraliseMarkers(parsed.data.user.name),
          login: neutraliseMarkers(parsed.data.user.login),
        }
      : null,
  }

  const [owner, repo] = env.GITHUB_REPO.split('/')
  if (!owner || !repo) {
    return jsonError('Worker misconfigured: GITHUB_REPO must be "owner/repo"', 500, corsHeaders)
  }

  let screenshotUrl: string | null = null
  if (body.screenshot) {
    if (body.screenshot.length > 4_000_000) {
      return jsonError('Screenshot exceeds maximum size', 413, corsHeaders)
    }
    screenshotUrl = await uploadScreenshot(body.screenshot, env)
  }

  const issueTitle = buildTitle(body)
  const issueBody = buildIssueBody(body, screenshotUrl)
  const labels = body.type === 'feature'
    ? ['user-feedback', 'enhancement']
    : ['user-feedback', 'bug']

  await ensureLabelsExist(owner, repo, labels, env.GITHUB_TOKEN)

  const issueRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'bugpilot-worker/0.1',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title: issueTitle, body: issueBody, labels }),
  })

  if (!issueRes.ok) {
    const err = await issueRes.text()
    console.error('[bugpilot] GitHub issue creation failed', issueRes.status, err)
    return jsonError('Failed to create GitHub issue', 502, corsHeaders)
  }

  const issue = await issueRes.json() as { html_url: string; number: number }

  return new Response(
    JSON.stringify({ ok: true, issueUrl: issue.html_url, issueNumber: issue.number }),
    { status: 201, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  )
}

async function handleApplyFix(
  request: Request,
  env: Env,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  if (!env.WEBHOOK_SECRET) {
    return jsonError('Apply-fix webhook not configured on this worker', 503, corsHeaders)
  }

  const token = request.headers.get('x-approval-token') ?? ''
  const approved = token ? await verifyApprovalToken({ token, webhookSecret: env.WEBHOOK_SECRET }) : null
  if (!approved) {
    // A missing, forged or expired token is the one probe on this worker
    // worth a trace: it is the sole gate on dispatching the apply-fix
    // workflow.
    console.warn(`[bugpilot] webhook auth failure from ${request.headers.get('CF-Connecting-IP') ?? 'unknown ip'}`)
    return jsonError('Unauthorized', 401, corsHeaders)
  }

  // owner/repo/issueNumber come from the verified token, not from the
  // request body: the token is the only thing here proven not to have been
  // forged, so it is the only thing that gets to decide what gets dispatched.
  const { owner, repo, issueNumber } = approved

  const [configOwner, configRepo] = env.GITHUB_REPO.split('/')
  if (owner !== configOwner || repo !== configRepo) {
    return jsonError('Repo mismatch', 403, corsHeaders)
  }

  const workflowFile = env.APPLY_FIX_WORKFLOW || 'apply-fix.yml'
  const dispatchRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowFile}/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'bugpilot-worker/0.1',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ref: 'main',
        inputs: { issue_number: String(issueNumber) },
      }),
    },
  )

  if (!dispatchRes.ok) {
    const text = await dispatchRes.text()
    console.error('[bugpilot] workflow_dispatch failed', dispatchRes.status, text)
    return jsonError('Failed to trigger apply-fix workflow', 502, corsHeaders)
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

const LABEL_DEFAULTS: Record<string, { color: string; description: string }> = {
  'user-feedback': { color: '0075ca', description: 'Submitted via bugpilot feedback widget' },
  'bug':           { color: 'd73a4a', description: 'Something is not working' },
  'enhancement':   { color: 'a2eeef', description: 'New feature or request' },
}

async function ensureLabelsExist(owner: string, repo: string, labels: string[], token: string): Promise<void> {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'bugpilot-worker/0.1',
    'Content-Type': 'application/json',
  }
  await Promise.all(labels.map(async (name) => {
    const check = await fetch(`https://api.github.com/repos/${owner}/${repo}/labels/${encodeURIComponent(name)}`, { headers })
    if (check.status === 404) {
      const defaults = LABEL_DEFAULTS[name] ?? { color: 'ededed', description: '' }
      const create = await fetch(`https://api.github.com/repos/${owner}/${repo}/labels`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name, ...defaults }),
      })
      if (!create.ok) {
        console.error('[bugpilot] label creation failed', name, create.status, await create.text())
      }
    } else if (!check.ok) {
      console.error('[bugpilot] label check failed', name, check.status, await check.text())
    }
  }))
}

const SCREENSHOTS_BRANCH = 'bug-report-screenshots'

async function uploadScreenshot(dataUrl: string, env: Env): Promise<string | null> {
  try {
    const [owner, repo] = env.GITHUB_REPO.split('/')
    const match = dataUrl.match(/^data:image\/(png|jpeg|gif|webp);base64,/)
    if (!match) {
      console.error('[bugpilot] screenshot rejected: unsupported MIME type')
      return null
    }
    const base64 = dataUrl.slice(match[0].length)
    const filename = `screenshots/${crypto.randomUUID()}.png`
    const headers = {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'bugpilot-worker/0.1',
      'Content-Type': 'application/json',
    }

    await ensureScreenshotsBranch(owner, repo, headers)

    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${filename}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: `chore: add screenshot`,
        content: base64,
        branch: SCREENSHOTS_BRANCH,
      }),
    })

    if (!res.ok) {
      console.error('[bugpilot] screenshot commit failed', res.status, await res.text())
      return null
    }

    return `https://github.com/${owner}/${repo}/raw/${SCREENSHOTS_BRANCH}/${filename}`
  } catch (err) {
    console.error('[bugpilot] screenshot upload failed', err)
    return null
  }
}

async function ensureScreenshotsBranch(owner: string, repo: string, headers: Record<string, string>): Promise<void> {
  const check = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${SCREENSHOTS_BRANCH}`, { headers })
  if (check.ok) return

  const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers })
  const repoData = await repoRes.json() as { default_branch: string }

  const shaRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${repoData.default_branch}`, { headers })
  const shaData = await shaRes.json() as { object: { sha: string } }

  await fetch(`https://api.github.com/repos/${owner}/${repo}/git/refs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ref: `refs/heads/${SCREENSHOTS_BRANCH}`, sha: shaData.object.sha }),
  })
}

export function buildTitle(body: SubmissionPayload): string {
  const prefix = body.projectName ? `[${body.projectName}] ` : ''
  const typeLabel = body.type === 'feature' ? 'Feature: ' : 'Bug: '
  const desc = body.description.slice(0, 72)
  return `${prefix}${typeLabel}${desc}${body.description.length > 72 ? '…' : ''}`
}

// Reporter as it appears in the human-readable body: "login (name)", or
// whichever half was supplied. Absent (anonymous host, BR360 today) yields
// null, no line and no `reporter` key, so existing deployments render
// exactly as before.
export function formatReporter(user: SubmissionPayload['user']): string | null {
  if (!user) return null
  const name = user.name || ''
  const login = user.login || ''
  if (name && login) return `${login} (${name})`
  return login || name || null
}

function reporterLine(user: SubmissionPayload['user']): string {
  const r = formatReporter(user)
  return r ? `**Reporter:** ${r}\n\n` : ''
}

// Contract: `reporter: { name, login }` in the structured block, key omitted
// entirely when no user was supplied. Groundwork's "My reports" page filters
// issues on reporter.login, so the key name and shape are fixed.
export function reporterStructured(user: SubmissionPayload['user']): { name: string | null; login: string | null } | undefined {
  if (!user) return undefined
  const name = user.name || null
  const login = user.login || null
  return name || login ? { name, login } : undefined
}

export function buildIssueBody(body: SubmissionPayload, screenshotUrl: string | null): string {
  return body.type === 'feature'
    ? buildFeatureBody(body, screenshotUrl)
    : buildBugBody(body, screenshotUrl)
}

function buildBugBody(body: SubmissionPayload, screenshotUrl: string | null): string {
  const ctx = body.context

  const stepsSection = body.stepsToReproduce
    ? `## Steps to reproduce\n\n${body.stepsToReproduce}\n\n`
    : ''

  const screenshotSection = screenshotUrl
    ? `## Screenshot\n\n![Screenshot](${screenshotUrl})\n\n`
    : ''

  const structured = JSON.stringify({
    type: 'bug',
    url: ctx.url,
    viewport: ctx.viewport,
    userAgent: ctx.userAgent,
    browser: ctx.browser,
    os: ctx.os,
    timestamp: ctx.timestamp,
    timezone: ctx.timezone ?? null,
    language: ctx.language ?? null,
    referrer: ctx.referrer ?? null,
    bugCategory: body.bugCategory ?? null,
    expectedBehavior: body.expectedBehavior ?? null,
    stepsToReproduce: body.stepsToReproduce ?? null,
    frequency: body.frequency ?? null,
    impact: body.impact ?? null,
    projectName: body.projectName ?? null,
    screenshotUrl,
    reporter: reporterStructured(body.user),
  })

  return `## What happened

${body.description}

## Expected behaviour

${body.expectedBehavior || '—'}

${stepsSection}## Details

| Field | Value |
|---|---|
| Category | ${body.bugCategory || '—'} |
| Frequency | ${formatFrequency(body.frequency)} |
| Impact | ${formatImpact(body.impact)} |

## Environment

| Field | Value |
|---|---|
| URL | ${ctx.url} |
| Viewport | ${ctx.viewport.w}×${ctx.viewport.h} |
| Browser | ${ctx.browser} |
| OS | ${ctx.os} |
| Timestamp | ${ctx.timestamp} |
| Project | ${body.projectName ?? '—'} |

${reporterLine(body.user)}${screenshotSection}<!-- bugpilot:structured
${structured}
bugpilot:end -->
`
}

function buildFeatureBody(body: SubmissionPayload, screenshotUrl: string | null): string {
  const ctx = body.context

  const whySection = body.problemStatement
    ? `## Problem it solves\n\n${body.problemStatement}\n\n`
    : ''

  const screenshotSection = screenshotUrl
    ? `## Mockup / screenshot\n\n![Screenshot](${screenshotUrl})\n\n`
    : ''

  const structured = JSON.stringify({
    type: 'feature',
    url: ctx.url,
    viewport: ctx.viewport,
    userAgent: ctx.userAgent,
    browser: ctx.browser,
    os: ctx.os,
    timestamp: ctx.timestamp,
    timezone: ctx.timezone ?? null,
    language: ctx.language ?? null,
    referrer: ctx.referrer ?? null,
    priority: body.priority ?? null,
    problemStatement: body.problemStatement ?? null,
    projectName: body.projectName ?? null,
    screenshotUrl,
    reporter: reporterStructured(body.user),
  })

  return `## Feature request

${body.description}

${whySection}## Details

| Field | Value |
|---|---|
| Priority | ${formatPriority(body.priority)} |
| Project | ${body.projectName ?? '—'} |
| URL | ${ctx.url} |
| Submitted | ${ctx.timestamp} |

${reporterLine(body.user)}${screenshotSection}<!-- bugpilot:structured
${structured}
bugpilot:end -->
`
}

function formatFrequency(v: string | null | undefined): string {
  const map: Record<string, string> = {
    'every-time': 'Every time',
    'most-times': 'Most of the time',
    'sometimes': 'Occasionally',
    'once': 'Just once',
  }
  return map[v ?? ''] ?? '—'
}

function formatImpact(v: string | null | undefined): string {
  const map: Record<string, string> = {
    'blocking': 'Blocking — cannot continue',
    'degraded': 'Degraded — workaround exists',
    'cosmetic': 'Minor / cosmetic',
  }
  return map[v ?? ''] ?? '—'
}

function formatPriority(v: string | null | undefined): string {
  const map: Record<string, string> = {
    'critical': 'Critical to my workflow',
    'high': 'Would significantly help',
    'nice': 'Nice to have',
  }
  return map[v ?? ''] ?? '—'
}

export function neutraliseMarkers(v: string | null | undefined): string | null {
  if (v == null) return null
  // The zero-width space (U+200B) stops '-->' in user text from closing the
  // HTML comment that carries the structured block, without visibly altering
  // the rendered issue body.
  return v.replace(/bugpilot:(structured|end)/gi, 'bugpilot $1').replace(/-->/g, '--\u200b>')
}

// RFC 9457 status-text lookup for the "title" member. Only the statuses this
// worker actually returns (see the jsonError call sites above) — no need for
// a full HTTP status table.
const STATUS_TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  413: 'Payload Too Large',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
}

// Emits RFC 9457 (application/problem+json) problem details. `ok` and
// `error` are kept alongside `type`/`title`/`status`/`detail` for one
// deprecation cycle: widget/src/widget.js:465 reads `body.error` directly,
// and this avoids a coupled widget release. Drop them once the widget no
// longer needs it (bugpilot#64).
export function jsonError(message: string, status: number, corsHeaders: Record<string, string>): Response {
  return new Response(
    JSON.stringify({
      type: 'about:blank',
      title: STATUS_TITLES[status] ?? 'Error',
      status,
      detail: message,
      ok: false,
      error: message,
    }),
    {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/problem+json' },
    },
  )
}
