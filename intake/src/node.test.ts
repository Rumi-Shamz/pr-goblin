import { afterEach, describe, it, expect, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHandler, envFromProcess } from './node'
import { createRateLimiter } from './rate-limit'

describe('createRateLimiter', () => {
  it('allows up to the limit per window, per key', () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 1000 })
    expect(limiter.allow('a', 0)).toBe(true)
    expect(limiter.allow('a', 10)).toBe(true)
    expect(limiter.allow('a', 20)).toBe(false)
    expect(limiter.allow('b', 20)).toBe(true)
  })

  it('opens again when the window passes', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000 })
    expect(limiter.allow('a', 0)).toBe(true)
    expect(limiter.allow('a', 999)).toBe(false)
    expect(limiter.allow('a', 1000)).toBe(true)
  })

  it('stays bounded when flooded with distinct keys', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000, maxKeys: 3 })
    for (let i = 0; i < 50; i++) expect(limiter.allow(`k${i}`, 0)).toBe(true)
  })
})

describe('envFromProcess', () => {
  it('maps environment variables onto the handler env', () => {
    const env = envFromProcess({ ALLOWED_ORIGIN: '*', GITHUB_REPO: 'acme/app', GITHUB_TOKEN: 't', LINEAR_TEAM_KEY: 'ENG' })
    expect(env).toMatchObject({ ALLOWED_ORIGIN: '*', GITHUB_REPO: 'acme/app', GITHUB_TOKEN: 't', LINEAR_TEAM_KEY: 'ENG' })
    expect(env.TRUST_SECRET).toBeUndefined()
  })
})

describe('Node server', () => {
  let server: Server | undefined
  const realFetch = globalThis.fetch

  afterEach(async () => {
    vi.unstubAllGlobals()
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()))
    server = undefined
  })

  async function start(limit: number | null): Promise<string> {
    server = createServer(createHandler({
      env: { ALLOWED_ORIGIN: '*', GITHUB_TOKEN: 't', GITHUB_REPO: 'acme/app' },
      limiter: limit === null ? null : createRateLimiter({ limit, windowMs: 60_000 }),
    }))
    await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done))
    const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
    // The handler's own outbound calls (GitHub) are faked; the test's calls to the local server are real.
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith(base)) return realFetch(input, init)
      if (url.endsWith('/repos/acme/app/issues')) {
        return new Response(JSON.stringify({ html_url: 'https://github.com/acme/app/issues/1', number: 1 }), { status: 201 })
      }
      return new Response('{}', { status: 200 })
    })
    return base
  }

  const report = {
    type: 'bug',
    description: 'Broken',
    context: { url: 'https://x.example', viewport: { w: 1, h: 1 }, userAgent: 'ua', browser: 'b', os: 'o', timestamp: 't' },
  }
  const send = (base: string, body: unknown = report) =>
    realFetch(`${base}/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

  it('serves the same handler over HTTP', async () => {
    const base = await start(null)

    const res = await send(base)

    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ ok: true, issueNumber: 1 })
  })

  it('answers CORS preflight and 404s unknown paths', async () => {
    const base = await start(null)

    expect((await realFetch(`${base}/feedback`, { method: 'OPTIONS' })).status).toBe(204)
    expect((await realFetch(`${base}/nope`)).status).toBe(404)
  })

  it('rate-limits repeated reports from one address', async () => {
    const base = await start(2)

    expect((await send(base)).status).toBe(201)
    expect((await send(base)).status).toBe(201)
    const third = await send(base)
    expect(third.status).toBe(429)
    expect((await third.json() as any).detail).toContain('Too many')
  })
})
