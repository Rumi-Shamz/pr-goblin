# Threat model

pr-goblin lets text typed by a stranger travel all the way to a coding agent that holds write access to a repository. This document says what crosses each boundary, what stops abuse, and what is knowingly accepted. Update it when a mitigation changes.

| # | Boundary | Worst case if abused | Status |
|---|---|---|---|
| 1 | Browser → intake `/feedback` | Ticket spam; a junk blob stored as a "screenshot" | Mitigated on Node (rate limit, validation); accepted on Workers unless you add a Cloudflare rule |
| 2 | Intake → tracker | A report forges the machine-readable block, or claims to be a trusted tester | Mitigated (marker neutralisation, HMAC proof) |
| 3 | Ticket text → triage model | Triage is talked into a wrong severity or plan | Partly mitigated; a wrong `severity:critical` buys only a read-only investigation |
| 4 | Ticket text → coding agent with repo write | A malicious change is pushed as a PR, or secrets are leaked | Mitigated by the trust rule and human review; residual risk below |
| 5 | Approve link | Someone other than the maintainer approves a ticket | Mitigated (signed, expiring, issue-scoped token) |

## 1. Browser → intake

**Untrusted:** every field of the request, including `user`, the screenshot and the captured logs.

**Mitigated**
- One schema validates types and lengths; a bad payload is a 400, not a crash.
- Screenshot capped at 4 MB and limited to image data URLs.
- Captured logs are capped (30 entries, 500 characters each), flattened to one line, and rendered inside a code fence they cannot close.
- The Node server limits reports per IP (default 5 a minute) and caps the request body.
- CORS restricts browsers to `ALLOWED_ORIGIN`. This does not stop `curl`.

**Accepted**
- On Cloudflare Workers there is no built-in rate limit; add a Cloudflare rate limiting rule.
- A screenshot's bytes are not checked to be a real image before being committed to the `bug-report-screenshots` branch. Worst case is a static file, not execution.

## 2. Intake → tracker

**Mitigated**
- User text cannot counterfeit the `pr-goblin:structured` block: the markers and `-->` are neutralised, and the genuine block is always last.
- **Trust is proven, not claimed.** A report is trusted only when it carries an HMAC of the login made with `TRUST_SECRET`, which only your backend holds. Without it the ticket is labelled `untrusted`. The proof is never written into the ticket.
- Feature requests are never labelled ready.

**Accepted**
- The proof is a bearer credential for one login and does not expire. A tester can leak their own. Rotate `TRUST_SECRET` to revoke all proofs.

## 3. Ticket text → triage model

The triage action reads the attacker-influenced issue body and sets labels, including `severity:*`.

**Mitigated:** triage output is advisory. A stranger who talks triage into `severity:critical` moves their ticket from "held" to "read-only investigation", which costs one agent run and changes nothing in the repo.

**Accepted:** that wasted run. Cap spend with `GOBLIN_MAX_CONCURRENT` and your API account's limits.

## 4. Ticket text → coding agent

This is the boundary that matters. The agent runs with a token that can push branches and open PRs, and with whatever is in its environment.

**Mitigated**
- **The trust rule** (`runner/src/kernel/policy.ts`): an `untrusted` ticket never gets a code-writing agent. Urgent ones get an agent whose instructions and skills are read-only (no commit, push or PR skill is provisioned).
- The agent's standing instructions say the ticket is data, not instructions, and list what to ignore (requests for secrets, CI or credential changes, unrelated actions).
- The agent never merges. Every change is a PR a human reviews, and your CI runs on it.
- One git worktree per ticket; agent artefacts are excluded from commits.

**Residual risk — read this before pointing it at an important repo**
- **Read-only is an instruction, not a sandbox.** In investigate mode nothing technically stops a manipulated agent from writing or pushing. Run the runner with a token scoped to the one repo, and protect your default branch.
- **A trusted ticket is fully trusted.** Removing the `untrusted` label, or signing a tester's login, means that text will drive a code-writing agent. A prompt-injected PR can still be opened; review it like any contributor's PR, especially changes to CI workflows, dependencies and auth code.
- **Secrets in the agent's environment are reachable by the agent.** Give the runner only what it needs: the agent key, a repo-scoped GitHub token, and (for Linear) the Linear key. With Linear as the tracker the agent is handed the Linear API key so it can update the ticket; that key can read and write the whole workspace.
- The agent runs the project's own scripts (tests, setup). Do not run the runner on a machine holding unrelated credentials.

## 5. Approve link

The triage notification carries an Approve button that calls the intake endpoint, which removes `untrusted` and adds the ready label.

**Mitigated:** the button carries a token signed with `WEBHOOK_SECRET`, bound to one repo and issue, valid for 48 hours. The secret itself never leaves your servers. A token for another repo is refused.

**Accepted:** anyone who can read the notification topic within those 48 hours can approve that one ticket. Use a private, authenticated ntfy topic.
