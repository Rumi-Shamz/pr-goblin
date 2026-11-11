import * as core from '@actions/core'
import * as github from '@actions/github'
import Anthropic from '@anthropic-ai/sdk'
import { parseStructuredBlock, buildUserMessage, buildComment, deriveLabels, ntfyServerAndTopic, applyHouseStyle, buildAnthropicClientOptions, signApprovalToken } from './lib.mjs'

const SYSTEM_PROMPT = `You are a senior engineer triaging user-submitted bug reports and feature requests.
You will be given a structured report from bugpilot. Analyse it carefully and call the triage_report tool with your assessment.

For bugs:
- Is it reproducible given the information provided?
- What is the likely root cause?
- What is the proposed fix? Be specific about what code or behaviour needs to change: one or two sentences, no actual code.

For feature requests:
- Is it feasible and well-defined?
- What is the effort level?
- proposed_fix should be null.

Always draft a response_draft to post back to the reporter. It is a short reply from a competent engineer: state what was understood from the report and what will happen next. Nothing else.

House style for every piece of prose you write (proposed_fix and response_draft):
- Australian English spelling (organise, colour, analyse, behaviour, defence).
- Never use an em dash or an en dash. Use a comma, a colon, a full stop or parentheses instead.
- Never use the words "honestly", "worth noting", "worth flagging", "worth mentioning" or "load-bearing".
- Never use "flag" or "flagging" to mean raising or reporting a point ("thanks for flagging", "I want to flag"). Say "reporting" or "raising" if you need the idea at all.
- Plain register: no exclamation marks, no emoji, no greetings such as "Hi" or "Hey", no thanks, no praise, no encouragement ("keep the feedback coming"), no apologies and no marketing tone.
- Do not restate the report back at length. Two to four sentences is the normal length for response_draft.`

async function run() {
  const auth = buildAnthropicClientOptions(
    {
      apiKey: core.getInput('anthropic-api-key'),
      federationRuleId: core.getInput('anthropic-federation-rule-id'),
      organizationId: core.getInput('anthropic-organization-id'),
      serviceAccountId: core.getInput('anthropic-service-account-id'),
      workspaceId: core.getInput('anthropic-workspace-id'),
    },
    { getIDToken: core.getIDToken },
  )
  core.info(`Anthropic auth: ${auth.mode}`)
  const token = core.getInput('github-token')
  const model = core.getInput('model') || 'claude-sonnet-4-6'

  const octokit = github.getOctokit(token)
  const { context } = github
  const issue = context.payload.issue
  const { owner, repo } = context.repo

  const labelNames = issue.labels.map((l) => l.name)
  if (!labelNames.includes('user-feedback')) {
    core.info('No user-feedback label, skipping')
    return
  }

  const structured = parseStructuredBlock(issue.body)
  const issueUrl = `https://github.com/${owner}/${repo}/issues/${issue.number}`
  core.info(`Triaging issue #${issue.number} (type: ${structured?.type ?? 'unknown'})`)

  // Feature requests do not need AI triage: acknowledge and notify
  if (structured?.type === 'feature' || labelNames.includes('enhancement')) {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: issue.number,
      body: `### Feature request logged\n\nThis has been added to the backlog for review. [View issue](${issueUrl})`,
    })
    const ntfyTopic = core.getInput('ntfy-topic')
    const ntfyToken = core.getInput('ntfy-token')
    if (ntfyTopic) {
      await sendNtfyFeature({ ntfyTopic, ntfyToken, issue, issueUrl })
    }
    return
  }

  const client = new Anthropic(auth.options)

  const message = await client.messages.create({
    model,
    max_tokens: 1024,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    tools: [triageTool()],
    tool_choice: { type: 'tool', name: 'triage_report' },
    messages: [
      {
        role: 'user',
        content: buildUserMessage(issue, structured),
      },
    ],
  })

  const toolUse = message.content.find((b) => b.type === 'tool_use')
  if (!toolUse) {
    core.setFailed('Claude did not call triage_report tool')
    return
  }

  const triage = applyHouseStyle(toolUse.input)
  core.info(`Triage result: ${JSON.stringify(triage)}`)

  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issue.number,
    body: buildComment(triage),
  })

  const newLabels = deriveLabels(triage)
  if (newLabels.length) {
    await ensureLabelsExist(octokit, owner, repo, newLabels)
    await octokit.rest.issues.addLabels({
      owner,
      repo,
      issue_number: issue.number,
      labels: newLabels,
    })
  }

  const ntfyTopic = core.getInput('ntfy-topic')
  const ntfyToken = core.getInput('ntfy-token')
  const webhookSecret = core.getInput('webhook-secret')
  const workerBase = core.getInput('bugpilot-worker-url') || process.env.BUGPILOT_WORKER_URL
  if (ntfyTopic) {
    await sendNtfy({ ntfyTopic, ntfyToken, webhookSecret, workerBase, issue, issueUrl, triage, owner, repo })
  }
}

