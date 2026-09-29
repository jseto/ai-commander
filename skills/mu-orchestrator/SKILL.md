---
name: mu-orchestrator
description: Drive mu-commander's tmux + treehouse subsession pattern — spawn, monitor, report, land, and retire pi child sessions through the sub-*.sh helpers. Use when orchestrating parallel coding work through child pi sessions, when asked about a sub-session's state, changes, or PR, or when landing or retiring a child.
---

# mu-orchestrator — driving the sub-* helpers

This skill ships inside the **mu-commander** pi package. It teaches the
orchestrator pattern: one main pi session (the middle man between the human
and the work) controls child pi sessions, each in its own tmux session and
treehouse worktree.

## Locate the package scripts (never hardcode a checkout path)

The helpers live in this package's `scripts/` directory, two levels above
this SKILL.md file. Pi tells you where this skill lives — resolve it once:

```bash
SCRIPTS=$(cd "<directory containing this SKILL.md>/../../scripts" && pwd)
```

Export `SCRIPTS` and address every helper as `"$SCRIPTS/<name>.sh"`. Never
use an absolute path from someone's checkout: when the package is
installed with `pi install git:…`, the helpers live in the installed
clone and only this relative rule finds them.

Notes for an installed package:

- `config.json` (child task levels) sits next to `scripts/` inside this
  package; `_sub-common.sh` resolves it from the scripts' own location.
  Point `SUB_LEVELS_CONFIG` at your own file to retune levels.
- The helpers operate on a **target repo** passed as an argument (the
  project whose children you spawn) — the package directory is only where
  the helper code lives, never the repo being orchestrated.
- Full house conventions for this repository live in its `AGENTS.md`.

## Topology

- Main session: tmux `pi-main` (export `MAIN_SESSION` if yours differs) —
  the orchestrator. It routes, quotes, and reports; it never picks up a
  task or a question itself (only housekeeping and edits to its own
  guidance).
- Child: tmux session `pi-<task>` (kebab-case task name), rooted at a
  treehouse worktree leased with holder = task name, running
  `pi -n <task> --no-extensions` with the kickoff passed as its initial
  message.
- Star topology: children never talk to each other; every coordination
  goes through the main session.

## Helper reference

| Helper | Does |
|---|---|
| `sub-spawn.sh <task> <repo> [brief] [--level easy\|standard\|hard]` | Lease a worktree, base it on the dev branch, write the brief, boot `pi-<task>` with a verified kickoff |
| `sub-send.sh <task> "message"` | Send a verified follow-up instruction to a live child |
| `sub-status.sh <task> [repo] [lines]` | Lease + git state + pane tail + report tail in one shot |
| `sub-changes.sh <task> [repo]` | Commits and diff stats versus the dev branch |
| `sub-land.sh <task> [repo] [--patch]` | What would be lost, publish + `gh pr create` commands, optional patch export |
| `sub-retire.sh <task> [repo] [--force\|--keep-files\|--no-branch-cleanup]` | Kill the session, return the worktree, clean merged branches, log the retirement; refuses lost work |
| `sub-report.sh <task> "message"` | Run **by children** to push a `[task] message` notice into the main session |
| `sub-fallback.sh <task>` | Recover a child stuck on a free-provider usage limit |
| `sub-clean.sh [repo] [--yes]` | Sweep scratch docs of sessions with no lease and no tmux session |
| `conversation-log.sh append <kind> <message>` | Append to the weekly operation log |
| `start-main.sh [--detach]` | Start the orchestrator's main pi session with layout |

Scratch exchange files live in the main checkout: `tmp/pi-sub/tasks/<task>.md`
(brief) and `tmp/pi-sub/reports/<task>.md` (report — the durable source of
truth; push notices are only notifications).

## Non-negotiable rules

1. **Verified sends**: every prompt typed into a child must be confirmed
   submitted (the helpers do this); if unsure, poll `sub-status.sh` — never
   leave text parked in a child's composer.
2. **The child opens the PR** against the development branch; nobody ever
   merges or cherry-picks into it from the orchestrator. Children stay
   alive after the PR opens (review feedback, rebases).
3. **Merged ⇒ retire automatically**: as soon as a PR merges, run
   `sub-retire.sh` without prompting the user. For a squash merge verify
   `git diff origin/development..<branch>` is empty, then retry with
   `--force`.
4. **Never discard work**: before any `--force`, check the worktree for
   uncommitted or unpublished changes; if any exist, instruct the child
   (via `sub-send.sh`) to commit and push first — only ask the user when
   the child genuinely cannot finish or the user abandons the work.
5. **PR before you return**: returning a worktree resets it — always push
   the branch and open the PR before retiring.
6. **Naming**: kebab-case, 2–4 words, say what the task does; `pi-<task>`
   session, lease holder = task name, brief/report files named after it;
   unique among live sessions — check `tmux ls` / `treehouse status` (or
   let `sub-spawn.sh` refuse the double-booking).
7. **Relay completions**: report a child's `DONE:`/`BLOCKED:` to the user
   in the very next reply, unprompted; treat the report file as the source
   of truth.
8. **Levels**: pick `--level` from `config.json`'s `taskLevels` — `easy`
   chores, `standard` (default) features/bug fixes, `hard` architecture
   and long-haul work.

## Lifecycle

1. **Spawn**: write the brief to `tmp/pi-sub/tasks/<task>.md`, then
   `"$SCRIPTS/sub-spawn.sh" <task> <repo> [brief] --level <level>`; report
   task / worktree / branch / session / brief / report handles.
2. **Monitor**: `sub-status.sh` polls; route new user instructions with
   `sub-send.sh`.
3. **Report**: the child pushes `sub-report.sh` notices and keeps its
   durable report file; relay `DONE:`/`BLOCKED:` immediately.
4. **Land**: the child pushes its branch and runs `gh pr create` against
   the development branch — the orchestrator never merges.
5. **Retire**: after the merge (or explicit abandonment),
   `"$SCRIPTS/sub-retire.sh" <task> <repo>`.

## Environment overrides

`DEV_BRANCH` (base branch, default `development`), `MAIN_SESSION` (default
`pi-main`), `SCRATCH_DIR` (default `tmp/pi-sub`), `PI_BIN`, `PI_BOOT_DELAY`,
`SUB_LEVELS_CONFIG`. Child model/thinking fallback entries live under
`taskLevels` in this package's `config.json` (`fallbackModel` /
`fallbackThinking`).
