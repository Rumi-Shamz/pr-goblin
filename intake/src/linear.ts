// linear.ts — creating the ticket in Linear instead of GitHub Issues.
//
// Uses Linear's GraphQL API directly with a personal API key. Only what
// intake needs: resolve the team (and optionally a project), find or create
// labels, pick the first "unstarted" state for bugs, create the issue.

const LINEAR_API_URL = 'https://api.linear.app/graphql'

export interface LinearTarget {
  apiKey: string
  /** Team key, e.g. "ENG". */
  teamKey: string
  /** Optional project slug id (the trailing id in a project URL). The runner polls by project. */
  projectSlug?: string
}

export interface NewTicket {
  title: string
  body: string
  labels: string[]
  /** True → put it in the team's first "unstarted" state (Todo), where the runner looks. False → team default (Backlog/Triage). */
  ready: boolean
}

export interface CreatedTicket {
  url: string
  identifier: string
}

type Fetch = typeof fetch

async function gql<T>(target: LinearTarget, query: string, variables: Record<string, unknown>, fetchImpl: Fetch): Promise<T> {
  const res = await fetchImpl(LINEAR_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: target.apiKey },
    body: JSON.stringify({ query, variables }),
  })
  if (!res.ok) throw new Error(`Linear API ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const json = await res.json() as { data?: T; errors?: { message: string }[] }
  if (json.errors?.length) throw new Error(`Linear API error: ${json.errors.map((e) => e.message).join('; ')}`)
  if (!json.data) throw new Error('Linear API returned no data')
  return json.data
}

interface TeamLookup {
  teams: {
    nodes: {
      id: string
      states: { nodes: { id: string; name: string; type: string; position: number }[] }
      labels: { nodes: { id: string; name: string }[] }
    }[]
  }
}

export async function createLinearIssue(target: LinearTarget, ticket: NewTicket, fetchImpl: Fetch = fetch): Promise<CreatedTicket> {
  const lookup = await gql<TeamLookup>(
    target,
    `query ($key: String!) {
      teams(filter: { key: { eq: $key } }) {
        nodes {
          id
          states { nodes { id name type position } }
          labels(first: 250) { nodes { id name } }
        }
      }
    }`,
    { key: target.teamKey },
    fetchImpl,
  )
  const team = lookup.teams.nodes[0]
  if (!team) throw new Error(`Linear team "${target.teamKey}" not found`)

  // Labels: reuse by case-insensitive name, create what is missing.
  const existing = new Map(team.labels.nodes.map((l) => [l.name.toLowerCase(), l.id]))
  const labelIds: string[] = []
  for (const name of ticket.labels) {
    let id = existing.get(name.toLowerCase())
    if (!id) {
      const created = await gql<{ issueLabelCreate: { issueLabel: { id: string } } }>(
        target,
        `mutation ($name: String!, $teamId: String!) {
          issueLabelCreate(input: { name: $name, teamId: $teamId }) { issueLabel { id } }
        }`,
        { name, teamId: team.id },
        fetchImpl,
      )
      id = created.issueLabelCreate.issueLabel.id
    }
    labelIds.push(id)
  }

  let stateId: string | undefined
  if (ticket.ready) {
    stateId = team.states.nodes
      .filter((s) => s.type === 'unstarted')
      .sort((a, b) => a.position - b.position)[0]?.id
  }

  let projectId: string | undefined
  if (target.projectSlug) {
    const project = await gql<{ projects: { nodes: { id: string }[] } }>(
      target,
      `query ($slug: String!) { projects(filter: { slugId: { eq: $slug } }) { nodes { id } } }`,
      { slug: target.projectSlug },
      fetchImpl,
    )
    projectId = project.projects.nodes[0]?.id
    if (!projectId) throw new Error(`Linear project "${target.projectSlug}" not found`)
  }

  const input: Record<string, unknown> = {
    teamId: team.id,
    title: ticket.title,
    description: ticket.body,
    labelIds,
  }
  if (stateId) input.stateId = stateId
  if (projectId) input.projectId = projectId

  const created = await gql<{ issueCreate: { success: boolean; issue: { identifier: string; url: string } | null } }>(
    target,
    `mutation ($input: IssueCreateInput!) {
      issueCreate(input: $input) { success issue { identifier url } }
    }`,
    { input },
    fetchImpl,
  )
  const issue = created.issueCreate.issue
  if (!created.issueCreate.success || !issue) throw new Error('Linear did not create the issue')
  return { url: issue.url, identifier: issue.identifier }
}