function triageTool() {
  return {
    name: 'triage_report',
    description: 'Submit triage results for a user report',
    input_schema: {
      type: 'object',
      required: ['classification', 'response_draft'],
      properties: {
        classification: {
          type: 'string',
          enum: ['bug', 'feature', 'not-feasible', 'spam', 'needs-info'],
          description: 'Type of report',
        },
        severity: {
          type: 'string',
          enum: ['critical', 'high', 'medium', 'low'],
          description: 'Bug severity only. Omit for features.',
        },
        reproducible: {
          type: 'boolean',
          description: 'Whether the bug appears reproducible from the report',
        },
        proposed_fix: {
          type: 'string',
          description: 'Concise description of what needs to change to fix the bug. Null for features.',
        },
        response_draft: {
          type: 'string',
          description: 'Short plain-register reply to post to the reporter: what was understood and what will happen next',
        },
      },
    },
  }
}






async function sendNtfyFeature({ ntfyTopic, ntfyToken, issue, issueUrl }) {
  const { server, topic } = ntfyServerAndTopic(ntfyTopic)
  const headers = { 'Content-Type': 'application/json' }
  if (ntfyToken) headers['Authorization'] = `Bearer ${ntfyToken}`
  const payload = {
    topic,
    title: 'Feature request submitted',
    message: issue.title.replace(/^\[.*?\]\s*Feature:\s*/, '').slice(0, 120),
    actions: [
      { action: 'view', label: '🔵 View request', url: issueUrl },
    ],
  }
  const res = await fetch(server, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    core.warning(`NTFY notification failed: ${res.status} ${await res.text()}`)
  } else {
    core.info('NTFY feature notification sent')
  }
}

async function sendNtfy({ ntfyTopic, ntfyToken, webhookSecret, workerBase, issue, issueUrl, triage, owner, repo }) {

  const severityPart = triage.severity ? ` [${triage.severity}]` : ''
  const title = `Bug${severityPart}: ${issue.title.replace(/^\[.*?\]\s*Bug:\s*/, '').slice(0, 80)}`
  const message = triage.proposed_fix || 'Triage complete. No fix proposed.'

  const actions = []

  if (workerBase && webhookSecret) {
    // The raw webhook secret never goes in the notification: the ntfy
    // "http" action's headers are part of the message published to the
    // topic, so anything here is legible to anyone who can read that topic.
    // A signed, expiring, issue-scoped token stands in for it instead. See
    // lib.mjs (signApprovalToken) for the wire format and why.
    const approvalToken = await signApprovalToken({ webhookSecret, owner, repo, issueNumber: issue.number })
    actions.push({
      action: 'http',
      label: '🟢 Approve',
      url: `${workerBase}/webhook/apply-fix`,
      method: 'POST',
      headers: { 'x-approval-token': approvalToken },
    })
  } else {
    // Stub until apply-fix Worker endpoint is deployed
    actions.push({
      action: 'view',
      label: '🟢 Approve',
      url: issueUrl,
    })
  }

  actions.push({
    action: 'view',
    label: '🔴 Manual review',
    url: issueUrl,
  })

  const { server, topic } = ntfyServerAndTopic(ntfyTopic)
  const headers = { 'Content-Type': 'application/json' }
  if (ntfyToken) headers['Authorization'] = `Bearer ${ntfyToken}`
  const payload = { topic, title, message, actions }

  const res = await fetch(server, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  })

  if (!res.ok) {
    core.warning(`NTFY notification failed: ${res.status} ${await res.text()}`)
  } else {
    core.info('NTFY notification sent')
  }
}

async function ensureLabelsExist(octokit, owner, repo, labels) {
  const colorMap = {
    'triage:confirmed-bug': 'd73a4a',
    'triage:feature-request': 'a2eeef',
    'triage:not-feasible': 'e4e669',
    'triage:spam': 'cfd3d7',
    'triage:needs-info': 'd876e3',
    'severity:critical': 'b60205',
    'severity:high': 'e4e669',
    'severity:medium': '0075ca',
    'severity:low': 'cfd3d7',
  }
  for (const label of labels) {
    try {
      await octokit.rest.issues.getLabel({ owner, repo, name: label })
    } catch (err) {
      if (err.status !== 404) throw err
      await octokit.rest.issues.createLabel({
        owner,
        repo,
        name: label,
        color: colorMap[label] ?? 'ededed',
      })
    }
  }
}

run().catch(core.setFailed)
