// kernel-policy.test.ts — the kernel's lane, trust and one-shot behaviour.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

import type { GoblinDaemonConfig } from "../config"
import { DEFAULT_POLICY } from "./policy"
import { StateStore } from "./state"
import type { Source, SourceDisposition } from "./source"
import type { KernelConfig, SourceItem, Task } from "./types"

const KERNEL_CONFIG: KernelConfig = {
  maxRounds: 2,
  maxRetries: 2,
  pollIntervalMs: 60000,
  stallTimeoutMs: 300000,
  turnTimeoutMs: 3600000,
  agentDefault: "claude",
  dashboardPort: 14500,
  dashboardEnabled: false,
}

function createConfig(overrides: Partial<GoblinDaemonConfig> = {}): GoblinDaemonConfig {
  return {
    source: "github",
    workspace: { root: "/tmp/workspaces" },
    agent: { maxRounds: 2, stallTimeoutMs: 300000, turnTimeoutMs: 3600000, maxRetries: 2, default: "claude" },
    polling: { intervalMs: 60000 },
    dashboard: { port: 14500, enabled: false },
    projects: [],
    policy: DEFAULT_POLICY,
    ...overrides,
  }
}

function item(id: string, labels: string[] = [], priority: number | null = null): SourceItem {
  return {
    id,
    identifier: id.toUpperCase(),
    title: `Ticket ${id}`,
    description: "",
    labels,
    priority,
    repo: "acme/app",
    baseBranch: "main",
  }
}

interface Harness {
  kernel: any
  rules: Array<{ identifier: string; rules: unknown }>
  spawned: string[]
  investigated: string[]
  setPoll(items: SourceItem[]): void
  setDisposition(d: SourceDisposition): void
}

let counter = 0
let stateRoot = tmpdir()

async function harness(config: GoblinDaemonConfig, hour = 12): Promise<Harness> {
  let polled: SourceItem[] = []
  let disposition: SourceDisposition = "passive"
  const investigated: string[] = []
  const rules: Harness["rules"] = []
  const spawned: string[] = []

  const source: Source = {
    tracker: "github",
    poll: async () => polled,
    onStart: async () => {},
    onDone: async () => {},
    fetchDisposition: async () => disposition,
    onInvestigated: async (i) => { investigated.push(i.id) },
  }

  const { Kernel } = await import(`./kernel?policy-test=${++counter}`)
  const kernel: any = new Kernel(source, config, KERNEL_CONFIG)
  // paths.ts freezes GOBLIN_DIR at first import, so give each kernel its own state file.
  kernel.store = new StateStore(join(stateRoot, `state-${counter}.json`))
  kernel.now = () => new Date(2026, 10, 12, hour, 0)
  kernel.workspace = {
    async fetchLatest(): Promise<void> {},
    async createForTask(identifier: string, _repoDir: string, _base: string, _reuse: boolean, r: unknown) {
      rules.push({ identifier, rules: r })
      return {
        identifier,
        branch: `agent/${identifier.toLowerCase()}`,
        taskDir: "/tmp/goblin-fake-task",
        workDir: "/tmp/goblin-fake-task/implement",
        worktreeDir: "/tmp/goblin-fake-task/repo",
        created: true,
      }
    },
    async cleanOrphans(): Promise<string[]> { return [] },
  }
  kernel.repoStore = { async ensure(repo: string): Promise<string> { return `/fake/repos/${repo}` } }
  kernel.spawnAndAttach = async (task: Task): Promise<void> => { spawned.push(task.id) }

  return {
    kernel,
    rules,
    spawned,
    investigated,
    setPoll: (items) => { polled = items },
    setDisposition: (d) => { disposition = d },
  }
}

