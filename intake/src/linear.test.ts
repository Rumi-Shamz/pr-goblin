import { describe, it, expect } from 'vitest'
import { createLinearIssue } from './linear'

const TARGET = { apiKey: 'lin_api_test', teamKey: 'ENG' }

const TEAM = {
  id: 'team-1',
  states: {
    nodes: [
      { id: 's-backlog', name: 'Backlog', type: 'backlog', position: 0 },
      { id: 's-progress', name: 'In Progress', type: 'started', position: 2 },
      { id: 's-todo', name: 'Todo', type: 'unstarted', position: 1 },
    ],
  },
  labels: { nodes: [{ id: 'l-bug', name: 'Bug' }, { id: 'l-goblin', name: 'goblin' }] },
}

/** Answers Linear GraphQL calls by looking at the query text; records every call. */
function fakeLinear(overrides: { team?: unknown; project?: unknown } = {}) {
  const calls: { query: string; variables: Record<string, any>; auth: string | null }[] = []
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const { query, variables } = JSON.parse(init.body as string)
    calls.push({ query, variables, auth: new Headers(init.headers).get('Authorization') })
    let data: unknown
    if (query.includes('teams(')) data = { teams: { nodes: overrides.team === null ? [] : [overrides.team ?? TEAM] } }
    else if (query.includes('issueLabelCreate')) data = { issueLabelCreate: { issueLabel: { id: `l-new-${variables.name}` } } }
    else if (query.includes('projects(')) data = { projects: { nodes: overrides.project === null ? [] : [{ id: 'proj-1' }] } }
    else if (query.includes('issueCreate')) data = { issueCreate: { success: true, issue: { identifier: 'ENG-7', url: 'https://linear.app/x/issue/ENG-7' } } }
    return new Response(JSON.stringify({ data }), { status: 200 })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const createInput = (calls: ReturnType<typeof fakeLinear>['calls']) =>
  calls.find((c) => c.query.includes('issueCreate'))?.variables.input

describe('createLinearIssue', () => {
  it('creates a ready bug in the first unstarted state with existing labels reused', async () => {
    const { fetchImpl, calls } = fakeLinear()
    const created = await createLinearIssue(
      TARGET,
      { title: 'Bug: save fails', body: 'body', labels: ['bug', 'goblin'], ready: true },
      fetchImpl,
    )

    expect(created).toEqual({ identifier: 'ENG-7', url: 'https://linear.app/x/issue/ENG-7' })
    expect(createInput(calls)).toEqual({
      teamId: 'team-1',
      title: 'Bug: save fails',
      description: 'body',
      labelIds: ['l-bug', 'l-goblin'],
      stateId: 's-todo',
    })
    expect(calls.every((c) => c.auth === 'lin_api_test')).toBe(true)
    expect(calls.some((c) => c.query.includes('issueLabelCreate'))).toBe(false)
  })

  it('creates labels the team does not have yet', async () => {
    const { fetchImpl, calls } = fakeLinear()
    await createLinearIssue(TARGET, { title: 't', body: 'b', labels: ['untrusted'], ready: true }, fetchImpl)

    const labelCreate = calls.find((c) => c.query.includes('issueLabelCreate'))
    expect(labelCreate?.variables).toEqual({ name: 'untrusted', teamId: 'team-1' })
    expect(createInput(calls).labelIds).toEqual(['l-new-untrusted'])
  })

  it('leaves a not-ready ticket in the team default state', async () => {
    const { fetchImpl, calls } = fakeLinear()
    await createLinearIssue(TARGET, { title: 't', body: 'b', labels: [], ready: false }, fetchImpl)

    expect(createInput(calls)).not.toHaveProperty('stateId')
  })

  it('attaches the project when a slug is configured', async () => {
    const { fetchImpl, calls } = fakeLinear()
    await createLinearIssue({ ...TARGET, projectSlug: 'abc123' }, { title: 't', body: 'b', labels: [], ready: false }, fetchImpl)

    expect(calls.find((c) => c.query.includes('projects('))?.variables).toEqual({ slug: 'abc123' })
    expect(createInput(calls).projectId).toBe('proj-1')
  })

  it('fails clearly when the team or project does not exist', async () => {
    await expect(
      createLinearIssue(TARGET, { title: 't', body: 'b', labels: [], ready: false }, fakeLinear({ team: null }).fetchImpl),
    ).rejects.toThrow('team "ENG" not found')
    await expect(
      createLinearIssue({ ...TARGET, projectSlug: 'nope' }, { title: 't', body: 'b', labels: [], ready: false }, fakeLinear({ project: null }).fetchImpl),
    ).rejects.toThrow('project "nope" not found')
  })

  it('surfaces GraphQL errors and HTTP failures', async () => {
    const gqlError = (async () => new Response(JSON.stringify({ errors: [{ message: 'Authentication required' }] }), { status: 200 })) as unknown as typeof fetch
    await expect(createLinearIssue(TARGET, { title: 't', body: 'b', labels: [], ready: false }, gqlError)).rejects.toThrow('Authentication required')

    const http500 = (async () => new Response('oops', { status: 500 })) as unknown as typeof fetch
    await expect(createLinearIssue(TARGET, { title: 't', body: 'b', labels: [], ready: false }, http500)).rejects.toThrow('Linear API 500')
  })
})
