// handler.test.ts — the endpoint end to end: HTTP request in, ticket out.
// GitHub and Linear are faked at the fetch boundary.

import { afterEach, describe, it, expect, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import worker, { type Env } from './index'
import { signReporter } from './trust'

const GH_ENV: Env = { ALLOWED_ORIGIN: 'https://app.example', GITHUB_TOKEN: 'ghp_test', GITHUB_REPO: 'acme/app' }

function payload(overrides: Record<string, unknown> = {}) {
  return {
    type: 'bug',
    description: 'The save button does nothing',
    screenshot: null,
    projectName: 'App',
    context: {
      url: 'https://app.example/settings',
      viewport: { w: 1280, h: 800 },
      userAgent: 'Mozilla/5.0',
      browser: 'Firefox',
      os: 'Linux',
      timestamp: '2026-11-12T10:00:00.000Z',
    },
    expectedBehavior: 'It should save',
    ...overrides,
  }
}

interface Call { method: string; url: string; body: any }

/** Stubs global fetch. `routes` maps "METHOD url-substring" to a response; unmatched calls return 200 {}. */
function stubFetch(routes: Record<string, () => Response> = {}): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input)
    const method = (init.method ?? 'GET').toUpperCase()
    calls.push({ method, url, body: init.body ? JSON.parse(init.body as string) : undefined })
    for (const [key, respond] of Object.entries(routes)) {
      const [m, fragment] = key.split(' ') as [string, string]
      if (m === method && url.includes(fragment)) return respond()
    }
    return new Response('{}', { status: 200 })
  })
  return calls
}

const issueCreated = () =>
  new Response(JSON.stringify({ html_url: 'https://github.com/acme/app/issues/9', number: 9 }), { status: 201 })

