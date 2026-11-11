import { afterEach, describe, expect, mock, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join, resolve } from "path"

import type { GoblinDaemonConfig } from "../config"
import { executeAction } from "./registry"

const CONFIG: GoblinDaemonConfig = {
  source: "linear",
  linear: {
    apiKey: "lin_api_test",
    projectSlug: "test-project",
    teamKey: "TEST",
    dispatchableStateTypes: ["unstarted", "started"],
    terminalStates: ["Done", "Cancelled"],
    stateNames: {
      todo: "Todo",
      inProgress: "In Progress",
      inReview: "In Review",
      done: "Done",
      backlog: "Backlog",
    },
  },
  workspace: { root: "/tmp/workspaces" },
  agent: {
    maxRounds: 2,
    stallTimeoutMs: 300000,
    turnTimeoutMs: 3600000,
    maxRetries: 2,
    default: "codex",
  },
  polling: { intervalMs: 60000 },
  dashboard: { port: 14500, enabled: false },
  projects: [],
}

async function loadDaemonModule(tag: string): Promise<void> {
  await import(`./daemon?${tag}=${Date.now()}`)
}

describe("daemon clean actions", () => {
  const savedGoblinDir = process.env.GOBLIN_DIR
  const tempDirs: string[] = []

  afterEach(() => {
    mock.restore()
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
    if (savedGoblinDir !== undefined) process.env.GOBLIN_DIR = savedGoblinDir
    else delete process.env.GOBLIN_DIR
  })

  test("cleanTask resolves repo identifier before cleaning the worktree", async () => {
    const goblinDir = mkdtempSync(join(tmpdir(), "goblin-daemon-actions-"))
    tempDirs.push(goblinDir)

    writeFileSync(resolve(goblinDir, "state.json"), JSON.stringify({
      version: 1,
      tasks: [{
        id: "issue-1",
        identifier: "TES-1",
        title: "test",
        description: "",
        labels: [],
        priority: null,
        state: "done",
        doneReason: "failed",
        repo: "acme/app",
        baseBranch: "main",
        round: 0,
        maxRounds: 2,
        retryCount: 0,
        createdAt: "2026-04-18T00:00:00.000Z",
        updatedAt: "2026-04-18T00:00:00.000Z",
      }],
    }, null, 2))

    const calls: Array<[string, string]> = []
    const repoStoreArgs: string[] = []
    mock.module("../paths", () => ({
      GOBLIN_DIR: goblinDir,
      LOGS_DIR: resolve(goblinDir, "logs"),
    }))
    mock.module("../workspace/manager", () => ({
      WorkspaceManager: class {
        async cleanWorktreeOnly(identifier: string, repoDir: string): Promise<void> {
          calls.push([identifier, repoDir])
        }
      },
    }))
    mock.module("../workspace/repo-store", () => ({
      RepoStore: class {
        constructor(reposRoot: string) {
          repoStoreArgs.push(reposRoot)
        }
        repoDirOf(repoRef: string): string {
          return resolve("/fake/repos", repoRef)
        }
      },
    }))
    await loadDaemonModule("clean-task")

    const result = await executeAction(
      { config: CONFIG, projects: [] },
      "cleanTask",
      { identifier: "TES-1" },
    )

    expect(result).toEqual({
      ok: true,
      data: { ok: true, cleaned: "TES-1" },
    })
    expect(repoStoreArgs).toEqual([CONFIG.workspace.root])
    expect(calls).toEqual([["TES-1", "/fake/repos/acme/app"]])
  })

  test("cleanAllDone passes repo identifiers through to the workspace manager", async () => {
    const goblinDir = mkdtempSync(join(tmpdir(), "goblin-daemon-actions-"))
    tempDirs.push(goblinDir)

    writeFileSync(resolve(goblinDir, "state.json"), JSON.stringify({
      version: 1,
      tasks: [{
        id: "issue-1",
        identifier: "TES-1",
        title: "test",
        description: "",
        labels: [],
        priority: null,
        state: "done",
        doneReason: "failed",
        repo: "acme/app",
        baseBranch: "main",
        round: 0,
        maxRounds: 2,
        retryCount: 0,
        createdAt: "2026-04-18T00:00:00.000Z",
        updatedAt: "2026-04-18T00:00:00.000Z",
      }],
    }, null, 2))

    const calls: Array<[string, string]> = []
    const repoStoreArgs: string[] = []
    mock.module("../paths", () => ({
      GOBLIN_DIR: goblinDir,
      LOGS_DIR: resolve(goblinDir, "logs"),
    }))
    mock.module("../workspace/manager", () => ({
      WorkspaceManager: class {
        async cleanWorktreeOnly(identifier: string, repoDir: string): Promise<void> {
          calls.push([identifier, repoDir])
        }
      },
    }))
    mock.module("../workspace/repo-store", () => ({
      RepoStore: class {
        constructor(reposRoot: string) {
          repoStoreArgs.push(reposRoot)
        }
        repoDirOf(repoRef: string): string {
          return resolve("/fake/repos", repoRef)
        }
      },
    }))
    await loadDaemonModule("clean-all-done")

    const result = await executeAction(
      { config: CONFIG, projects: [] },
      "cleanAllDone",
      {},
    )

    expect(result).toEqual({
      ok: true,
      data: { ok: true, cleaned: ["TES-1"] },
    })
    expect(repoStoreArgs).toEqual([CONFIG.workspace.root])
    expect(calls).toEqual([["TES-1", "/fake/repos/acme/app"]])
  })
})
