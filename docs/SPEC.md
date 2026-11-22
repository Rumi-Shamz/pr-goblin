# pr-goblin: specification and status

Last updated 2026-11-22.

## Goal

A module you plug into a project so that issues reported by users and testers are captured with enough context, turned into tickets, and answered with a proposed fix as a pull request, with a human deciding what merges.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Language | TypeScript throughout | The widget must be browser code; Linear's and GitHub's tooling is native to it |
| Trigger | Polling, not webhooks, for the daemon. In CI, the reusable workflow starts on issue label events plus an hourly sweep, and each run still polls once | No relay server to deploy. A `*/15` cron bills at least a minute per run even with no tickets (about 2,900 minutes a month on a private repo, over the free 2,000), so CI mode lets GitHub deliver the label event and keeps polling only as a slow sweep |
| Where the runner runs | Both a long-running daemon and a one-shot CI job | Same code path: the daemon loops what `goblin once` does once |
| CI wiring | One reusable workflow (`goblin-runner.yml`) that repos call from a thin workflow; it checks out the runner at its own commit | Repos stopped carrying hand-copied, drifting workflows; one pin upgrades both. Credentials are passed explicitly; an optional GitHub App replaces the token |
| Coding agent | Shell out to Claude Code or Codex | The agent is not the product; a better agent should drop in |
| Intake | Short form, automatic context capture, model fills gaps | Research on chat vs form intake is thin; unstructured chat lowers report quality |
| Lanes | Urgent now, batch in a window, normal on next poll | Critical work should not wait; cosmetic work should not interrupt |
| Trust | Reports are untrusted unless the host backend signs the reporter | Report text becomes agent input |
| Merging | Never automatic | CI and a human are the gate |
| Review before fixing | Opt-in (`reviewFirst`): investigate read-only, a second agent challenges the diagnosis, a human approves or asks for more | A human should decide on a diagnosis that has been argued against, not on one agent's first answer. Opt-in because it doubles agent runs and adds a human round trip |

## What exists

| Part | Built | Automated tests |
|---|---|---|
| Runner: Linear source (from reeve) | yes | yes |
| Runner: GitHub Issues source, state in labels | yes | 14 |
| Runner: lane and trust policy | yes | 17 |
| Runner: read-only investigate mode | yes | covered in kernel + rules tests |
| Runner: review first, challenge agent, approve / reinvestigate labels | yes | 6 kernel, 6 policy, 3 challenge rules, 2 rules, 6 config, 1 GitHub source |
| Runner: model per post-agent (`claude:opus`) | yes | 2 (parsing only; the `--model` / `-c model=` flags are not exercised) |
| Runner: `goblin once` for CI, config from environment variables | yes | yes |
| Reusable CI workflows (`goblin-runner.yml`, `goblin-lock.yml`) and thin example callers | yes | 14 workflow-text checks in `example-workflow.test.ts` (SHA pins, triggers, no sub-hourly cron, identity); run on GitHub with fake credentials as far as the git-identity step |
| Runner: concurrency cap | yes | yes |
| Intake: GitHub target (from bugpilot) | yes | yes |
| Intake: Linear target | yes | 6, against a faked Linear API |
| Intake: trusted-reporter proof | yes | 9 |
| Intake: Node server with rate limiting | yes | 7, over real HTTP |
| Intake: Approve webhook relabels the issue | yes | 6 |
| Widget: console and network error capture | yes | 12 |
| Widget: screenshot masking and reporter redaction | yes | 7 (masking in jsdom; the canvas paint step is not exercised there) |
| Intake: screenshots stored only in a private repo | yes | 3 |
| Runner: subscription sign-in detection, `GOBLIN_AUTH` | yes | 8 |
| Runner: usage limits pause instead of failing | yes | 8 + 2 kernel |
| Tagged releases, `v0` major tag, widget on npm with provenance | yes | ran for v0.1.1; release candidates (`-rc.N` → npm `next`) not yet run |
| Triage action (from bugpilot) | yes, unchanged apart from naming | 33 |

Test totals at this commit: runner 399, intake 82, widget 97, triage 33.

## What has not been verified

Be clear about these before relying on it.

1. **No end-to-end run.** No real ticket has yet gone through a real agent to a real PR with this code. The runner's kernel is tested with a fake agent and fake tracker.
2. **Linear calls are untested against the live API.** Intake's issue creation (team lookup, label creation, project lookup by `slugId`) and the runner's `addLabel` were written from the API schema and tested only against fakes.
3. **The reusable runner workflow has not completed a real run in GitHub Actions.** A run with fake credentials got as far as the git-identity step: checkout at the workflow's own commit, Bun, pnpm, Node and the agent install all worked. Not exercised: agent authentication in CI, `gh auth setup-git` being enough for the runner's clone and push, the label-event trigger, the hourly sweep, and the GitHub App token path.
4. **Investigate mode is enforced by instructions only.** See the threat model.
5. **`goblin once` was smoke-tested live only on the empty path** (poll a real repo, find nothing, exit 0).
6. **`goblin init` is still the Linear-only wizard** inherited from reeve.
7. **Usage-limit detection is matched against known message formats, not observed live.** Claude's messages ("usage limit reached|<epoch>", "5-hour limit reached ∙ resets 3pm") and API 429s are recognised; Codex's are best effort, and a Codex limit that exits with code 0 would not be caught. An unrecognised limit falls back to the ordinary retry, which spends retries and may park the ticket.
8. **The review-first loop has not run against a real agent.** The kernel's part (states, labels, the cap, a failing challenge) is tested with fakes; whether the challenge agent finds and answers the investigation comment, and whether agents respect the maintainer-only rule for comments, is untested. Linear's `removeLabel` was written from the API schema only.
9. **Screenshot masking was checked in Chromium only.** Form values, `data-goblin-mask` and custom selectors were blacked out in the captured image and the reporter's box was painted into the outgoing image; Firefox and Safari were not tried.

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
| npm packages beyond the widget | The widget is published as `pr-goblin-widget`. The intake is not; the name `pr-goblin` (a 0.0.1 placeholder) is kept for the runner as a CLI (`npx pr-goblin`). |

## Suggested order

1. Run the loop end to end on a throwaway repo with GitHub Issues, as a daemon. Fix what breaks.
2. Run `examples/goblin.yml` in that repo.
3. Repeat with a throwaway Linear team.
4. Batch as one PR.
5. Follow-up questions.