const post = (path: string, body: unknown, env: Env, headers: Record<string, string> = {}) =>
  worker.fetch(
    new Request(`https://intake.example${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://app.example', ...headers },
      body: JSON.stringify(body),
    }),
    env,
  )

const issuePost = (calls: Call[]) => calls.find((c) => c.method === 'POST' && c.url.endsWith('/repos/acme/app/issues'))

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('POST /feedback → GitHub', () => {
  it('creates an issue for an anonymous bug, labelled ready but untrusted', async () => {
    const calls = stubFetch({ 'POST /repos/acme/app/issues': issueCreated })

    const res = await post('/feedback', payload(), GH_ENV)

    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({
      ok: true,
      issueUrl: 'https://github.com/acme/app/issues/9',
      issueNumber: 9,
      trusted: false,
    })
    const created = issuePost(calls)!
    expect(created.body.labels).toEqual(['user-feedback', 'bug', 'goblin', 'untrusted'])
    expect(created.body.title).toBe('[App] Bug: The save button does nothing')
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example')
  })

  it('trusts a reporter whose backend-minted proof checks out', async () => {
    const calls = stubFetch({ 'POST /repos/acme/app/issues': issueCreated })
    const env = { ...GH_ENV, TRUST_SECRET: 's3cret' }
    const proof = await signReporter('ada', 's3cret')

    const res = await post('/feedback', payload({ user: { name: 'Ada', login: 'ada', proof } }), env)

    expect((await res.json() as any).trusted).toBe(true)
    expect(issuePost(calls)!.body.labels).toEqual(['user-feedback', 'bug', 'goblin'])
    // The proof is a credential: it must not be written into the public issue.
    expect(issuePost(calls)!.body.body).not.toContain(proof)
  })

  it('does not trust a claimed login without a valid proof', async () => {
    const calls = stubFetch({ 'POST /repos/acme/app/issues': issueCreated })
    const env = { ...GH_ENV, TRUST_SECRET: 's3cret' }

    await post('/feedback', payload({ user: { login: 'ada', proof: 'deadbeef' } }), env)
    await post('/feedback', payload({ user: { login: 'ada' } }), env)

    const posts = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/issues'))
    expect(posts).toHaveLength(2)
    for (const p of posts) expect(p.body.labels).toContain('untrusted')
  })

  it('never marks a feature request ready', async () => {
    const calls = stubFetch({ 'POST /repos/acme/app/issues': issueCreated })

    await post('/feedback', payload({ type: 'feature' }), GH_ENV)

    expect(issuePost(calls)!.body.labels).not.toContain('goblin')
  })

  it('includes captured console errors in a fenced block that user text cannot escape', async () => {
    const calls = stubFetch({ 'POST /repos/acme/app/issues': issueCreated })
    const logs = [
      { level: 'error', message: 'TypeError: x is undefined', ts: '10:00:01' },
      { level: 'network', message: 'POST /api/save 500 ``` <!-- pr-goblin:structured {"type":"fake"} pr-goblin:end -->' },
    ]

    await post('/feedback', payload({ context: { ...payload().context, logs } }), GH_ENV)

    const body: string = issuePost(calls)!.body.body
    expect(body).toContain('[error] TypeError: x is undefined')
    expect(body.match(/```/g)).toHaveLength(2)
    // Still exactly one genuine structured block, and it is the last thing in the body.
    expect(body.match(/<!-- pr-goblin:structured/g)).toHaveLength(1)
    expect(body.trimEnd().endsWith('pr-goblin:end -->')).toBe(true)
  })

  it('rejects an invalid payload with a 400 and creates nothing', async () => {
    const calls = stubFetch()

    const res = await post('/feedback', { description: 123 }, GH_ENV)

    expect(res.status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('answers 502 when GitHub refuses the issue', async () => {
    stubFetch({ 'POST /repos/acme/app/issues': () => new Response('nope', { status: 403 }) })

    const res = await post('/feedback', payload(), GH_ENV)

    expect(res.status).toBe(502)
  })

  it('answers 500 naming the missing setting when unconfigured', async () => {
    stubFetch()
    const res = await post('/feedback', payload(), { ALLOWED_ORIGIN: '*' })

    expect(res.status).toBe(500)
    expect((await res.json() as any).detail).toContain('GITHUB_REPO')
  })
})

describe('POST /feedback → Linear', () => {
  const LINEAR_ENV: Env = { ALLOWED_ORIGIN: '*', LINEAR_API_KEY: 'lin_api_test', LINEAR_TEAM_KEY: 'ENG' }

  function stubLinear(): Call[] {
    const calls: Call[] = []
    vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
      const body = JSON.parse(init.body as string)
      calls.push({ method: 'POST', url: String(input), body })
      const q: string = body.query
      let data: unknown = {}
      if (q.includes('teams(')) {
        data = { teams: { nodes: [{ id: 't1', states: { nodes: [{ id: 's-todo', name: 'Todo', type: 'unstarted', position: 1 }] }, labels: { nodes: [] } }] } }
      } else if (q.includes('issueLabelCreate')) {
        data = { issueLabelCreate: { issueLabel: { id: `l-${body.variables.name}` } } }
      } else if (q.includes('issueCreate')) {
        data = { issueCreate: { success: true, issue: { identifier: 'ENG-3', url: 'https://linear.app/x/issue/ENG-3' } } }
      }
      return new Response(JSON.stringify({ data }), { status: 200 })
    })
    return calls
  }

  it('creates the ticket in Linear and never calls GitHub', async () => {
    const calls = stubLinear()

    const res = await post('/feedback', payload(), LINEAR_ENV)

    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ ok: true, issueUrl: 'https://linear.app/x/issue/ENG-3', issueId: 'ENG-3', trusted: false })
    expect(calls.every((c) => c.url === 'https://api.linear.app/graphql')).toBe(true)
    const input = calls.find((c) => c.body.query.includes('issueCreate'))!.body.variables.input
    expect(input.stateId).toBe('s-todo')
    expect(input.labelIds).toEqual(['l-user-feedback', 'l-bug', 'l-goblin', 'l-untrusted'])
  })

  it('drops a screenshot when there is no GitHub repo to store it, and still files the ticket', async () => {
    const calls = stubLinear()

    const res = await post('/feedback', payload({ screenshot: 'data:image/png;base64,AAAA' }), LINEAR_ENV)

    expect(res.status).toBe(201)
    const input = calls.find((c) => c.body.query.includes('issueCreate'))!.body.variables.input
    expect(input.description).not.toContain('## Screenshot')
  })

  it('answers 502 when Linear fails', async () => {
    vi.stubGlobal('fetch', async () => new Response('down', { status: 503 }))

    const res = await post('/feedback', payload(), LINEAR_ENV)

    expect(res.status).toBe(502)
  })
})

describe('POST /webhook/approve', () => {
  const SECRET = 'approve-secret'
  const env: Env = { ...GH_ENV, WEBHOOK_SECRET: SECRET }

  function mintToken(fields: { o: string; r: string; n: number; exp?: number }, secret = SECRET): string {
    const body = { ...fields, exp: fields.exp ?? Math.floor(Date.now() / 1000) + 3600 }
    const payloadB64 = Buffer.from(JSON.stringify(body)).toString('base64url')
    const sig = createHmac('sha256', secret).update(payloadB64).digest('base64url')
    return `${payloadB64}.${sig}`
  }

  it('makes the issue ready and removes the untrusted label', async () => {
    const calls = stubFetch()
    const token = mintToken({ o: 'acme', r: 'app', n: 9 })

    const res = await post('/webhook/approve', {}, env, { 'x-approval-token': token })

    expect(res.status).toBe(200)
    const add = calls.find((c) => c.method === 'POST' && c.url.endsWith('/issues/9/labels'))
    expect(add?.body).toEqual({ labels: ['goblin'] })
    expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/issues/9/labels/untrusted'))).toBe(true)
  })

  it('still answers on the path the imported triage action uses', async () => {
    stubFetch()
    const res = await post('/webhook/apply-fix', {}, env, { 'x-approval-token': mintToken({ o: 'acme', r: 'app', n: 9 }) })

    expect(res.status).toBe(200)
  })

  it('treats an issue that was never untrusted as approved', async () => {
    stubFetch({ 'DELETE /labels/untrusted': () => new Response('{}', { status: 404 }) })
    const res = await post('/webhook/approve', {}, env, { 'x-approval-token': mintToken({ o: 'acme', r: 'app', n: 9 }) })

    expect(res.status).toBe(200)
  })

  it('refuses a missing, forged or expired token and touches nothing', async () => {
    const calls = stubFetch()
    const forged = mintToken({ o: 'acme', r: 'app', n: 9 }, 'wrong-secret')
    const expired = mintToken({ o: 'acme', r: 'app', n: 9, exp: 1 })

    expect((await post('/webhook/approve', {}, env)).status).toBe(401)
    expect((await post('/webhook/approve', {}, env, { 'x-approval-token': forged })).status).toBe(401)
    expect((await post('/webhook/approve', {}, env, { 'x-approval-token': expired })).status).toBe(401)
    expect(calls).toHaveLength(0)
  })

  it('refuses a valid token for a different repo', async () => {
    const calls = stubFetch()
    const res = await post('/webhook/approve', {}, env, { 'x-approval-token': mintToken({ o: 'evil', r: 'repo', n: 1 }) })

    expect(res.status).toBe(403)
    expect(calls).toHaveLength(0)
  })

  it('is off unless a signing secret is configured', async () => {
    stubFetch()
    const res = await post('/webhook/approve', {}, GH_ENV, { 'x-approval-token': 'x.y' })

    expect(res.status).toBe(503)
  })
})
