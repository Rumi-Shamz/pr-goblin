---
name: goblin-github
description: |
  Read and update GitHub issues with the gh CLI: state (kept in labels),
  comments, the workpad, and issue lookup. Use for every ticket operation
  when the ticket lives in GitHub Issues.
---

# GitHub Issues

All operations use the `gh` CLI, which is already authenticated. Run them from
inside the repository directory so `gh` picks the right repo, or pass
`--repo OWNER/REPO`.

The issue number is the trailing number of your task identifier
(`myapp-123` → issue `123`).

## State lives in labels

GitHub issues are only open or closed, so pr-goblin keeps workflow state in labels:

| State | How it looks on the issue |
|-------|---------------------------|
| Ready | open, has `goblin`, no `goblin:in-progress` / `goblin:in-review` |
| In Progress | open, has `goblin:in-progress` |
| In Review | open, has `goblin:in-review` |
| Closed | closed |

Never remove the `goblin` label yourself, and never close the issue: the PR
closes it when a human merges.

## Look up an issue

```sh
gh issue view 123 --json number,title,body,state,labels,comments
```

## Move state

Ready → In Progress:

```sh
gh label create "goblin:in-progress" --color FBCA04 2>/dev/null || true
gh issue edit 123 --add-label "goblin:in-progress" --remove-label "goblin:in-review"
```

In Progress → In Review (only after the PR exists):

```sh
gh label create "goblin:in-review" --color 0E8A16 2>/dev/null || true
gh issue edit 123 --add-label "goblin:in-review" --remove-label "goblin:in-progress"
```

`--remove-label` on a label the issue does not have is harmless.

## Post a comment

Write the body to a file first to avoid shell-escaping problems:

```sh
cat > /tmp/goblin-comment.md << 'EOF_BODY'
<markdown>
EOF_BODY
gh issue comment 123 --body-file /tmp/goblin-comment.md
```

## Workpad (one persistent comment)

Find an existing workpad comment:

```sh
gh api "repos/{owner}/{repo}/issues/123/comments" --paginate \
  --jq '.[] | select(.body | startswith("## Goblin Workpad")) | .id' | tail -1
```

Update it in place (keep the ID for later updates):

```sh
gh api -X PATCH "repos/{owner}/{repo}/issues/comments/COMMENT_ID" -F body=@/tmp/goblin-comment.md
```

If none exists, create it with `gh issue comment` as above.

## Link the PR to the issue

Put `Fixes #123` in the PR body. That links them and closes the issue on merge.

## Create a follow-up issue (out-of-scope work)

```sh
gh issue create --title "<title>" --body "Found while working on #123. <details>"
```

Do not add the `goblin` label to issues you create: a human decides what gets worked.
