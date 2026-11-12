---
name: goblin-pull
description: |
  Sync the current branch with the base branch via merge.
  Use when your branch is behind the base branch or push was rejected.
---

# Pull

Merge-based sync. No rebase — keeps history linear and predictable for automation.

## Steps

1. Ensure working tree is clean. If not, commit or stash first.
2. Fetch and merge the base branch. It is named under "Base Branch" in your
   CLAUDE.md / AGENTS.md (`main` if none is named):

```sh
BASE=main   # replace with the base branch from your CLAUDE.md
git fetch origin
git -c merge.conflictstyle=zdiff3 merge "origin/$BASE"
```

3. If conflicts:
   - `git status` to see conflicted files
   - Resolve each file — read both sides, understand intent, pick the correct outcome
   - `git add <resolved-file>` for each
   - `git merge --continue`
4. Re-run project validation (`AGENTS.md` for commands).
5. If validation fails, fix and commit the fix.

## Conflict Resolution

- **Read before editing** — understand what each side intended
- **Prefer minimal edits** — keep behavior consistent with your branch's purpose
- **One file at a time** — resolve, stage, move on
- **No blind `--ours`/`--theirs`** — only when one side clearly supersedes
- **Check for leftover markers** — `git diff --check`
- **Import conflicts** — accept both, then let lint/typecheck remove unused ones

## When to Proceed Without Asking

Almost always. You are autonomous. Make best-effort decisions and document
your rationale in the merge commit or a code comment.

Only escalate when the conflict involves a user-visible contract or data
migration where guessing wrong is irreversible.
