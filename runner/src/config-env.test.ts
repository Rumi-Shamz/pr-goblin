import { describe, expect, test } from "bun:test"
import { settingsFromEnv } from "./config"

describe("settingsFromEnv", () => {
  test("is empty when nothing relevant is set", () => {
    expect(settingsFromEnv({})).toEqual({})
  })

  test("inside GitHub Actions with no other variables, uses GitHub Issues on the current repo", () => {
    const s = settingsFromEnv({ GITHUB_REPOSITORY: "acme/app" })
    expect(s.source).toBe("github")
    expect(s.projects).toEqual([{ repo: "acme/app", baseBranch: undefined, team: undefined, linear: undefined }])
  })

  test("adding a Linear key switches the source to Linear", () => {
    const s = settingsFromEnv({
      GITHUB_REPOSITORY: "acme/app",
      LINEAR_API_KEY: "lin_api_x",
      GOBLIN_LINEAR_TEAM: "ENG",
      GOBLIN_LINEAR_PROJECT: "web-1a2b",
    })
    expect(s.source).toBe("linear")
    expect(s.linearApiKey).toBe("lin_api_x")
    expect(s.projects?.[0]).toMatchObject({ repo: "acme/app", team: "ENG", linear: "web-1a2b" })
  })

  test("GOBLIN_SOURCE and GOBLIN_REPO override the inferred values", () => {
    const s = settingsFromEnv({
      GITHUB_REPOSITORY: "acme/ci-repo",
      GOBLIN_REPO: "acme/app",
      GOBLIN_BASE_BRANCH: "staging",
      GOBLIN_SOURCE: "github",
      LINEAR_API_KEY: "lin_api_x",
    })
    expect(s.source).toBe("github")
    expect(s.projects?.[0]).toMatchObject({ repo: "acme/app", baseBranch: "staging" })
  })

  test("reads agent and concurrency, ignoring junk", () => {
    expect(settingsFromEnv({ GOBLIN_AGENT: "codex", GOBLIN_MAX_CONCURRENT: "3" })).toEqual({
      defaultAgent: "codex",
      maxConcurrent: 3,
    })
    expect(settingsFromEnv({ GOBLIN_AGENT: "gpt", GOBLIN_MAX_CONCURRENT: "many" })).toEqual({})
  })
})
