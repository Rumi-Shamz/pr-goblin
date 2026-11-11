// sources/github.ts — GitHub Issues source adapter.
//
// GitHub issues are only open or closed, so workflow state is kept in labels:
//
//   open + ready label, no state label   → actionable (Ready)
//   open + in-progress label             → actionable (In Progress)
//   open + in-review label               → passive    (PR awaiting a human)
//   closed as completed                  → done
//   closed as not planned                → cancelled
//   open without the ready label         → cancelled  (a human parked it)
//
// Talks to GitHub through the `gh` CLI, which the runner already requires for
// pull requests, so no extra token or dependency is needed.

import type { Source, SourceDisposition } from "../source"
import type { SourceItem } from "../types"
import type { GitHubSourceConfig, ProjectConfig } from "../../config"
import { spawnPath } from "../../utils/path"
import { detectPrUrlInWorktree } from "./pr"

export interface GhResult {
  exitCode: number
  stdout: string
  stderr: string
}

/** Runs `gh` with the given arguments. Injectable for tests. */
export type GhExec = (args: string[]) => Promise<GhResult>

export const defaultGhExec: GhExec = async (args) => {
  const proc = Bun.spawn(["gh", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PATH: spawnPath() },
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

interface GhIssue {
  number: number
  title: string
  body: string | null
  state?: string
  stateReason?: string | null
  labels: { name: string }[]
}

/** Label name → tracker-style priority (1 urgent … 4 low). First match wins. */
const PRIORITY_LABELS: [RegExp, number][] = [
  [/^(critical|urgent|p0|(priority|severity)[:/](critical|urgent))$/i, 1],
  [/^(high|p1|(priority|severity)[:/]high)$/i, 2],
  [/^(medium|p2|(priority|severity)[:/]medium)$/i, 3],
  [/^(low|p3|(priority|severity)[:/]low)$/i, 4],
]

export function priorityFromLabels(labels: string[]): number | null {
  let best: number | null = null
  for (const label of labels) {
    for (const [pattern, priority] of PRIORITY_LABELS) {
      if (pattern.test(label.trim()) && (best === null || priority < best)) best = priority
    }
  }
  return best
}

/** "acme/my-app" + 123 → "acme/my-app#123" */
export function toItemId(repo: string, number: number): string {
  return `${repo}#${number}`
}

export function parseItemId(id: string): { repo: string; number: number } | null {
  const match = /^([^#\s]+\/[^#\s]+)#(\d+)$/.exec(id)
  if (!match) return null
  return { repo: match[1]!, number: Number(match[2]) }
}

export class GitHubSource implements Source {
  readonly tracker = "github" as const

  constructor(
    private projects: ProjectConfig[],
    private cfg: GitHubSourceConfig,
    private gh: GhExec = defaultGhExec,
  ) {}

  private has(labels: string[], wanted: string): boolean {
    const w = wanted.toLowerCase()
    return labels.some(l => l.toLowerCase() === w)
  }

  private classify(issue: Pick<GhIssue, "state" | "stateReason" | "labels">): SourceDisposition {
    const labels = issue.labels.map(l => l.name)
    if ((issue.state ?? "OPEN").toUpperCase() === "CLOSED") {
      return (issue.stateReason ?? "").toUpperCase() === "NOT_PLANNED" ? "cancelled" : "done"
    }
    if (!this.has(labels, this.cfg.readyLabel)) return "cancelled"
    if (this.has(labels, this.cfg.inReviewLabel)) return "passive"
    return "actionable"
  }

  async poll(): Promise<SourceItem[]> {
    const items: SourceItem[] = []
    for (const project of this.projects) {
      const result = await this.gh([
        "issue", "list",
        "--repo", project.repo,
        "--state", "open",
        "--label", this.cfg.readyLabel,
        "--limit", "100",
        "--json", "number,title,body,labels",
      ])
      if (result.exitCode !== 0) {
        throw new Error(`gh issue list failed for ${project.repo}: ${result.stderr.trim() || `exit ${result.exitCode}`}`)
      }
      const issues = JSON.parse(result.stdout || "[]") as GhIssue[]
      const repoName = project.repo.split("/").pop() ?? project.repo

      for (const issue of issues) {
        if (this.classify({ ...issue, state: "OPEN" }) !== "actionable") continue
        const labels = issue.labels.map(l => l.name)
        items.push({
          id: toItemId(project.repo, issue.number),
          identifier: `${repoName}-${issue.number}`,
          title: issue.title,
          description: issue.body ?? "",
          labels,
          priority: priorityFromLabels(labels),
          repo: project.repo,
          baseBranch: project.baseBranch,
        })
      }
    }
    return items
  }

  async onStart(_item: SourceItem): Promise<void> {
    // The agent moves the issue to In Progress itself (goblin-github skill).
  }

  async onDone(item: SourceItem, outcome: "merged" | "closed" | "failed"): Promise<void> {
    if (outcome !== "failed") return
    const ref = parseItemId(item.id)
    if (!ref) return
    // Park it: without the ready label it stops being polled. A human re-adds the label to retry.
    await this.gh([
      "issue", "edit", String(ref.number), "--repo", ref.repo,
      "--remove-label", this.cfg.readyLabel,
      "--remove-label", this.cfg.inProgressLabel,
    ])
    await this.gh([
      "issue", "comment", String(ref.number), "--repo", ref.repo,
      "--body", `pr-goblin could not finish this and has stopped. Re-add the \`${this.cfg.readyLabel}\` label to try again.`,
    ])
  }

  async onInvestigated(item: SourceItem): Promise<void> {
    const ref = parseItemId(item.id)
    if (!ref) return
    // Creating a label that exists fails harmlessly; adding a missing one would not.
    await this.gh(["label", "create", this.cfg.investigatedLabel, "--repo", ref.repo, "--color", "5319E7"])
    const result = await this.gh([
      "issue", "edit", String(ref.number), "--repo", ref.repo,
      "--add-label", this.cfg.investigatedLabel,
    ])
    if (result.exitCode !== 0) {
      throw new Error(`could not label ${item.id} as investigated: ${result.stderr.trim()}`)
    }
  }

  async fetchDisposition(itemId: string): Promise<SourceDisposition> {
    const ref = parseItemId(itemId)
    if (!ref) return "unknown"
    const result = await this.gh([
      "issue", "view", String(ref.number), "--repo", ref.repo,
      "--json", "state,stateReason,labels",
    ])
    if (result.exitCode !== 0) return "unknown"
    try {
      return this.classify(JSON.parse(result.stdout) as GhIssue)
    } catch {
      return "unknown"
    }
  }

  detectPrUrl(codeDir: string): Promise<string | undefined> {
    return detectPrUrlInWorktree(codeDir)
  }
}
