// cli/commands/lifecycle.ts — Daemon lifecycle: init, start, run, stop, restart

import type { CAC } from 'cac'
import { resolve, dirname } from 'path'
import { existsSync, readFileSync, openSync } from 'fs'
import { loadConfig, getSettingsPath, loadSettings, settingsFromEnv } from '../../config'
import { getRuntimeHealth } from '../../runtime-health'
import { printAnimatedBanner } from '../../kernel/banner'
import { serveDashboard, installGracefulShutdown } from './runtime'
import { readPid, writePid, removePid } from '../../daemon-pid'
import { spawnPath } from '../../utils/path'
import { trySpawnSync } from '../../utils/spawn'

export type FindPidResult =
  | { ok: true; pid: number }
  | { ok: false; reason: "not-installed" | "no-match" }

export function findPidByPort(port: number, execSync?: typeof Bun.spawnSync): FindPidResult {
  const result = trySpawnSync(['lsof', '-ti', `:${port}`], { stdout: 'pipe', stderr: 'pipe' }, execSync)
  if (result.kind === "not-installed") return { ok: false, reason: "not-installed" }
  if (result.kind === "error") throw result.error
  const pid = parseInt(result.stdout?.toString().trim() ?? "", 10)
  if (isNaN(pid)) return { ok: false, reason: "no-match" }
  return { ok: true, pid }
}

const GOBLIN_ROOT = resolve(dirname(new URL(import.meta.url).pathname), '../../..')

// ── Kernel bootstrap ─────────────────────────────────────

function preflight(): { ready: boolean; issues: string[] } {
  const health = getRuntimeHealth({ ...loadSettings(), ...settingsFromEnv() })
  return { ready: health.runtimeReady, issues: health.issues }
}

async function printStartBanner(config: ReturnType<typeof loadConfig>): Promise<void> {
  const repos = config.projects.map((p: { repo: string }) => p.repo).join(', ')
  let version = '0.0.0'
  try {
    const pkg = JSON.parse(readFileSync(resolve(GOBLIN_ROOT, 'package.json'), 'utf-8'))
    version = pkg.version
  } catch { /* fallback to 0.0.0 */ }
  await printAnimatedBanner({
    repos,
    dashboardUrl: config.dashboard.enabled
      ? `http://localhost:${config.dashboard.port}`
      : undefined,
    version,
  })
}

async function createRuntimeKernel(config: ReturnType<typeof loadConfig>) {
  const { Kernel } = await import('../../kernel/kernel')

  let source
  switch (config.source) {
    case 'linear': {
      if (!config.linear) throw new Error('Linear config is required when source is "linear"')
      const { LinearSource } = await import('../../kernel/sources/linear')
      source = new LinearSource(config.linear, config.projects, config.policy?.investigatedLabel)
      break
    }
    case 'github': {
      if (!config.github) throw new Error('GitHub config is required when source is "github"')
      const { GitHubSource } = await import('../../kernel/sources/github')
      source = new GitHubSource(config.projects, {
        ...config.github,
        investigatedLabel: config.policy?.investigatedLabel ?? config.github.investigatedLabel,
      })
      break
    }
    default:
      throw new Error(`Unknown source type: ${config.source}`)
  }

  const kernel = new Kernel(source, config, {
    maxRounds: config.agent.maxRounds,
    pollIntervalMs: config.polling.intervalMs,
    stallTimeoutMs: config.agent.stallTimeoutMs,
    turnTimeoutMs: config.agent.turnTimeoutMs,
    agentDefault: config.agent.default,
    dashboardPort: config.dashboard.port,
    dashboardEnabled: config.dashboard.enabled,
  })

  return {
    kernel,
    projects: config.projects.map((p: { slug: string; repo: string }) => ({
      slug: p.slug,
      repo: p.repo,
    })),
  }
}

// ── Command implementations ──────────────────────────────

async function cmdInit(): Promise<void> {
  const { cmdInit: runInit } = await import('../../commands/init')
  return runInit()
}

export function buildAlreadyRunningMessage(pid: number): string {
  return `goblin is already running (pid ${pid}). Run 'goblin stop' first.`
}

