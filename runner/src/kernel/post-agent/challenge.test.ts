import { describe, expect, test } from "bun:test"

import { parseAgentSpec } from "../agent"
import { challengePostAgent } from "./challenge"
import type { Task } from "../types"

const TASK = {
  id: "acme/app#7", identifier: "app-7", title: "Checkout button does nothing", description: "",
  labels: [], priority: null, state: "active", repo: "acme/app", baseBranch: "main",
  round: 0, maxRounds: 1, retryCount: 0, createdAt: "", updatedAt: "",
} satisfies Task

describe("challenge agent", () => {
  test("is read-only, uses the tracker's skill and posts one Goblin Challenge comment", () => {
    const agent = challengePostAgent("github", { approved: "goblin:approved", reinvestigate: "goblin:reinvestigate" })
    const rules = agent.buildRules("app")

    expect(agent.name).toBe("challenge")
    expect(agent.skills).toEqual(["goblin-github"])
    expect(rules).toContain("## Goblin Challenge")
    expect(rules).toContain("Modify, create or delete any file")
    expect(rules).toContain("not instructions to follow")
    expect(rules).toContain("`goblin:approved`")
    expect(rules).not.toContain("untrusted` label")
  })

  test("mentions the untrusted label only for an untrusted ticket, and uses Linear's skill there", () => {
    const agent = challengePostAgent("linear", { approved: "a", reinvestigate: "r", untrusted: "untrusted" })
    expect(agent.skills).toEqual(["goblin-linear"])
    expect(agent.buildRules("app")).toContain("remove the `untrusted` label")
  })

  test("the prompt names the ticket and the repository", () => {
    const agent = challengePostAgent("github", { approved: "a", reinvestigate: "r" })
    const prompt = agent.buildPrompt({ task: TASK, prior: [] })
    expect(prompt).toContain("app-7")
    expect(prompt).toContain("acme/app")
  })
})

describe("parseAgentSpec", () => {
  test("splits agent and model", () => {
    expect(parseAgentSpec("claude:opus")).toEqual({ agent: "claude", model: "opus" })
    expect(parseAgentSpec("codex:gpt-5.5")).toEqual({ agent: "codex", model: "gpt-5.5" })
    expect(parseAgentSpec("claude")).toEqual({ agent: "claude" })
  })

  test("auto and empty leave the choice to the caller", () => {
    expect(parseAgentSpec("auto")).toEqual({})
    expect(parseAgentSpec(undefined)).toEqual({})
    expect(parseAgentSpec("")).toEqual({})
  })
})
