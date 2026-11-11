import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, lstatSync } from "fs"
import { resolve } from "path"

import { provisionSkillsToWrapper, setupAgentContext } from "./context-injector"
import { cleanupTestTmp, testTmpDir } from "../test-helpers"

afterAll((): void => {
  cleanupTestTmp()
})

describe("provisionSkillsToWrapper", () => {
  test("creates symlinks for bundled goblin-* skills in all agent skill directories", () => {
    const dir = testTmpDir("goblin-ctx-skills-")
    const provisioned = provisionSkillsToWrapper(dir)

    // Should find at least some goblin-* skills
    expect(provisioned.length).toBeGreaterThan(0)

    for (const skill of provisioned) {
      for (const prefix of [".agents", ".claude"]) {
        const linkPath = resolve(dir, prefix, "skills", skill)
        expect(existsSync(linkPath)).toBe(true)
        expect(lstatSync(linkPath).isSymbolicLink()).toBe(true)
      }
    }
  })

  test("idempotent — second call returns empty (all already linked)", () => {
    const dir = testTmpDir("goblin-ctx-skills-idem-")
    provisionSkillsToWrapper(dir)
    const second = provisionSkillsToWrapper(dir)
    expect(second).toEqual([])
  })
})

describe("setupAgentContext", () => {
  test("writes custom rules and provisions filtered skills", () => {
    const dir = testTmpDir("goblin-ctx-agent-")
    setupAgentContext(dir, "# Custom Rules\nDo stuff", ["goblin-linear"])

    const claude = readFileSync(resolve(dir, "CLAUDE.md"), "utf-8")
    expect(claude).toContain("Custom Rules")

    // Only goblin-linear should be provisioned
    expect(existsSync(resolve(dir, ".claude", "skills", "goblin-linear"))).toBe(true)
    expect(existsSync(resolve(dir, ".claude", "skills", "goblin-commit"))).toBe(false)
  })
})
