// node.ts — run the intake endpoint as a plain Node server (Node 20+).
//
//   node dist/node.mjs           # after `pnpm build:node`
//
// Same handler as the Cloudflare Worker; configuration comes from the
// environment instead of Worker bindings. Adds per-IP rate limiting, which
// the Worker leaves to Cloudflare.
//
//   PORT                 default 8787
//   RATE_LIMIT_PER_MIN   reports per IP per minute, default 5 (0 disables)
//   TRUST_PROXY          "1" to take the client IP from X-Forwarded-For
//   …plus everything in the Env interface (ALLOWED_ORIGIN, GITHUB_TOKEN, …)

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import worker, { jsonError, type Env } from './index'
import { createRateLimiter, type RateLimiter } from './rate-limit'

const MAX_BODY_BYTES = 6_000_000 // a 4 MB screenshot as base64, plus the form

export function envFromProcess(env: Record<string, string | undefined> = process.env): Env {
  return {
    ALLOWED_ORIGIN: env.ALLOWED_ORIGIN ?? '',
    GITHUB_TOKEN: env.GITHUB_TOKEN,
    GITHUB_REPO: env.GITHUB_REPO,
    LINEAR_API_KEY: env.LINEAR_API_KEY,
    LINEAR_TEAM_KEY: env.LINEAR_TEAM_KEY,
    LINEAR_PROJECT: env.LINEAR_PROJECT,
    TRUST_SECRET: env.TRUST_SECRET,
    WEBHOOK_SECRET: env.WEBHOOK_SECRET,
  }
}

function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for']
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim()
    if (first) return first
  }
  return req.socket.remoteAddress ?? 'unknown'
}

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) return null
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

export interface HandlerOptions {
  env: Env
  limiter?: RateLimiter | null
  trustProxy?: boolean
}

/** Node request listener wrapping the Worker-style fetch handler. */
export function createHandler(opts: HandlerOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const send = async (response: Response): Promise<void> => {
      res.statusCode = response.status
      response.headers.forEach((value, key) => res.setHeader(key, value))
      res.end(Buffer.from(await response.arrayBuffer()))
    }

    try {
      const url = `http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`
      const headers = new Headers()
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers.set(key, value)
        else if (Array.isArray(value)) headers.set(key, value.join(', '))
      }
      const ip = clientIp(req, opts.trustProxy ?? false)
      headers.set('CF-Connecting-IP', ip) // the handler logs this name

      const cors = { 'Access-Control-Allow-Origin': '*' }
      if (req.method === 'POST' && opts.limiter && !opts.limiter.allow(ip)) {
        return await send(jsonError('Too many reports, try again in a minute', 429, cors))
      }

      let body: Buffer | undefined
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
        const read = await readBody(req)
        if (read === null) return await send(jsonError('Request body too large', 413, cors))
        body = read
      }

      const request = new Request(url, { method: req.method, headers, body })
      await send(await worker.fetch(request, opts.env))
    } catch (err) {
      console.error('[pr-goblin] node adapter error', err)
      if (!res.headersSent) res.statusCode = 500
      res.end()
    }
  }
}

// Start only when run directly, not when imported by tests.
const invokedDirectly = typeof process !== 'undefined' && process.argv[1] !== undefined
  && import.meta.url === new URL(`file://${process.argv[1]}`).href

if (invokedDirectly) {
  const port = Number(process.env.PORT) || 8787
  const perMinute = process.env.RATE_LIMIT_PER_MIN === undefined ? 5 : Number(process.env.RATE_LIMIT_PER_MIN)
  const limiter = perMinute > 0 ? createRateLimiter({ limit: perMinute, windowMs: 60_000 }) : null

  createServer(createHandler({
    env: envFromProcess(),
    limiter,
    trustProxy: process.env.TRUST_PROXY === '1',
  })).listen(port, () => {
    console.log(`[pr-goblin] intake listening on :${port}`)
  })
}