async function cmdStart(): Promise<void> {
  const existingPid = readPid()
  if (existingPid) {
    console.error(buildAlreadyRunningMessage(existingPid))
    process.exit(1)
  }

  const config = loadConfig()

  const cliPath = new URL(import.meta.url).pathname
  const logDir = resolve(getSettingsPath(), '..', 'logs')
  if (!existsSync(logDir)) {
    const { mkdirSync } = await import('fs')
    mkdirSync(logDir, { recursive: true })
  }
  const logPath = resolve(logDir, 'daemon.log')
  const logFd = openSync(logPath, 'a')

  // Resolve PATH from user's login shell so daemon inherits the same tools.
  // Fall back to spawnPath() so daemon can still find gh/claude/codex when
  // current PATH is empty and login-shell probe fails.
  let daemonPath = spawnPath()
  const shell = process.env.SHELL || '/bin/zsh'
  const shellResult = trySpawnSync([shell, '-l', '-c', 'echo $PATH'], { stdout: 'pipe' })
  if (shellResult.kind === 'ok') {
    const loginPath = shellResult.stdout?.toString().trim() ?? ''
    if (loginPath) daemonPath = loginPath
  }

  const appPath = resolve(dirname(cliPath), '..', 'app.ts')
  const child = Bun.spawn(['bun', 'run', appPath, 'daemon'], {
    stdout: logFd,
    stderr: logFd,
    stdin: 'ignore',
    detached: true,
    env: { ...process.env, PATH: daemonPath },
  })
  child.unref()
  writePid(child.pid)

  await Bun.sleep(500)
  try {
    process.kill(child.pid, 0)
  } catch {
    removePid()
    console.error(`goblin failed to start (pid ${child.pid} exited immediately)`)
    console.error(`  Check log: ${logPath}`)
    const tail = trySpawnSync(['tail', '-n', '5', logPath])
    if (tail.kind === 'ok' && tail.stdout) process.stderr.write(tail.stdout)
    process.exit(1)
  }

  console.log(buildDaemonStartedBanner({
    pid: child.pid,
    port: config.dashboard.port,
    logPath,
    dashboardEnabled: config.dashboard.enabled,
  }))
}

export function buildRunNotReadyMessage(issues: string[]): string {
  const bullet = issues.map(i => `  • ${i}`).join("\n")
  return (
    `✗ goblin run blocked — setup incomplete:\n` +
    `${bullet}\n\n` +
    `  goblin init      Interactive wizard\n` +
    `  goblin start     Background daemon + dashboard setup`
  )
}

export function buildDaemonStartedBanner(opts: {
  pid: number
  port: number
  logPath: string
  dashboardEnabled: boolean
}): string {
  const head = opts.dashboardEnabled
    ? `Dashboard  http://localhost:${opts.port}`
    : `Mode       CLI-only (dashboard disabled)`
  return (
    `${head}\n` +
    `Log        ${opts.logPath}\n` +
    `Stop       goblin stop  (pid ${opts.pid})`
  )
}

export async function bootstrapDaemonRuntime<T>(
  ready: boolean,
  createRuntime: () => Promise<T>,
): Promise<T | null> {
  if (!ready) {
    return null
  }
  return createRuntime()
}

async function cmdRun(): Promise<void> {
  const { suppressUpdateNotification } = await import('../context')
  suppressUpdateNotification()

  const config = loadConfig()
  const { ready, issues } = preflight()

  if (!ready) {
    console.error(buildRunNotReadyMessage(issues))
    process.exit(1)
  }

  const runtime = await createRuntimeKernel(config)

  if (config.dashboard.enabled) {
    serveDashboard({
      port: config.dashboard.port,
      getCtx: () => ({
        kernel: runtime.kernel,
        config: runtime.kernel.getConfig(),
        projects: runtime.projects,
      }),
    })
  }

  let stopRenderer: (() => void) | null = null
  if (process.stdout.isTTY) {
    const { createTTYRenderer } = await import('../../kernel/tty-renderer')
    stopRenderer = createTTYRenderer((fn) => runtime.kernel.onSSE(fn))
  }

  await printStartBanner(config)
  await runtime.kernel.start()

  installGracefulShutdown({
    shutdown: () => runtime.kernel.shutdown(),
    forceShutdown: () => runtime.kernel.forceShutdown(),
    afterShutdown: () => {
      stopRenderer?.()
    },
  })
}

async function cmdDaemon(): Promise<void> {
  const config = loadConfig()
  const { ready: initialReady, issues } = preflight()

  // Without the dashboard there is no UI to finish setup, so the daemon
  // cannot recover from a not-ready state on its own. Fail fast instead of
  // sitting idle forever.
  if (!config.dashboard.enabled && !initialReady) {
    console.error(buildRunNotReadyMessage(issues))
    process.exit(1)
  }

  let runtime = await bootstrapDaemonRuntime(initialReady, async () => createRuntimeKernel(config))

  if (config.dashboard.enabled) {
    let activationPromise: Promise<void> | null = null
    const activate = async (): Promise<void> => {
      if (runtime && runtime.kernel.lastTickAt > 0) return
      if (!activationPromise) {
        activationPromise = (async () => {
          const nextConfig = loadConfig()
          const { ready, issues } = preflight()
          if (!ready) {
            throw new Error(`Setup incomplete: ${issues.join(', ')}`)
          }
          const nextRuntime = await createRuntimeKernel(nextConfig)
          await nextRuntime.kernel.start()
          runtime = nextRuntime
        })().finally(() => { activationPromise = null })
      }
      return activationPromise
    }

    serveDashboard({
      port: config.dashboard.port,
      getCtx: () => ({
        kernel: runtime?.kernel,
        config: runtime?.kernel.getConfig() ?? config,
        projects: runtime?.projects ?? [],
        onActivate: activate,
      }),
    })
  }

  // If setup was already complete at fork time, start polling immediately.
  if (runtime && preflight().ready) {
    await printStartBanner(config)
    await runtime.kernel.start()
  }

  installGracefulShutdown({
    shutdown: async () => {
      if (runtime && runtime.kernel.lastTickAt > 0) {
        await runtime.kernel.shutdown()
      }
    },
    forceShutdown: () => runtime?.kernel.forceShutdown(),
    afterShutdown: () => removePid(),
  })
}

