// config.ts — Configuration loader
// All config lives in ~/.pr-goblin/settings.json

import { existsSync, readFileSync, mkdirSync, writeFileSync } from "fs"
import { resolve } from "path"
import { z } from "zod"
import { DEFAULT_POLICY, type PolicyConfig } from "./kernel/policy"

export interface LinearConfig {
  apiKey: string
  projectSlug: string
  teamKey: string
  dispatchableStateTypes: string[]
  terminalStates: string[]
  stateNames: {
    todo: string
    inProgress: string
    inReview: string
    done: string
    backlog: string
  }
}

export interface ProjectConfig {
  team: string
  slug: string
  repo: string
  baseBranch: string
  setup?: string
  agent?: string
  post?: Record<string, string>
}

export interface WorkspaceConfig {
  root: string
}

export interface AgentConfig {
  maxRounds: number
  stallTimeoutMs: number
  turnTimeoutMs: number
  maxRetries: number
  default: "codex" | "claude" | "auto"
}

export interface PollingConfig {
  intervalMs: number
}

export interface DashboardConfig {
  port: number
  enabled: boolean
}

export type SourceType = 'linear' | 'github'

/** Labels that carry workflow state on GitHub issues. */
export interface GitHubSourceConfig {
  readyLabel: string
  inProgressLabel: string
  inReviewLabel: string
  investigatedLabel: string
}

export const GITHUB_DEFAULTS: GitHubSourceConfig = {
  readyLabel: "goblin",
  inProgressLabel: "goblin:in-progress",
  inReviewLabel: "goblin:in-review",
  investigatedLabel: DEFAULT_POLICY.investigatedLabel,
}

export interface GoblinDaemonConfig {
  source: SourceType
  linear?: LinearConfig
  github?: GitHubSourceConfig
  /** Lane and trust rules. Defaults to DEFAULT_POLICY. */
  policy?: PolicyConfig
  /** Most agents running at once. 0 or unset means no limit. */
  maxConcurrent?: number
  workspace: WorkspaceConfig
  agent: AgentConfig
  polling: PollingConfig
  dashboard: DashboardConfig
  projects: ProjectConfig[]
}

const settingsProjectSchema = z.object({
  // team + linear are only needed when the source is Linear.
  team: z.string().optional(),
  linear: z.string().optional(),
  repo: z.string(),
  baseBranch: z.string().optional(),
  setup: z.string().optional(),
  agent: z.enum(["codex", "claude", "auto"]).optional(),
  post: z.record(z.string(), z.string()).optional(),
})

const settingsSchema = z.object({
  source: z.enum(["linear", "github"]).optional(),
  github: z.object({
    readyLabel: z.string().optional(),
    inProgressLabel: z.string().optional(),
    inReviewLabel: z.string().optional(),
  }).optional(),
  policy: z.object({
    urgentLabels: z.array(z.string()).optional(),
    batchLabels: z.array(z.string()).optional(),
    untrustedLabel: z.string().optional(),
    investigatedLabel: z.string().optional(),
    batchWindow: z.object({ startHour: z.number().min(0).max(23), endHour: z.number().min(0).max(23) }).optional(),
    batchMinCount: z.number().min(0).optional(),
    batchMaxSize: z.number().min(1).optional(),
  }).optional(),
  maxConcurrent: z.number().min(0).optional(),
  linearApiKey: z.string().optional(),
  defaultAgent: z.enum(["codex", "claude", "auto"]).optional(),
  defaultTeam: z.string().optional(),
  projects: z.array(settingsProjectSchema).optional(),
  workspace: z.object({ root: z.string() }).optional(),
  polling: z.object({ intervalMs: z.number() }).optional(),
  dashboard: z.object({
    port: z.number().optional(),
    enabled: z.boolean().optional(),
  }).optional(),
}).catchall(z.unknown())

export type GoblinSettings = z.infer<typeof settingsSchema>

export function getSettingsPath(): string {
  return resolve(process.env.GOBLIN_DIR || resolve(process.env.HOME || "/tmp", ".pr-goblin"), "settings.json")
}

export function saveSettings(settings: GoblinSettings): void {
  const settingsPath = getSettingsPath()
  const dir = resolve(settingsPath, "..")
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
}

const LINEAR_DEFAULTS: LinearConfig = {
  apiKey: "",
  projectSlug: "",
  teamKey: "",
  dispatchableStateTypes: ["unstarted", "started"],
  terminalStates: ["Done", "Cancelled"],
  stateNames: {
    todo: "Todo",
    inProgress: "In Progress",
    inReview: "In Review",
    done: "Done",
    backlog: "Backlog",
  },
}

