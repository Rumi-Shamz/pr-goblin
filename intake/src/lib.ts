// lib.ts — the intake endpoint as a library, for apps that already have a server.
//
// Use it to mount the endpoint inside an existing app instead of deploying a
// Worker or the Node server, e.g. a Next.js route handler:
//
//   // app/api/feedback/route.ts
//   import { handleFeedbackRequest, envFromRecord } from './pr-goblin-intake.mjs'
//   export const POST = (req: Request) => handleFeedbackRequest(req, envFromRecord(process.env))
//
// Built to a single ES module with `pnpm build:lib` (dist/pr-goblin-intake.mjs,
// zod bundled). Runs anywhere with fetch, Request and crypto.subtle (Node 20+,
// Bun, Deno, edge runtimes).
//
// The host is responsible for what a Worker or the Node server would otherwise
// do around the handler: rate limiting, and a request-size cap (a 4 MB
// screenshot arrives as roughly 5.4 MB of JSON).

import worker, { type Env } from './index'

export type { Env }
export { signReporter, isTrustedReporter, READY_LABEL, UNTRUSTED_LABEL } from './trust'

/** Every setting the endpoint reads, taken from a plain record such as process.env. */
export function envFromRecord(record: Record<string, string | undefined>): Env {
  return {
    ALLOWED_ORIGIN: record.ALLOWED_ORIGIN ?? '',
    GITHUB_TOKEN: record.GITHUB_TOKEN,
    GITHUB_REPO: record.GITHUB_REPO,
    LINEAR_API_KEY: record.LINEAR_API_KEY,
    LINEAR_TEAM_KEY: record.LINEAR_TEAM_KEY,
    LINEAR_PROJECT: record.LINEAR_PROJECT,
    TRUST_SECRET: record.TRUST_SECRET,
    WEBHOOK_SECRET: record.WEBHOOK_SECRET,
    SCREENSHOTS: record.SCREENSHOTS,
  }
}

/**
 * Handle a report at whatever path the host mounted it on. The Worker routes
 * on `/feedback`; a host route such as `/api/feedback` would otherwise 404.
 * Handles POST (the report) and OPTIONS (CORS preflight).
 */
export async function handleFeedbackRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  url.pathname = '/feedback'
  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer()
  return worker.fetch(new Request(url, { method: request.method, headers: request.headers, body }), env)
}
