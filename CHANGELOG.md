# Changelog

Releases are tagged `vX.Y.Z`; the tag `v0` always points at the latest 0.x release. See [Updating](README.md#updating) for how users receive a release.

While the version is 0.x, a minor release (0.**2**.0) may change behaviour or settings; such changes are listed under **Breaking**. A patch release (0.1.**1**) only fixes things.

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