describe("Kernel policy", () => {
  let goblinDir: string

  beforeAll(() => {
    goblinDir = mkdtempSync(join(tmpdir(), "goblin-kernel-policy-"))
    stateRoot = goblinDir
    process.env.GOBLIN_DIR = goblinDir
  })

  beforeEach(() => {
    rmSync(goblinDir, { recursive: true, force: true })
    mkdirSync(goblinDir, { recursive: true })
  })

  afterAll(() => {
    rmSync(goblinDir, { recursive: true, force: true })
    delete process.env.GOBLIN_DIR
  })

  test("intake queues only what the policy admits", async () => {
    const h = await harness(createConfig())
    h.setPoll([
      item("normal"),
      item("batch", ["batch:ui"]),
      item("untrusted", ["untrusted"]),
      item("untrusted-urgent", ["untrusted", "critical"]),
    ])

    await h.kernel.intake()

    const tasks: Task[] = h.kernel.store.all()
    expect(tasks.map(t => t.id).sort()).toEqual(["normal", "untrusted-urgent"])
    expect(tasks.find(t => t.id === "normal")?.mode).toBe("implement")
    expect(tasks.find(t => t.id === "untrusted-urgent")?.mode).toBe("investigate")
    expect(h.kernel.lastAdmission).toEqual({ held: 1, batchWaiting: 1 })
  })

  test("batch tickets are queued once the batch window opens", async () => {
    const h = await harness(createConfig(), 3)
    h.setPoll([item("batch", ["batch:ui"])])

    await h.kernel.intake()

    expect(h.kernel.store.get("batch")?.state).toBe("queued")
  })

  test("dispatch hands the tracker and mode to the workspace so the agent gets the right rules", async () => {
    const h = await harness(createConfig())
    h.setPoll([item("normal"), item("probe", ["untrusted"], 1)])

    await h.kernel.intake()
    await h.kernel.dispatch()

    expect(h.rules).toContainEqual({ identifier: "NORMAL", rules: { tracker: "github", mode: "implement" } })
    expect(h.rules).toContainEqual({ identifier: "PROBE", rules: { tracker: "github", mode: "investigate" } })
  })

  test("dispatch respects maxConcurrent and works urgent tickets first", async () => {
    const h = await harness(createConfig({ maxConcurrent: 1 }))
    h.setPoll([item("normal"), item("urgent", [], 1)])

    await h.kernel.intake()
    await h.kernel.dispatch()

    expect(h.spawned).toEqual(["urgent"])
    expect(h.kernel.store.get("normal")?.state).toBe("queued")

    // The slot frees up → the next tick dispatches the rest.
    h.kernel.store.get("urgent").state = "published"
    await h.kernel.dispatch()
    expect(h.spawned).toEqual(["urgent", "normal"])
  })

  test("a finished investigation is recorded on the ticket and never becomes a PR task", async () => {
    const h = await harness(createConfig())
    h.setPoll([item("probe", ["untrusted", "critical"])])
    h.setDisposition("actionable")

    await h.kernel.intake()
    await h.kernel.dispatch()
    await h.kernel.onAgentExit("probe", { exitCode: 0, stderr: "" })

    const task: Task = h.kernel.store.get("probe")
    expect(h.investigated).toEqual(["probe"])
    expect(task.state).toBe("done")
    expect(task.doneReason).toBe("closed")
    expect(task.prUrl).toBeUndefined()
  })

  test("an investigated ticket is implemented after a human removes the untrusted label", async () => {
    const h = await harness(createConfig())
    h.setPoll([item("probe", ["untrusted", "critical"])])
    await h.kernel.intake()
    await h.kernel.dispatch()
    await h.kernel.onAgentExit("probe", { exitCode: 0, stderr: "" })

    // Still untrusted, now carrying the investigated label → held, not re-investigated.
    h.setPoll([item("probe", ["untrusted", "critical", "goblin:investigated"])])
    await h.kernel.intake()
    expect(h.kernel.store.get("probe")?.state).toBe("done")

    // Human triage: untrusted label removed.
    h.setPoll([item("probe", ["critical", "goblin:investigated"])])
    await h.kernel.intake()

    const task: Task = h.kernel.store.get("probe")
    expect(task.state).toBe("queued")
    expect(task.mode).toBe("implement")
    expect(task.labels).toEqual(["critical", "goblin:investigated"])
  })

  test("runOnce works the admitted tickets and returns a summary", async () => {
    const h = await harness(createConfig())
    h.setPoll([item("fix"), item("held", ["untrusted"]), item("later", ["batch"])])
    h.setDisposition("passive")
    // The fake agent "finishes" shortly after it is spawned.
    h.kernel.spawnAndAttach = async (task: Task): Promise<void> => {
      h.spawned.push(task.id)
      setTimeout(() => { void h.kernel.onAgentExit(task.id, { exitCode: 0, stderr: "" }) }, 5)
    }

    const summary = await h.kernel.runOnce({ pollMs: 10, deadlineMs: 5000 })

    expect(h.spawned).toEqual(["fix"])
    expect(summary).toEqual({
      worked: [{ identifier: "FIX", outcome: "published", prUrl: undefined }],
      held: 1,
      batchWaiting: 1,
      timedOut: false,
    })
  })

  test("runOnce reports only what this run changed, not tasks left from earlier runs", async () => {
    const h = await harness(createConfig())
    h.kernel.store.set({
      id: "old", identifier: "OLD", title: "", description: "", labels: [], priority: null,
      state: "published", repo: "acme/app", baseBranch: "main", round: 0, maxRounds: 2, retryCount: 0,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    } satisfies Task)
    h.kernel.store.save()
    h.setDisposition("passive")

    const summary = await h.kernel.runOnce({ pollMs: 10, deadlineMs: 5000 })

    expect(summary.worked).toEqual([])
  })

  test("runOnce returns immediately when there is nothing to do", async () => {
    const h = await harness(createConfig())

    const summary = await h.kernel.runOnce({ pollMs: 10, deadlineMs: 5000 })

    expect(summary).toEqual({ worked: [], held: 0, batchWaiting: 0, timedOut: false })
  })
})