async function cmdStop(): Promise<void> {
  const config = loadConfig()
  const port = config.dashboard.port
  const pid = readPid()

  if (!pid) {
    const found = findPidByPort(port)
    if (!found.ok) {
      if (found.reason === "not-installed") {
        console.log(`goblin is not running (or install lsof to verify port ${port})`)
      } else {
        console.log('goblin is not running')
      }
      return
    }
    try {
      process.kill(found.pid, 'SIGTERM')
      console.log(`goblin stopped (pid: ${found.pid}, found by port ${port})`)
      removePid()
    } catch {
      console.log('goblin is not running')
    }
    return
  }

  try {
    process.kill(pid, 'SIGTERM')
    removePid()
    console.log(`goblin stopped (pid: ${pid})`)
  } catch {
    removePid()
    console.log('goblin is not running (stale pid cleaned)')
  }
}

async function cmdRestart(): Promise<void> {
  await cmdStop()
  await new Promise((r) => setTimeout(r, 500))
  await cmdStart()
}

/**
 * `goblin once` — poll once, work what is admitted, exit. Built for CI:
 * no daemon, no dashboard, no state assumed from a previous run.
 * Exit code: 0 when every worked ticket ended well, 1 when one failed or the run timed out.
 */
async function cmdOnce(opts: { timeout?: string; json?: boolean }): Promise<void> {
  const { suppressUpdateNotification } = await import('../context')
  suppressUpdateNotification()

  const config = loadConfig()
  const { ready, issues } = preflight()
  if (!ready) {
    console.error(buildRunNotReadyMessage(issues))
    process.exit(1)
  }

  const minutes = Number(opts.timeout)
  const deadlineMs = Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : undefined

  const runtime = await createRuntimeKernel({
    ...config,
    dashboard: { ...config.dashboard, enabled: false },
  })
  const summary = await runtime.kernel.runOnce({ deadlineMs })

  if (opts.json) {
    console.log(JSON.stringify(summary, null, 2))
  } else {
    if (summary.worked.length === 0) console.log('goblin: nothing to work on')
    for (const w of summary.worked) {
      console.log(`goblin: ${w.identifier} → ${w.outcome}${w.prUrl ? ` ${w.prUrl}` : ''}`)
    }
    if (summary.held > 0) console.log(`goblin: ${summary.held} untrusted ticket(s) waiting for human triage`)
    if (summary.batchWaiting > 0) console.log(`goblin: ${summary.batchWaiting} batch ticket(s) waiting for the batch window`)
    if (summary.timedOut) console.error('goblin: timed out before all agents finished')
  }

  const failed = summary.timedOut || summary.worked.some((w) => w.outcome === 'failed')
  process.exit(failed ? 1 : 0)
}

// ── Registration ─────────────────────────────────────────

export function registerLifecycleCommands(cli: CAC): void {
  cli
    .command('init', 'Interactive setup wizard')
    .action(async () => {
      await cmdInit()
    })

  cli.command('start', 'Start daemon in background').action(async () => {
    await cmdStart()
  })

  cli
    .command('run', 'Start in foreground (Ctrl+C to stop)')
    .action(async () => {
      await cmdRun()
    })

  cli
    .command('once', 'Poll once, work admitted tickets, then exit (for CI)')
    .option('--timeout <minutes>', 'Give up after this many minutes')
    .option('--json', 'Print the run summary as JSON')
    .action(async (opts: { timeout?: string; json?: boolean }) => {
      await cmdOnce(opts)
    })

  // Internal: spawned by `goblin start`. The "Internal:" prefix signals users
  // should not invoke it directly (cac has no hidden-command flag).
  cli
    .command('daemon', 'Internal: background daemon (used by `goblin start`)')
    .action(async () => {
      await cmdDaemon()
    })

  cli.command('stop', 'Stop daemon').action(async () => {
    await cmdStop()
  })

  cli.command('restart', 'Stop + start daemon').action(async () => {
    await cmdRestart()
  })
}
