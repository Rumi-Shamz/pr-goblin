# pr-goblin: specification and status

Last updated 2026-11-12.

## Goal

A module you plug into a project so that issues reported by users and testers are captured with enough context, turned into tickets, and answered with a proposed fix as a pull request, with a human deciding what merges.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Language | TypeScript throughout | The widget must be browser code; Linear's and GitHub's tooling is native to it |
| Trigger | Polling, not webhooks | No relay server to deploy; a few seconds to minutes of delay is the cost |
| Where the runner runs | Both a long-running daemon and a one-shot CI job | Same code path: the daemon loops what `goblin once` does once |
| Coding agent | Shell out to Claude Code or Codex | The agent is not the product; a better agent should drop in |
| Intake | Short form, automatic context capture, model fills gaps | Research on chat vs form intake is thin; unstructured chat lowers report quality |
| Lanes | Urgent now, batch in a window, normal on next poll | Critical work should not wait; cosmetic work should not interrupt |
| Trust | Reports are untrusted unless the host backend signs the reporter | Report text becomes agent input |
| Merging | Never automatic | CI and a human are the gate |

## What exists

| Part | Built | Automated tests |
|---|---|---|
| Runner: Linear source (from reeve) | yes | yes |
| Runner: GitHub Issues source, state in labels | yes | 14 |
| Runner: lane and trust policy | yes | 17 |
| Runner: read-only investigate mode | yes | covered in kernel + rules tests |
| Runner: `goblin once` for CI, config from environment variables | yes | yes |
| Runner: concurrency cap | yes | yes |
| Intake: GitHub target (from bugpilot) | yes | yes |
| Intake: Linear target | yes | 6, against a faked Linear API |
| Intake: trusted-reporter proof | yes | 9 |
| Intake: Node server with rate limiting | yes | 7, over real HTTP |
| Intake: Approve webhook relabels the issue | yes | 6 |
| Widget: console and network error capture | yes | 12 |
| Triage action (from bugpilot) | yes, unchanged apart from naming | 33 |

Test totals at this commit: runner 335, intake 74, widget 63, triage 33.

## What has not been verified

Be clear about these before relying on it.

1. **No end-to-end run.** No real ticket has yet gone through a real agent to a real PR with this code. The runner's kernel is tested with a fake agent and fake tracker.
2. **Linear calls are untested against the live API.** Intake's issue creation (team lookup, label creation, project lookup by `slugId`) and the runner's `addLabel` were written from the API schema and tested only against fakes.
3. **`examples/goblin.yml` has not been run in GitHub Actions.** In particular: agent authentication in CI, and `gh auth setup-git` being enough for the runner's clone and push.
4. **Investigate mode is enforced by instructions only.** See the threat model.
5. **`goblin once` was smoke-tested live only on the empty path** (poll a real repo, find nothing, exit 0).
6. **`goblin init` is still the Linear-only wizard** inherited from reeve.

## Not built yet

| Item | Notes |
|---|---|
| Follow-up questions for missing fields | The agreed "middle path": after submit, a model asks at most one or two questions when steps or expected behaviour are missing. Needs an intake endpoint that calls a model and a second widget step. |
| Batch as one PR | Batch tickets are released together but each still gets its own PR. One session, one commit per ticket, one PR is the intended design. |
| Triage for Linear tickets | The triage action is triggered by GitHub issue events. Linear tickets get no triage comment or severity label unless a human sets priority. |
| Approve link for Linear tickets | The approval token names a GitHub issue. |
| Screenshots without a GitHub repo | With a Linear-only intake the screenshot is dropped. Linear's file upload API is the fix. |
| Chat intake | Planned as an optional extension, bring your own key. |
| Single-binary runner | `bun build --compile`, so users need no Bun install. |
| Publishing | npm package for the widget, a tagged release for the action. |

## Suggested order

1. Run the loop end to end on a throwaway repo with GitHub Issues, as a daemon. Fix what breaks.
2. Run `examples/goblin.yml` in that repo.
3. Repeat with a throwaway Linear team.
4. Batch as one PR.
5. Follow-up questions.