const DEFAULTS: GoblinDaemonConfig = {
  source: "linear",
  linear: LINEAR_DEFAULTS,
  workspace: {
    root: "~/.pr-goblin/workspaces",
  },
  agent: {
    maxRounds: 1,
    stallTimeoutMs: 300_000,      // 5 minutes without output
    turnTimeoutMs: 3_600_000,     // 1 hour max per turn
    maxRetries: 3,
    default: "claude",
  },
  polling: {
    intervalMs: 30_000,
  },
  dashboard: {
    port: 14500,
    enabled: true,
  },
  projects: [],
  policy: DEFAULT_POLICY,
  maxConcurrent: 2,
}

/**
 * Settings supplied through environment variables. These win over
 * settings.json, so a CI job (or a container) needs no settings file at all:
 *
 *   GOBLIN_SOURCE           "github" | "linear"   (default: "linear" if LINEAR_API_KEY is set, else "github")
 *   LINEAR_API_KEY          Linear personal API key
 *   GOBLIN_REPO             "owner/repo"          (default: GITHUB_REPOSITORY, which GitHub Actions sets)
 *   GOBLIN_BASE_BRANCH      default "main"
 *   GOBLIN_LINEAR_TEAM      Linear team key, e.g. "ENG"
 *   GOBLIN_LINEAR_PROJECT   Linear project slug
 *   GOBLIN_AGENT            "claude" | "codex"
 *   GOBLIN_MAX_CONCURRENT   number
 */
export function settingsFromEnv(env: Record<string, string | undefined> = process.env): GoblinSettings {
  const out: GoblinSettings = {}
  const repo = env.GOBLIN_REPO || env.GITHUB_REPOSITORY
  const explicitSource = env.GOBLIN_SOURCE === "github" || env.GOBLIN_SOURCE === "linear" ? env.GOBLIN_SOURCE : undefined

  if (env.LINEAR_API_KEY) out.linearApiKey = env.LINEAR_API_KEY
  if (explicitSource) out.source = explicitSource
  else if (repo) out.source = env.LINEAR_API_KEY ? "linear" : "github"

  if (repo) {
    out.projects = [{
      repo,
      baseBranch: env.GOBLIN_BASE_BRANCH || undefined,
      team: env.GOBLIN_LINEAR_TEAM || undefined,
      linear: env.GOBLIN_LINEAR_PROJECT || undefined,
    }]
  }
  if (env.GOBLIN_AGENT === "claude" || env.GOBLIN_AGENT === "codex") out.defaultAgent = env.GOBLIN_AGENT
  const max = Number(env.GOBLIN_MAX_CONCURRENT)
  if (env.GOBLIN_MAX_CONCURRENT && Number.isFinite(max) && max >= 0) out.maxConcurrent = max
  return out
}

export function loadSettings(): GoblinSettings {
  const settingsPath = getSettingsPath()
  if (!existsSync(settingsPath)) return {}
  try {
    const raw = JSON.parse(readFileSync(settingsPath, "utf-8"))
    const result = settingsSchema.safeParse(raw)
    return result.success ? result.data : {}
  } catch {
    return {}
  }
}

function resolvePath(value: string): string {
  const expanded = value.startsWith("~")
    ? value.replace("~", process.env.HOME || "/tmp")
    : value
  return resolve(expanded)
}

export function loadConfig(): GoblinDaemonConfig {
  const settings = { ...loadSettings(), ...settingsFromEnv() }

  const projects: ProjectConfig[] = (settings.projects ?? []).map((p) => ({
    team: p.team ?? "",
    slug: p.linear ?? "",
    repo: p.repo,
    baseBranch: p.baseBranch ?? "main",
    setup: p.setup,
    agent: p.agent,
    post: p.post as Record<string, string> | undefined,
  }))

  const sourceType = (settings.source as SourceType | undefined) ?? DEFAULTS.source

  const config: GoblinDaemonConfig = {
    source: sourceType,
    linear: sourceType === 'linear' ? {
      ...LINEAR_DEFAULTS,
      apiKey: settings.linearApiKey || "",
      projectSlug: projects[0]?.slug ?? "",
      teamKey: projects[0]?.team ?? "",
    } : undefined,
    github: sourceType === 'github' ? { ...GITHUB_DEFAULTS, ...settings.github } : undefined,
    policy: {
      ...DEFAULT_POLICY,
      ...settings.policy,
      batchWindow: settings.policy?.batchWindow ?? DEFAULT_POLICY.batchWindow,
    },
    maxConcurrent: settings.maxConcurrent ?? DEFAULTS.maxConcurrent,
    workspace: {
      root: resolvePath(settings.workspace?.root ?? DEFAULTS.workspace.root),
    },
    agent: {
      ...DEFAULTS.agent,
      default: settings.defaultAgent ?? DEFAULTS.agent.default,
    },
    polling: {
      intervalMs: settings.polling?.intervalMs ?? DEFAULTS.polling.intervalMs,
    },
    dashboard: {
      port: settings.dashboard?.port ?? DEFAULTS.dashboard.port,
      enabled: settings.dashboard?.enabled ?? DEFAULTS.dashboard.enabled,
    },
    projects,
  }

  return config
}
