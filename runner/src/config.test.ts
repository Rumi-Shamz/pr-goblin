import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join, resolve } from "path"

import { loadConfig } from "./config"

const createdDirs: string[] = []
let savedHome: string | undefined
let savedGoblinDir: string | undefined

function createTempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "goblin-config-"))
  createdDirs.push(dir)
  return dir
}

function writeSettings(homeDir: string, settings: Record<string, unknown>): void {
  const settingsDir = resolve(homeDir, ".pr-goblin")
  mkdirSync(settingsDir, { recursive: true })
  writeFileSync(join(settingsDir, "settings.json"), JSON.stringify(settings, null, 2))
}

// loadConfig merges settings from the environment. CI sets some of these
// (GitHub Actions always sets GITHUB_REPOSITORY), so clear them per test.
const ENV_SETTING_KEYS = [
  "GOBLIN_SOURCE", "GOBLIN_REPO", "GITHUB_REPOSITORY", "GOBLIN_BASE_BRANCH", "GOBLIN_LINEAR_TEAM",
  "GOBLIN_LINEAR_PROJECT", "GOBLIN_AGENT", "GOBLIN_MAX_CONCURRENT", "LINEAR_API_KEY",
]
const savedEnvSettings = new Map<string, string | undefined>()

beforeEach((): void => {
  for (const key of ENV_SETTING_KEYS) {
    savedEnvSettings.set(key, process.env[key])
    delete process.env[key]
  }
})

afterEach((): void => {
  for (const [key, value] of savedEnvSettings) {
    if (value !== undefined) process.env[key] = value
    else delete process.env[key]
  }
  savedEnvSettings.clear()
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
  if (savedHome !== undefined) process.env.HOME = savedHome
  else delete process.env.HOME
  savedHome = undefined
  if (savedGoblinDir !== undefined) process.env.GOBLIN_DIR = savedGoblinDir
  else delete process.env.GOBLIN_DIR
  savedGoblinDir = undefined
})

describe("loadConfig", () => {
  test("loads projects from settings.json", (): void => {
    const homeDir = createTempHome()
    writeSettings(homeDir, {
      linearApiKey: "lin_api_test",
      defaultAgent: "codex",
      projects: [
        { team: "TES", linear: "proj-1", repo: "testuser/myapp", baseBranch: "main" },
      ],
      workspace: { root: "~/custom-workspaces" },
    })

    savedHome = process.env.HOME
    savedGoblinDir = process.env.GOBLIN_DIR
    process.env.HOME = homeDir
    delete process.env.GOBLIN_DIR

    const config = loadConfig()
    expect(config.linear!.apiKey).toBe("lin_api_test")
    expect(config.linear!.teamKey).toBe("TES")
    expect(config.linear!.projectSlug).toBe("proj-1")
    expect(config.agent.default).toBe("codex")
    expect(config.projects).toEqual([{ team: "TES", slug: "proj-1", repo: "testuser/myapp", baseBranch: "main" }])
    expect(config.workspace.root).toBe(resolve(homeDir, "custom-workspaces"))
  })

  test("uses defaults when settings.json is missing", (): void => {
    const homeDir = createTempHome()
    savedHome = process.env.HOME
    savedGoblinDir = process.env.GOBLIN_DIR
    process.env.HOME = homeDir
    delete process.env.GOBLIN_DIR

    const config = loadConfig()
    expect(config.linear!.apiKey).toBe("")
    expect(config.agent.default).toBe("claude")
    expect(config.projects).toEqual([])
    expect(config.workspace.root).toBe(resolve(homeDir, ".pr-goblin", "workspaces"))
  })

  test("ignores legacy ~/.config/pr-goblin/settings.json", (): void => {
    const homeDir = createTempHome()
    const legacyDir = resolve(homeDir, ".config", "goblin")
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(
      join(legacyDir, "settings.json"),
      JSON.stringify({
        linearApiKey: "lin_api_legacy",
        projects: [
          { team: "LEG", linear: "legacy-proj", repo: "legacy/repo", baseBranch: "main" },
        ],
      }, null, 2),
    )

    savedHome = process.env.HOME
    savedGoblinDir = process.env.GOBLIN_DIR
    process.env.HOME = homeDir
    delete process.env.GOBLIN_DIR

    const config = loadConfig()

    expect(config.linear!.apiKey).toBe("")
    expect(config.projects).toEqual([])
    expect(existsSync(resolve(homeDir, ".pr-goblin", "settings.json"))).toBe(false)
  })
})
