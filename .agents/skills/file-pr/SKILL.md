---
name: file-pr
description: File a concise pull request. Use when the user asks to file, open or create a PR.
---

# File PR

Before filing, check whether a PR for this branch already exists. Review the diff locally against `origin/main` to make sure its contents match the goal.

## PR Title

PR titles usually become commit messages, so follow the repository's title conventions and look at recent PRs (if any). Prefer a concise, human-readable title that explains why the change matters:

BAD:
> ❌ perf(server): negotiate permessage-deflate on the websocket

GOOD:
> ✅ perf(server): cut websocket frame size by 70% with gzipping

## PR description

Apply `unslop` skill first if available.

Open the description with a simple explanation of the problem based on the user's original prompt. State what the user wants. Then briefly explain the solution. Do not lead with an implementation inventory:

BAD:
> ❌ Removed implicit workspace carry-over from every "new thread" entry point (cmd+n / cmd+shift+o, sidebar v1/v2 buttons, command palette). New threads inherit only the project from context; branch, worktree, and env mode always come from the configured defaults. Deleted buildContextualThreadOptions, startNewThreadInProjectFromContext, and the v1 sidebar's seed-context machinery.

GOOD:
> ✅ My "new worktree" default was ignored when starting new threads on existing worktrees. Super unintuitive. Now your preferences always apply.

## Other Rules

- Open a real PR rather than a draft.
