# pr-goblin

A plug-in module that turns a user's or tester's bug report into a proposed fix:

```
 widget in your app ──▶ intake endpoint ──▶ ticket ──▶ runner ──▶ pull request
 (report + context)     (your server)       (Linear or  (polls,    (a human
                                             GitHub)     runs an    reviews and
                                                         agent)     merges)
```

It never merges. Every fix arrives as a pull request for a human to review, and your CI is the gate.

> **Status: pre-release.** The parts are built and unit-tested, but the whole loop has not yet been run against a live tracker with a real coding agent. See [docs/SPEC.md](docs/SPEC.md) for exactly what is and is not verified.

## The parts

| Folder | What it is | Runs where |
|---|---|---|
| `widget/` | Feedback button and form. Captures URL, browser, viewport, an optional screenshot, and the page's recent console and network errors. | In your web app |
| `intake/` | One HTTP endpoint that turns a report into a ticket. Holds the tracker token so the browser never sees it. | Cloudflare Worker or any Node 20+ server |
| `actions/triage/` | GitHub Action: classifies a new report, assesses severity, drafts a fix plan as a comment. | GitHub Actions |
| `runner/` | Polls the tracker, runs a coding agent (Claude Code or Codex) in an isolated git worktree per ticket, opens a PR. | A machine you keep running, or a scheduled CI job |

Use all four, or only the runner against tickets you write by hand.

## Rules it follows

**Lanes — when a ticket is worked**

| Ticket has | Lane | What happens |
|---|---|---|
| Linear priority *Urgent*, or a label `critical` / `severity:critical` / `urgent` | urgent | Worked on the next poll, ahead of everything else |
| a label `batch` or `batch:<anything>` | batch | Held until the batch window (02:00–05:00 local by default), then released, at most 5 per cycle |
| anything else | normal | Worked on the next poll |

**Trust — what the agent may do**

A report from the public widget is labelled `untrusted`, because its text is written by a stranger and becomes input to an agent.

| Ticket | What happens |
|---|---|
| untrusted | Held. No agent runs until a human removes the `untrusted` label. |
| untrusted **and** urgent | An agent investigates **read-only** and posts its findings on the ticket. No branch, no commit, no PR. Then it is held like the rest. |
| trusted | Implemented, PR opened. |

Severity is set by the triage step, not by the reporter, so a stranger cannot mark their own report critical. Feature requests are never picked up automatically.

