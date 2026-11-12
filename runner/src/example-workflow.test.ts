// examples/goblin.yml is copied into users' repos, so the git identity it sets
// ends up on every agent commit. A bare <name>@users.noreply.github.com is the
// address of whichever GitHub account owns <name> (PR-Goblin exists), and
// Vercel refuses to deploy commits by authors outside the team.

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const workflow = readFileSync(resolve(import.meta.dir, '../../examples/goblin.yml'), 'utf-8')

describe('examples/goblin.yml git identity', () => {
  const emails = [...workflow.matchAll(/user\.email\s+"([^"]+)"/g)].map((m) => m[1])

  it('sets an identity', () => {
    expect(emails.length).toBeGreaterThan(0)
  })

  it('never uses a bare login noreply address that someone else can own', () => {
    for (const email of emails) {
      if (!email.endsWith('@users.noreply.github.com')) continue
      // GitHub's id-prefixed form (<id>+<login>@…) is tied to one account.
      expect(email).toMatch(/^(\$id|\d+)\+/)
    }
  })

  it('commits as the token owner when the token has one', () => {
    expect(workflow).toContain('gh api user')
  })
})
