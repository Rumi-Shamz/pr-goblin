// examples/goblin.yml is a thin caller of .github/workflows/goblin-runner.yml,
// which sets the git identity that ends up on every agent commit. A bare
// <name>@users.noreply.github.com is the address of whichever GitHub account
// owns <name> (PR-Goblin exists), and Vercel refuses to deploy commits by
// authors outside the team.

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '../..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf-8')

const workflow = read('.github/workflows/goblin-runner.yml')
const lockWorkflow = read('.github/workflows/goblin-lock.yml')
const example = read('examples/goblin.yml')
const exampleLock = read('examples/goblin-lock.yml')

describe('goblin-runner.yml git identity', () => {
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

describe('reusable workflows', () => {
  const usesLines = (text: string) =>
    [...text.matchAll(/^\s*(?:-\s+)?uses:\s+(\S+)/gm)].map((m) => m[1])

  it('pin every action by full commit SHA', () => {
    for (const text of [workflow, lockWorkflow]) {
      for (const ref of usesLines(text)) {
        expect(ref).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/)
      }
    }
  })

  it('default the token to read-only contents', () => {
    expect(workflow).toMatch(/^permissions:\n  contents: read$/m)
    expect(lockWorkflow).toMatch(/^permissions: \{\}$/m)
  })

  it('check out pr-goblin at the commit of the workflow file, not the caller', () => {
    expect(workflow).toContain('repository: ${{ job.workflow_repository }}')
    expect(workflow).toContain('ref: ${{ job.workflow_sha }}')
    expect(workflow).not.toMatch(/^\s*ref:.*github\.workflow_sha/m)
  })

  it('serialise runs at job level, so skipped caller runs never enter the group', () => {
    expect(workflow).toMatch(/^    concurrency:\n      group: pr-goblin-\$\{\{ github\.repository \}\}\n      cancel-in-progress: false$/m)
  })

  it('mint an App token only when app-id is set, and fall back to GOBLIN_GH_TOKEN', () => {
    expect(workflow).toMatch(/if: inputs\.app-id != ''/)
    expect(workflow).toContain('steps.app-token.outputs.token || secrets.GOBLIN_GH_TOKEN')
  })

  it('never uses the built-in token or secrets: inherit for the runner', () => {
    expect(workflow).not.toContain('github.token')
    for (const text of [example, exampleLock]) expect(text).not.toMatch(/secrets:\s*inherit/)
  })
})

describe('examples/goblin.yml caller', () => {
  it('calls the reusable runner at a release ref', () => {
    expect(example).toMatch(
      /uses: Rumi-Shamz\/pr-goblin\/\.github\/workflows\/goblin-runner\.yml@v\d/,
    )
  })

  it('stays off until GOBLIN_ENABLED is true', () => {
    expect(example).toContain("vars.GOBLIN_ENABLED == 'true'")
  })

  it('starts on label events, filtered to goblin labels in an if', () => {
    expect(example).toMatch(/issues:\n    types: \[labeled, unlabeled\]/)
    expect(example).toContain("startsWith(github.event.label.name, 'goblin')")
    expect(example).toContain('workflow_dispatch:')
  })

  it('never polls more often than hourly (every run bills at least a minute)', () => {
    const crons = [...example.matchAll(/^\s*-?\s*cron:\s*'([^']+)'/gm)].map((m) => m[1].split(/\s+/))
    for (const [minute, hour] of crons) {
      expect(minute).toMatch(/^\d+$/)
      expect(hour).toMatch(/^(\*|\*\/\d+|\d+|[\d,]+)$/)
    }
  })

  it('has top-level read-only contents permission', () => {
    expect(example).toMatch(/^permissions:\n  contents: read$/m)
  })
})
