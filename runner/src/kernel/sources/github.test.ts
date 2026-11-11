import { describe, expect, test } from "bun:test"

import { GITHUB_DEFAULTS } from "../../config"
import type { SourceItem } from "../types"
import { GitHubSource, parseItemId, priorityFromLabels, toItemId, type GhExec, type GhResult } from "./github"

const PROJECTS = [{ team: "", slug: "", repo: "acme/app", baseBranch: "main" }]

const ok = (stdout = ""): GhResult => ({ exitCode: 0, stdout, stderr: "" })

/** Records every gh call and answers from a script keyed on the first two args. */
function fakeGh(answers: Record<string, GhResult | ((args: string[]) => GhResult)>) {
  const calls: string[][] = []
  const exec: GhExec = async (args) => {
    calls.push(args)
    const answer = answers[`${args[0]} ${args[1]}`]
    if (!answer) return ok()
    return typeof answer === "function" ? answer(args) : answer
  }
  return { exec, calls }
}

const issue = (number: number, labels: string[], extra: Record<string, unknown> = {}) => ({
  number,
  title: `Issue ${number}`,
  body: `Body ${number}`,
  labels: labels.map(name => ({ name })),
  ...extra,
})

const ITEM: SourceItem = {
  id: "acme/app#7",
  identifier: "app-7",
  title: "t",
  description: "",
  labels: [],
  priority: null,
  repo: "acme/app",
  baseBranch: "main",
}

describe("item ids", () => {
  test("round-trip", () => {
    expect(parseItemId(toItemId("acme/my-app", 12))).toEqual({ repo: "acme/my-app", number: 12 })
  })

  test("reject anything that is not owner/repo#number", () => {
    expect(parseItemId("issue-1")).toBeNull()
    expect(parseItemId("acme/app#x")).toBeNull()
    expect(parseItemId("acme/app#1 --repo evil/x")).toBeNull()
  })
})

describe("priorityFromLabels", () => {
  test("maps common label spellings and picks the most urgent", () => {
    expect(priorityFromLabels(["bug"])).toBeNull()
    expect(priorityFromLabels(["severity:critical"])).toBe(1)
    expect(priorityFromLabels(["P1"])).toBe(2)
    expect(priorityFromLabels(["priority/medium"])).toBe(3)
    expect(priorityFromLabels(["low", "high"])).toBe(2)
  })
})

describe("GitHubSource.poll", () => {
  test("asks gh for open issues carrying the ready label", async () => {
    const { exec, calls } = fakeGh({ "issue list": ok("[]") })
    await new GitHubSource(PROJECTS, GITHUB_DEFAULTS, exec).poll()

    expect(calls[0]).toEqual([
      "issue", "list", "--repo", "acme/app", "--state", "open",
      "--label", "goblin", "--limit", "100", "--json", "number,title,body,labels",
    ])
  })

  test("returns ready and in-progress issues, skips ones in review", async () => {
    const { exec } = fakeGh({
      "issue list": ok(JSON.stringify([
        issue(1, ["goblin", "bug"]),
        issue(2, ["goblin", "goblin:in-progress"]),
        issue(3, ["goblin", "goblin:in-review"]),
      ])),
    })
    const items = await new GitHubSource(PROJECTS, GITHUB_DEFAULTS, exec).poll()

    expect(items.map(i => i.id)).toEqual(["acme/app#1", "acme/app#2"])
    expect(items[0]).toMatchObject({
      identifier: "app-1",
      title: "Issue 1",
      description: "Body 1",
      labels: ["goblin", "bug"],
      repo: "acme/app",
      baseBranch: "main",
    })
  })

  test("derives priority from labels and tolerates a null body", async () => {
    const { exec } = fakeGh({
      "issue list": ok(JSON.stringify([issue(4, ["goblin", "severity:critical"], { body: null })])),
    })
    const [item] = await new GitHubSource(PROJECTS, GITHUB_DEFAULTS, exec).poll()

    expect(item?.priority).toBe(1)
    expect(item?.description).toBe("")
  })

  test("throws when gh fails, so the kernel logs it instead of seeing an empty queue", async () => {
    const { exec } = fakeGh({ "issue list": { exitCode: 1, stdout: "", stderr: "HTTP 401" } })
    await expect(new GitHubSource(PROJECTS, GITHUB_DEFAULTS, exec).poll()).rejects.toThrow("HTTP 401")
  })
})

