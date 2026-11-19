# Changelog

Releases are tagged `vX.Y.Z`; the tag `v0` always points at the latest 0.x release. See [Updating](README.md#updating) for how users receive a release.

While the version is 0.x, a minor release (0.**2**.0) may change behaviour or settings; such changes are listed under **Breaking**. A patch release (0.1.**1**) only fixes things.

## Unreleased

- **Runner: review first.** With `GOBLIN_REVIEW_FIRST=1` (or `"reviewFirst": true`), every ticket is investigated read-only, a second agent challenges the diagnosis, and nothing is fixed until a human adds `goblin:approved`. `goblin:reinvestigate` with a comment has it investigate again and answer the comment. See [Review first](README.md#review-first).
- **Runner: challenge agent.** `GOBLIN_CHALLENGE` picks the agent and model that challenges investigations, for example `claude:opus`. It also works without review first, on the read-only investigations of urgent untrusted reports.
- **Runner: `goblin:approved` and `goblin:reinvestigate` work on untrusted reports too.** Approving is the same decision as removing the `untrusted` label.
- **Runner: a model per post-agent.** `post: { "review": "claude:opus" }` now picks the model as well as the agent.
- The implementing agent now reads the investigation, the challenge and the maintainers' comments after them, and treats other people's comments as untrusted input.
- **Release candidates.** A tag `vX.Y.Z-rc.N` publishes a pre-release on GitHub and the widget under npm's `next` dist-tag, without moving `v0` or `latest`. See [Updating](README.md#updating).

## 0.1.1 — 2026-11-19

- **Widget on npm.** Install it with `npm install pr-goblin-widget` or load it from `https://cdn.jsdelivr.net/npm/pr-goblin-widget@0/dist/pr-goblin.iife.js`. Each release publishes it at the release's version. `PrGoblin.version` and the bundle banner now report that version (it said `1.3.1`, a leftover from bugpilot).
- **Runner tests run each file in isolation** (`bun test src/ --isolate`), so a module mock in one test file can no longer break another. Contributors need a Bun version with `--isolate` (1.4 or later).

## 0.1.0 — 2026-11-12

First release. Everything below is new.

- **Runner.** Polls Linear or GitHub Issues, runs Claude Code or Codex in a git worktree per ticket, opens a PR against the configured base branch. Urgent, normal and batch lanes; untrusted reports held for a human, or investigated read-only when urgent. `goblin once` for CI.
- **Runner: subscription sign-in.** The agent can run on a Claude Pro/Max or ChatGPT subscription instead of an API key: signed in on the machine, or `CLAUDE_CODE_OAUTH_TOKEN` in CI. The runner prints which credentials each agent will use and warns when an API key would silently take precedence. `GOBLIN_AUTH=subscription` ignores API keys.
- **Runner: usage limits.** When the agent hits a subscription cap or an API rate limit, the ticket is requeued for after the reset without spending a retry, and nothing else is dispatched until then. `goblin once` exits early instead of idling to its deadline.
- **Widget.** Feedback button and form with console and network error capture, auto-theming from the host page, trusted-reporter proof.
- **Widget: screenshot masking.** Form field values are hidden in screenshots by default. Elements marked `data-goblin-mask` (or `data-private`, `.sentry-mask`, `.rr-mask`, `.fs-mask` and similar) are always blacked out; `maskSelectors` adds your own. `mask: 'all'` keeps only the layout.
- **Widget: reporter redaction.** The reporter can drag boxes over the screenshot preview to black out anything else before sending. If the boxes cannot be applied, no screenshot is sent.
- **Intake.** Endpoint as a Cloudflare Worker, a Node server, or a module inside your own app. GitHub or Linear target, rate limiting (Node), Approve webhook, `SCREENSHOTS=off`.
- **Intake: screenshots stay private.** Screenshots are stored only when `GITHUB_REPO` is a private repository, since they are committed to it. `SCREENSHOTS=public` allows a public one.
- **Triage action.** Classifies new reports, assesses severity, drafts a fix plan.
