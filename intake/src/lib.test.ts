// lib.test.ts — the endpoint mounted inside a host app (e.g. a Next.js route).

import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { envFromRecord, handleFeedbackRequest, signReporter } from './lib'

const ENV = envFromRecord({ ALLOWED_ORIGIN: 'https://app.example', GITHUB_TOKEN: 'ghp_test', GITHUB_REPO: 'acme/app', TRUST_SECRET: 's3cret' })

interface Call { method: string; url: string; body: any }

function stubGitHub(): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input)
    const method = (init.method ?? 'GET').toUpperCase()
    calls.push({ method, url, body: init.body ? JSON.parse(init.body as string) : undefined })
    if (method === 'POST' && url.endsWith('/repos/acme/app/issues')) {
      return new Response(JSON.stringify({ html_url: 'https://github.com/acme/app/issues/3', number: 3 }), { status: 201 })
    }
    return new Response('{}', { status: 200 })
  })
  return calls
}

function report(extra: Record<string, unknown> = {}) {
  return {
    type: 'bug',
    description: 'Totals are wrong',
    context: {
      url: 'https://app.example/orders', viewport: { w: 1280, h: 800 }, userAgent: 'UA',
      browser: 'Firefox', os: 'Linux', timestamp: '2026-11-12T10:00:00.000Z',
    },
    ...extra,
  }
}

const postAt = (path: string, body: unknown) =>
  new Request(`https://app.example${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://app.example' },
    body: JSON.stringify(body),
  })

afterEach(() => vi.unstubAllGlobals())

describe('handleFeedbackRequest', () => {
  it('accepts a report at the host\'s own path, not only /feedback', async () => {
    const calls = stubGitHub()
    const res = await handleFeedbackRequest(postAt('/api/feedback', report()), ENV)
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ ok: true, issueNumber: 3, trusted: false })
    const issue = calls.find((c) => c.method === 'POST' && c.url.endsWith('/issues'))!
    expect(issue.body.labels).toContain('untrusted')
  })

  it('a login signed with TRUST_SECRET is trusted and skips the untrusted label', async () => {
    const calls = stubGitHub()
    const proof = await signReporter('ana@example.com', 's3cret')
    const res = await handleFeedbackRequest(postAt('/api/feedback', report({ user: { name: 'Ana', login: 'ana@example.com', proof } })), ENV)
    expect(await res.json()).toMatchObject({ ok: true, trusted: true })
    const issue = calls.find((c) => c.method === 'POST' && c.url.endsWith('/issues'))!
    expect(issue.body.labels).toEqual(['user-feedback', 'bug', 'goblin'])
    expect(issue.body.body).toContain('ana@example.com (Ana)')
    expect(issue.body.body).not.toContain(proof)
  })

  it('answers the CORS preflight', async () => {
    const res = await handleFeedbackRequest(new Request('https://app.example/api/feedback', { method: 'OPTIONS', headers: { Origin: 'https://app.example' } }), ENV)
    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example')
  })
})

describe('SCREENSHOTS=off', () => {
  const png = 'data:image/png;base64,iVBORw0KGgo='

  it('drops a screenshot: nothing is committed and the issue does not link one', async () => {
    const calls = stubGitHub()
    const env = envFromRecord({ ALLOWED_ORIGIN: 'https://app.example', GITHUB_TOKEN: 't', GITHUB_REPO: 'acme/app', SCREENSHOTS: 'off' })
    const res = await handleFeedbackRequest(postAt('/api/feedback', report({ screenshot: png })), env)
    expect(res.status).toBe(201)
    expect(calls.some((c) => c.method === 'PUT' && c.url.includes('/contents/'))).toBe(false)
    expect(calls.some((c) => c.url.includes('bug-report-screenshots'))).toBe(false)
    const issue = calls.find((c) => c.method === 'POST' && c.url.endsWith('/issues'))!
    expect(issue.body.body).not.toContain('## Screenshot')
  })

  it('stores it when not set (unchanged default)', async () => {
    const calls = stubGitHub()
    await handleFeedbackRequest(postAt('/api/feedback', report({ screenshot: png })), ENV)
    expect(calls.some((c) => c.method === 'PUT' && c.url.includes('/contents/screenshots/'))).toBe(true)
  })
})

describe('build:lib bundle', () => {
  it('builds to one self-contained ES module with the same exports', async () => {
    const root = join(__dirname, '..')
    execFileSync('pnpm', ['run', '--silent', 'build:lib'], { cwd: root, stdio: 'pipe' })
    const out = join(root, 'dist', 'pr-goblin-intake.mjs')
    const mod = await import(pathToFileURL(out).href)
    expect(typeof mod.handleFeedbackRequest).toBe('function')
    expect(typeof mod.envFromRecord).toBe('function')
    expect(await mod.signReporter('a', 'b')).toBe(await signReporter('a', 'b'))
  }, 30_000)
})
