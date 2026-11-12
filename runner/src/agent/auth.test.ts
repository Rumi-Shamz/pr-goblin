import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { agentEnv, describeAgentAuth } from "./auth"

function home(signedIn: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "goblin-auth-"))
  if (signedIn) {
    mkdirSync(join(dir, ".claude"))
    writeFileSync(join(dir, ".claude", ".credentials.json"), "{}")
  }
  return dir
}

describe("describeAgentAuth (claude)", () => {
  test("API key alone", () => {
    const a = describeAgentAuth("claude", { ANTHROPIC_API_KEY: "sk" }, home(false))
    expect(a.mode).toBe("api-key")
    expect(a.warnings).toEqual([])
  })

  test("CI subscription token", () => {
    const a = describeAgentAuth("claude", { CLAUDE_CODE_OAUTH_TOKEN: "t" }, home(false))
    expect(a.mode).toBe("subscription")
    expect(a.summary).toContain("CLAUDE_CODE_OAUTH_TOKEN")
  })

  test("signed in on this machine", () => {
    expect(describeAgentAuth("claude", {}, home(true)).mode).toBe("subscription")
  })

  test("warns when a key silently overrides a sign-in", () => {
    const a = describeAgentAuth("claude", { ANTHROPIC_API_KEY: "sk" }, home(true))
    expect(a.mode).toBe("api-key")
    expect(a.warnings[0]).toContain("GOBLIN_AUTH=subscription")
  })

  test("GOBLIN_AUTH=subscription ignores the key", () => {
    const a = describeAgentAuth("claude", { ANTHROPIC_API_KEY: "sk", GOBLIN_AUTH: "subscription" }, home(true))
    expect(a.mode).toBe("subscription")
  })

  test.skipIf(process.platform === "darwin")("nothing at all", () => {
    const a = describeAgentAuth("claude", {}, home(false))
    expect(a.mode).toBe("none")
    expect(a.warnings.length).toBe(1)
  })
})

describe("agentEnv", () => {
  test("auto passes the environment through", () => {
    expect(agentEnv("claude", { ANTHROPIC_API_KEY: "sk", X: "1" })).toEqual({ ANTHROPIC_API_KEY: "sk", X: "1" })
  })

  test("subscription strips the agent's API keys only", () => {
    const env = agentEnv("claude", { ANTHROPIC_API_KEY: "sk", OPENAI_API_KEY: "o", GOBLIN_AUTH: "subscription" })
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBe("o")
    expect(agentEnv("codex", { OPENAI_API_KEY: "o", GOBLIN_AUTH: "subscription" }).OPENAI_API_KEY).toBeUndefined()
  })
})