Reports from your own testers can skip the `untrusted` label: your app's backend signs the tester's login with a shared secret and the widget forwards the proof. See [Trusted reporters](#trusted-reporters).

## Quick start: runner only, on GitHub Actions

Needs no server and no settings file. Copy [`examples/goblin.yml`](examples/goblin.yml) to `.github/workflows/` in your repo and add two secrets:

| Secret | Why |
|---|---|
| `ANTHROPIC_API_KEY` | The coding agent |
| `GOBLIN_GH_TOKEN` | A fine-grained token for this repo: Contents, Issues and Pull requests read/write. The built-in `GITHUB_TOKEN` also works, but PRs it opens do not trigger your CI. |

Then put the `goblin` label on an issue. To use Linear as the tracker instead, add `LINEAR_API_KEY`, `GOBLIN_LINEAR_TEAM` and `GOBLIN_LINEAR_PROJECT`.

Scheduled workflows on GitHub run at most every 5 minutes and are often late. For an urgent lane that is actually fast, run the runner as a daemon.

## Quick start: runner as a daemon

On a machine that stays on (a VPS, or your own computer while it is awake). Needs [Bun](https://bun.sh), the `gh` CLI signed in, and Claude Code or Codex installed.

```sh
cd runner && bun install
export GOBLIN_REPO=owner/repo           # GitHub Issues as the tracker
bun src/cli/app.ts run                  # foreground; `start` runs it in the background
```

For Linear, run `bun src/cli/app.ts init` once instead of setting `GOBLIN_REPO`: it asks for the API key, team, project and repo, and writes `~/.pr-goblin/settings.json`.

It polls every 30 seconds. `bun src/cli/app.ts once` does a single pass and exits, which is what the CI workflow uses.

## Runner configuration

Environment variables win over `~/.pr-goblin/settings.json`.

| Variable | Meaning | Default |
|---|---|---|
| `GOBLIN_SOURCE` | `github` or `linear` | `linear` if `LINEAR_API_KEY` is set, else `github` |
| `GOBLIN_REPO` | `owner/repo` to work on | `GITHUB_REPOSITORY` (set by GitHub Actions) |
| `GOBLIN_BASE_BRANCH` | Branch PRs target | `main` |
| `LINEAR_API_KEY` | Linear personal API key | — |
| `GOBLIN_LINEAR_TEAM` | Linear team key, e.g. `ENG` | — |
| `GOBLIN_LINEAR_PROJECT` | Linear project slug | — |
| `GOBLIN_AGENT` | `claude` or `codex` | `claude` |
| `GOBLIN_MAX_CONCURRENT` | Agents running at once | `2` |

Lane and trust labels, the batch window and batch size are set under `policy` in `settings.json`; the defaults are in [`runner/src/kernel/policy.ts`](runner/src/kernel/policy.ts).

**How state is kept on each tracker**

| | Ready | In progress | In review | Parked after a failure |
|---|---|---|---|---|
| Linear | *Todo* | *In Progress* | *In Review* | moved to *Backlog* |
| GitHub Issues | label `goblin` | `goblin:in-progress` | `goblin:in-review` | `goblin` label removed |

## Intake and widget

Deploy the endpoint, then load the widget:

```html
<script src="pr-goblin.iife.js"></script>
<script>
  PrGoblin.init({ endpoint: 'https://your-intake.example/feedback', projectName: 'My App' })
</script>
```

The widget takes on the look of the page it is on. At start-up, and again each time the dialog opens or the page switches between light and dark, it reads the page's brand colour, background, text colour, font and corner radius — from design tokens such as `--primary` and `--radius` (shadcn/ui, Bootstrap, MUI, Mantine and similar) or, failing that, from the page's own buttons. Any `--bp-*` variable you set in your own CSS is left alone, `color: '#rrggbb'` still pins the brand colour, and `theme: 'none'` turns the behaviour off.

Build the widget with `cd widget && pnpm install && pnpm build`. Pass `captureLogs: false` to turn off console and network error capture. Pass `screenshot: false` to hide the screenshot option, for apps whose pages show data that must not leave as an image (set `SCREENSHOTS=off` on the intake to enforce it server-side). Captured URLs have their query strings removed, and request and response bodies are never read.

**Intake as a Node server**

```sh
cd intake && pnpm install && pnpm build:node
ALLOWED_ORIGIN=https://yourapp.example GITHUB_REPO=owner/repo GITHUB_TOKEN=... node dist/node.mjs
```

**Intake inside your own app.** If your app already has a server, mount the endpoint in it instead of deploying another service. `cd intake && pnpm build:lib` writes `dist/pr-goblin-intake.mjs`, one ES module with no dependencies; copy it into your app. In a Next.js route handler:

```ts
// app/api/feedback/route.ts
import { handleFeedbackRequest, envFromRecord } from '@/vendor/pr-goblin-intake.mjs'
export const POST = (req: Request) => handleFeedbackRequest(req, envFromRecord(process.env))
```

It answers at whatever path you mount it on. Rate limiting and a request-size cap are then yours to add, as is any check that the reporter is signed in.

**Intake as a Cloudflare Worker:** `cd intake && pnpm install && pnpm run deploy`, with the same settings as Worker secrets.

| Setting | Meaning |
|---|---|
| `ALLOWED_ORIGIN` | Your app's origin(s), comma-separated. Required. |
| `GITHUB_REPO`, `GITHUB_TOKEN` | Create tickets as GitHub issues, and store screenshots in the repo. |
| `LINEAR_API_KEY`, `LINEAR_TEAM_KEY`, `LINEAR_PROJECT` | Create tickets in Linear instead. Set the GitHub pair as well if you want screenshots. |
| `TRUST_SECRET` | Enables trusted reporters (below). |
| `WEBHOOK_SECRET` | Enables the Approve link in triage notifications. |
| `SCREENSHOTS` | `off` drops screenshots server-side, so none is stored. Pair with the widget's `screenshot: false`. |
| `PORT`, `RATE_LIMIT_PER_MIN`, `TRUST_PROXY` | Node server only: port (8787), reports per IP per minute (5), read the client IP from `X-Forwarded-For`. |

### Trusted reporters

Your backend, for a signed-in tester, computes a proof and gives it to the page:

```js
import { createHmac } from 'node:crypto'
const proof = createHmac('sha256', process.env.TRUST_SECRET).update(user.login).digest('hex')
```

```js
PrGoblin.init({ endpoint, user: { name: user.name, login: user.login, proof } })
```

The intake endpoint, holding the same `TRUST_SECRET`, verifies it. A report without a valid proof is still accepted, labelled `untrusted`.

## Development

```sh
cd runner  && bun install  && bun test src/ && bunx tsc --noEmit
cd widget  && pnpm install && pnpm test
cd intake  && pnpm install && pnpm test && pnpm typecheck
cd actions/triage && pnpm install && pnpm test
```

## Credits and licence

MIT. The widget, intake endpoint and triage action started from [bugpilot](https://github.com/rodlunt/bugpilot) by rodlunt; the runner started from [reeve](https://github.com/ianchenx/reeve) by Ian Chen and contributors. Both are MIT; see [NOTICE.md](NOTICE.md).
