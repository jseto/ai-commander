---
description: Retire a mu-commander child session after its PR merged
argument-hint: "<task> <repo>"
---
Read the `mu-orchestrator` skill first — it owns the package-relative
`SCRIPTS` resolution; drive the helpers from there, never from a hardcoded
checkout path.

Retire: $ARGUMENTS

Preconditions — never skip them:

- The child's PR is merged into the development branch (or the user
  explicitly abandoned the work). A squash merge still reports "not
  merged": verify the content with an empty
  `git diff origin/development..<branch>`, then retry with `--force`.
- The worktree holds no uncommitted or unpublished work. If it does, send
  the child a commit-and-push instruction through `sub-send.sh` and
  re-check; only ask the user before discarding with `--force`.

Then run `"$SCRIPTS/sub-retire.sh" <task> <repo>` (add `--force` only
after the checks above) and report the retirement — session cost and the
conversation-log entry — back to the user.
