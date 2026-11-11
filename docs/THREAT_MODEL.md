# Threat model

bugpilot moves data across four trust boundaries: an anonymous browser into a Worker, a Worker
into a GitHub repo, GitHub issue content into an LLM with repo-write credentials, and a Worker
into a human's phone via a third-party push service. This is a snapshot of what crosses each one,
what's trusted on either side, and which risks are mitigated versus accepted. It reflects the code
as it stands after the ntfy approval-token fix (issue #60); update it when a boundary's mitigation
changes.

| Boundary | Worst case if abused | Status |
|---|---|---|
| 1. Widget → Worker `/feedback` | Issue-creation spam, a bad screenshot blob committed to the repo | Accepted (rate limiting), mitigated (validation) |
| 2. Worker → GitHub (issue/screenshot writes) | Prompt-injection payload lands in a triage-parsed issue body | Mitigated (marker neutralisation), accepted (content itself) |
| 3. GitHub content → Claude → PR/label/comment writes | A malicious PR gets opened with repo-write credentials | Mitigated (path guard, human PR review), accepted (no sandboxing beyond that) |
| 4. Worker ↔ ntfy ↔ phone (approval) | A leaked credential lets a stranger trigger apply-fix | Mitigated (#60: scoped, expiring token) |

## 1. Widget → Worker (`POST /feedback`)

**Crosses:** any anonymous browser on any third-party host page that has the widget embedded posts
free-text description fields, a context object (URL, viewport, UA, timestamps) and an optional
base64 screenshot (up to 4MB) to the Worker's public, unauthenticated endpoint.

**Trusted:** nothing on the caller's side. **Untrusted:** every field; the Worker validates shape
and length (Zod schema, `contextSchema`) but the content itself is opaque text and image bytes.

**Mitigated:** length caps stop a hostile payload blowing past GitHub's issue-body limit; a 4MB
screenshot cap; `<`/`>` stripped from the optional reporter name/login; CORS `ALLOWED_ORIGIN`.

**Accepted:** no rate limiting or CAPTCHA, so anyone who finds the endpoint can create unlimited
GitHub issues, at the cost of repo noise and GitHub API quota, not data exposure. No magic-byte
check on the screenshot before it is committed via the Contents API, so a non-image blob up to 4MB
can land in the `bug-report-screenshots` branch; worst case is a static raw file, not execution.
Both are accepted because bugpilot is a small/solo-scale tool and abuse here is visible (spam
issues), not silent.

## 2. Worker → GitHub (issue creation, screenshot commit, label writes)

**Crosses:** the Worker holds `GITHUB_TOKEN` and turns anonymous, boundary-1 content into a real
GitHub issue plus a `<!-- bugpilot:structured -->` JSON block, which a downstream automation (the
triage action) later parses as data that drives its own next actions.

**Trusted:** the Worker's own code, deployed by Rodney; `GITHUB_TOKEN` never reaches the client.

**Untrusted:** the description, project name, and other free-text fields, now permanently embedded
in the issue body and in the structured block the triage action treats as its input.

**Mitigated:** `neutraliseMarkers` strips the HTML-comment markers from user text so a submitter
cannot counterfeit or duplicate the structured block; the parser takes the *last* match, which is
always the Worker's genuine one appended at the end.

**Accepted:** a reporter can still write natural-language prompt-injection content in
`description` aimed at Claude's classification, severity or proposed fix (e.g. "mark this
critical and propose X"). Accepted because triage output is advisory: it sets labels and drafts
text, a human still taps Approve before apply-fix runs, and the worst case is a misleading label
or a wasted apply-fix run, not an unreviewed code change.

## 3. GitHub issue/comment content → Claude → PR, label and comment writes

**Crosses:** the triage action's prompt includes the full (attacker-influenced) issue body; its
tool-call output (classification, proposed fix) is acted on automatically. The apply-fix action
goes further: Claude drives `read_file`/`write_file`/`list_files` tools directly against the
checked-out repo, then a branch is pushed and a PR opened using `github.token`
(`contents:write`, `pull-requests:write`) and the Anthropic credential (API key or workload
identity federation).

**Trusted:** the two Actions' own guard code. **Untrusted:** the LLM's tool-call arguments; Claude
is a semi-trusted agent holding real repo-write credentials, steered by attacker-influenced text.

**Mitigated:** `safePath` rejects `../` traversal and shell-metacharacter paths; only files Claude
actually wrote via `write_file` (tracked in `legitimateWrites`) are staged, so a prompt-injected
instruction can't `git add` unrelated repo state; the PR targets `main` and is never auto-merged,
so normal branch protection and human review still gate what ships; `MAX_ITERATIONS` bounds a
runaway loop; an OIDC federation rule (when used) is pinned to `ref: refs/heads/main`, closing the
fork-PR token-theft path a looser rule would allow.

**Accepted:** nothing sandboxes the *content* Claude writes beyond `safePath` and PR review; a
sufficiently crafted issue could still steer Claude toward a subtly bad change. Accepted because
the blast radius is the same as a bad human PR: it sits open, unmerged, until reviewed. Also
accepted: apply-fix's `workflow_dispatch` takes a bare `issue_number` and anyone with repo write
access can trigger it manually regardless of the ntfy path; that's GitHub's own permission model,
not something bugpilot code controls.

## 4. Worker ↔ ntfy ↔ human phone (the approval channel)

**Crosses:** the triage action publishes a push notification (title, proposed-fix text, an
"Approve" action with a callback URL and headers) to an ntfy topic; the ntfy app renders it and,
on tap, performs the embedded HTTP POST back to the Worker's `/webhook/apply-fix`.

**Trusted (pre-fix):** nothing. A bare topic slug on the public `ntfy.sh` has no read access
control, so the notification, including the raw `WEBHOOK_SECRET` sent in the Approve action's
headers, was legible to anyone who could read or guess the topic (issue #60).

**Mitigated (this cycle):** `WEBHOOK_SECRET` no longer appears in the notification at all. The
triage action instead signs a 48-hour, issue-and-repo-scoped HMAC-SHA256 token
(`signApprovalToken` in `actions/triage/lib.mjs`) and sends that in the Approve header; the Worker
verifies the signature and expiry (`verifyApprovalToken` in `backend/src/index.ts`) and dispatches
only for the exact issue the token was minted against. A leaked token now buys, at most, one
apply-fix replay on one issue, on one repo, for two days, not a standing credential.

**Accepted:** the triage content itself (issue title, severity, proposed-fix summary) still goes
out unauthenticated if the topic isn't access-controlled. Accepted as a lower-severity information
disclosure (prose, not a credential); the README documents using a hard-to-guess topic slug or a
self-hosted, access-controlled ntfy server for anyone who treats the triage detail as sensitive.
`ntfy-token` authenticates the *publish* call to a self-hosted server but doesn't by itself prove
reads are restricted; that ACL is the server operator's to configure and isn't something bugpilot's
client-side code can verify.
