// agent/auth.ts — Which credentials the coding agent will use, and a way to choose.
//
// The runner never handles agent credentials itself: the agent CLI reads them
// from its environment or from its own sign-in. That gives two ways to pay:
//
//   api-key       ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN (Claude) / OPENAI_API_KEY, CODEX_API_KEY (Codex)
//   subscription  `claude` / `codex login` signed in on this machine, or, for CI,
//                 CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`
//
// When an API key is present, Claude Code uses it ahead of a signed-in
// subscription. That surprises people who keep a key exported for other work,
// so GOBLIN_AUTH=subscription removes the keys from the agent's environment.

import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export type AuthPreference = 'auto' | 'subscription' | 'api-key'
export type AuthMode = 'api-key' | 'subscription' | 'cloud' | 'none'

export interface AgentAuth {
  agent: string
  mode: AuthMode
  /** One line for the start-up output. */
  summary: string
  warnings: string[]
}

type Env = Record<string, string | undefined>

const API_KEY_VARS: Record<string, string[]> = {
  claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
  codex: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
}

export function authPreference(env: Env = process.env): AuthPreference {
  const v = (env.GOBLIN_AUTH ?? '').trim().toLowerCase()
  if (v === 'subscription' || v === 'api-key') return v
  return 'auto'
}

/** The environment to start the agent with, after applying GOBLIN_AUTH. */
export function agentEnv(agent: string, env: Env = process.env): Env {
  if (authPreference(env) !== 'subscription') return { ...env }
  const out = { ...env }
  for (const name of API_KEY_VARS[agent] ?? []) delete out[name]
  return out
}

function present(env: Env, name: string): boolean {
  return Boolean(env[name]?.trim())
}

/** Signed-in state we can see without running the CLI. On macOS Claude keeps it in the keychain, so absence proves nothing there. */
function hasLocalSignIn(agent: string, home: string): boolean | undefined {
  if (agent === 'claude') {
    if (existsSync(join(home, '.claude', '.credentials.json'))) return true
    return process.platform === 'darwin' ? undefined : false
  }
  if (agent === 'codex') return existsSync(join(home, '.codex', 'auth.json'))
  return undefined
}

export function describeAgentAuth(agent: string, env: Env = process.env, home: string = homedir()): AgentAuth {
  const pref = authPreference(env)
  const warnings: string[] = []
  const keyVars = (API_KEY_VARS[agent] ?? []).filter((n) => present(env, n))
  const hasKey = keyVars.length > 0
  const hasToken = agent === 'claude' && present(env, 'CLAUDE_CODE_OAUTH_TOKEN')
  const signedIn = hasLocalSignIn(agent, home)
  const cloud = agent === 'claude' && (present(env, 'CLAUDE_CODE_USE_BEDROCK') || present(env, 'CLAUDE_CODE_USE_VERTEX'))

  if (cloud) {
    return { agent, mode: 'cloud', summary: `${agent}: Bedrock/Vertex credentials from the environment`, warnings }
  }

  if (pref === 'api-key') {
    if (!hasKey) warnings.push(`GOBLIN_AUTH=api-key but ${API_KEY_VARS[agent]?.join(' / ') ?? 'no API key'} is not set`)
    return { agent, mode: hasKey ? 'api-key' : 'none', summary: `${agent}: API key (${keyVars.join(', ') || 'missing'})`, warnings }
  }

  const subscriptionAvailable = hasToken || signedIn !== false
  const subscriptionSource = hasToken ? 'CLAUDE_CODE_OAUTH_TOKEN' : signedIn ? 'signed-in session' : 'signed-in session, if any'

  if (pref === 'subscription') {
    if (hasKey) warnings.push(`${keyVars.join(', ')} is set but ignored (GOBLIN_AUTH=subscription)`)
    if (!subscriptionAvailable) warnings.push(`GOBLIN_AUTH=subscription but ${agent} is not signed in: run \`${agent === 'codex' ? 'codex login' : 'claude'}\` and sign in${agent === 'claude' ? ', or set CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`' : ''}`)
    return { agent, mode: subscriptionAvailable ? 'subscription' : 'none', summary: `${agent}: subscription (${subscriptionSource})`, warnings }
  }

  // auto
  if (hasKey) {
    if (hasToken || signedIn) {
      warnings.push(`${agent} is signed in to a subscription, but ${keyVars.join(', ')} is set and takes precedence, so usage is billed to the API key. Set GOBLIN_AUTH=subscription to use the subscription.`)
    }
    return { agent, mode: 'api-key', summary: `${agent}: API key (${keyVars.join(', ')})`, warnings }
  }
  if (hasToken || signedIn) {
    return { agent, mode: 'subscription', summary: `${agent}: subscription (${subscriptionSource})`, warnings }
  }
  if (signedIn === undefined) {
    return { agent, mode: 'subscription', summary: `${agent}: no API key; using the signed-in session, if any`, warnings }
  }
  warnings.push(`${agent} has no credentials: set ${API_KEY_VARS[agent]?.join(' or ') ?? 'an API key'}${agent === 'claude' ? ', set CLAUDE_CODE_OAUTH_TOKEN, or sign in with `claude`' : ', or run `codex login`'}`)
  return { agent, mode: 'none', summary: `${agent}: no credentials found`, warnings }
}