describe("GitHubSource.fetchDisposition", () => {
  const dispositionOf = async (payload: unknown) => {
    const { exec } = fakeGh({ "issue view": ok(JSON.stringify(payload)) })
    return new GitHubSource(PROJECTS, GITHUB_DEFAULTS, exec).fetchDisposition("acme/app#7")
  }

  test("classifies each state", async () => {
    expect(await dispositionOf({ state: "OPEN", labels: [{ name: "goblin" }] })).toBe("actionable")
    expect(await dispositionOf({ state: "OPEN", labels: [{ name: "goblin" }, { name: "goblin:in-progress" }] })).toBe("actionable")
    expect(await dispositionOf({ state: "OPEN", labels: [{ name: "goblin" }, { name: "goblin:in-review" }] })).toBe("passive")
    expect(await dispositionOf({ state: "CLOSED", stateReason: "COMPLETED", labels: [] })).toBe("done")
    expect(await dispositionOf({ state: "CLOSED", stateReason: "NOT_PLANNED", labels: [] })).toBe("cancelled")
  })

  test("treats an open issue without the ready label as parked", async () => {
    expect(await dispositionOf({ state: "OPEN", labels: [{ name: "bug" }] })).toBe("cancelled")
  })

  test("is unknown for a bad id or a gh failure", async () => {
    const { exec, calls } = fakeGh({ "issue view": { exitCode: 1, stdout: "", stderr: "not found" } })
    const source = new GitHubSource(PROJECTS, GITHUB_DEFAULTS, exec)

    expect(await source.fetchDisposition("nonsense")).toBe("unknown")
    expect(calls).toHaveLength(0)
    expect(await source.fetchDisposition("acme/app#7")).toBe("unknown")
  })
})

describe("GitHubSource lifecycle callbacks", () => {
  test("a failed task is parked by removing the ready label, with a comment", async () => {
    const { exec, calls } = fakeGh({})
    await new GitHubSource(PROJECTS, GITHUB_DEFAULTS, exec).onDone(ITEM, "failed")

    expect(calls[0]).toEqual([
      "issue", "edit", "7", "--repo", "acme/app",
      "--remove-label", "goblin", "--remove-label", "goblin:in-progress",
    ])
    expect(calls[1]?.slice(0, 5)).toEqual(["issue", "comment", "7", "--repo", "acme/app"])
  })

  test("merged and closed outcomes touch nothing", async () => {
    const { exec, calls } = fakeGh({})
    const source = new GitHubSource(PROJECTS, GITHUB_DEFAULTS, exec)
    await source.onDone(ITEM, "merged")
    await source.onDone(ITEM, "closed")

    expect(calls).toHaveLength(0)
  })

  test("onInvestigated creates the label then applies it", async () => {
    const { exec, calls } = fakeGh({})
    await new GitHubSource(PROJECTS, GITHUB_DEFAULTS, exec).onInvestigated(ITEM)

    expect(calls[0]?.slice(0, 3)).toEqual(["label", "create", "goblin:investigated"])
    expect(calls[1]).toEqual(["issue", "edit", "7", "--repo", "acme/app", "--add-label", "goblin:investigated"])
  })

  test("onInvestigated throws when the label cannot be applied", async () => {
    const { exec } = fakeGh({ "issue edit": { exitCode: 1, stdout: "", stderr: "forbidden" } })
    await expect(new GitHubSource(PROJECTS, GITHUB_DEFAULTS, exec).onInvestigated(ITEM)).rejects.toThrow("forbidden")
  })
})
