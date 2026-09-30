# mu-commander

mu-commander is an AI orchestrator pattern for parallel coding sessions: a
main **pi** session (the orchestrator) relays between the human and a set of
child pi sessions, each working alone in its own git worktree — coordinated
through **tmux** sessions and the **treehouse** worktree pool. This repository
is the playbook and the tooling for that pattern: the `AGENTS.md` operating
manual, the `mu` launcher, the `scripts/sub-*` helper suite, per-feature
Gherkin specs, and a plain-bash test suite.

## Features / overview

- **Orchestrator pattern** — one durable `pi-main` session drives children
  named `pi-<task>`; children never talk to each other (star topology), the
  main session only routes, quotes, and runs the mechanics. Children push a
  branch and open a PR against `development`; nobody ever merges locally.
- **`sub-*` helper scripts** (`scripts/`) — spawn, monitor, message, land,
  and retire children with verified tmux delivery (a prompt that fails to
  submit is treated as fatal, never as "sent"), refusal of double-booked
  tasks, and lost-work protection on retirement.
- **treehouse worktree pool** — pre-warmed linked git worktrees are leased
  per task (`treehouse get --lease`), based on `development`, and handed back
  with `treehouse return --force` after landing.
- **Task levels** — `config.json` maps difficulty (`easy` / `standard` /
  `hard`) to a child's model and thinking level; retuning is a JSON edit,
  not a code change.
- **Free-provider fallback** — when a child stalls on a provider usage limit
  (`FreeUsageLimitError` / HTTP 429), `scripts/sub-fallback.sh` detects the
  error in the pane and switches the running child to the configured
  fallback model.
- **Conversation log** — `scripts/conversation-log.sh` appends operations to
  a weekly, gitignored log with a 6-month retention sweep.

## Installation

### 1. Clone

```bash
git clone https://github.com/jseto/mu-commander.git
cd mu-commander
```

### 2. Dependencies

Required:

| Tool | Used for |
|---|---|
| `bash` | every script and test |
| `git` | worktrees, branches, status |
| `tmux` | the orchestrator/child sessions and all verified sends |
| `treehouse` | the worktree pool (`get --lease`, `return`, `status`) |
| `pi` | the AI coding assistant both orchestrator and children run |
| `jq` | config/lease parsing (`config.json`, `treehouse status --json`) |
| `realpath` (coreutils) | brief-file resolution in `sub-spawn.sh` |
| `gh` | creating/inspecting PRs (`sub-land.sh` prints, `sub-retire.sh` checks) |

Most scripts verify their tools up front (`need git tmux treehouse jq
realpath`) and die with a clear `ERROR: missing command: …`. Two are softer:
`start-main.sh` refuses to start without `pi` (`mu` exits 127 with its own
error), and `gh` is only consulted for PR state — without it
`sub-retire.sh` reports the PR as `unknown` rather than failing.

Also expected on a normal Unix system: `sed`, `grep`, `awk`, `date`,
`readlink`, `sha256sum`, `tar`, `mktemp`.

Provided automatically, not installed by hand:

- **shellcheck** — a declared dependency of this repository; the
  `worktree-setup.sh` hook downloads the pinned release (v0.10.0,
  checksum-verified) and links it into `~/.local/bin` the first time a
  worktree is provisioned.
- **`curl` or `wget`** — only for that one-time shellcheck download.

Language toolchains (Node package managers, `flutter`/`dart`, `cargo`,
`go`) are *target-repo* concerns: `scripts/worktree-setup.sh` uses them when
the leased worktree contains the matching manifests. This repository itself
needs none of them.

### 3. Put the `mu` launcher on PATH

`mu` is the root-level launcher that creates (or reuses) the durable
`pi-main` tmux session at the repository root and runs pi inside it — it
resolves its own symlink, so the session is always rooted at the checkout:

```bash
mkdir -p ~/.local/bin
ln -sf "$(pwd)/mu" ~/.local/bin/mu   # ensure ~/.local/bin is on PATH
```

If `pi` is not on PATH, point `PI_BIN` at it. Outside tmux `mu` attaches to
the session; inside tmux it switches the client instead of nesting.

### 4. One-time setup

```bash
# a) Create the treehouse pool config (pool lives under $HOME by default;
#    treehouse.toml is created, no repo scripts are run by it):
treehouse init

# b) Register the worktree-setup hook USER-LEVEL only — hooks in a
#    repo-level treehouse.toml are deliberately ignored:
#    add to ~/.config/treehouse/config.toml
#    [hooks]
#    post_create = "/absolute/path/to/mu-commander/scripts/worktree-setup.sh"

# c) Optional: seed gitignored files into every worktree with a committed
#    .worktreeinclude manifest (e.g. .env*, local config). None is required
#    for this repository.

# d) Review config.json — the child task-level mapping (see Configuration).
```

Scratch exchange files (`tmp/pi-sub/tasks/…`, `tmp/pi-sub/reports/…`) are
created on demand and are gitignored; nothing to set up there.

### 5. Verify

```bash
./mu --help               # pi's usage inside the pi-main session;
                          # exits 127 with a clear error if pi is missing

bash tests/test-mu.sh      # hermetic launcher tests
for t in tests/*.sh; do bash "$t" || exit 1; done   # full suite, exit 0 = green
```

You can also sanity-check the toolchain directly:

```bash
command -v git tmux treehouse pi jq gh
treehouse status          # pool reachable from inside the repo
```

## Usage

Set `SCRIPTS` once (or call the scripts by path):

```bash
SCRIPTS=/absolute/path/to/mu-commander/scripts
```

```bash
# Start the orchestrator (pi-main session, layout + verified pi startup):
"$SCRIPTS/start-main.sh"     # or: "$SCRIPTS/start-main.sh" --detach
mu                           # equivalent thin launcher, attaches/switches

# Spawn a child (leases a worktree, cuts task/<name> from development,
# writes the brief, boots pi in tmux session pi-<task>, prints the handles):
"$SCRIPTS/sub-spawn.sh" fix-auth /path/to/repo path/to/brief.md --level standard

# Monitor / inspect:
"$SCRIPTS/sub-status.sh"   fix-auth /path/to/repo        # lease + pane + report
"$SCRIPTS/sub-changes.sh"  fix-auth /path/to/repo        # commits + diff stats

# Talk to a child, and children reporting back:
"$SCRIPTS/sub-send.sh"     fix-auth "continue with the tests"
"$SCRIPTS/sub-report.sh"   fix-auth "DONE: all green (PR #12)"   # run by the child

# Recover a child stuck on the free provider's usage limit:
"$SCRIPTS/sub-fallback.sh" fix-auth

# Publish (read-only: prints the push + PR commands, never merges):
"$SCRIPTS/sub-land.sh"     fix-auth /path/to/repo --patch

# Retire once the PR is merged (refuses when work would be lost;
# --force only after the PR is merged or the work is abandoned):
"$SCRIPTS/sub-retire.sh"   fix-auth /path/to/repo

# Housekeeping:
"$SCRIPTS/sub-clean.sh"    /path/to/repo        # dry-run scratch sweep
"$SCRIPTS/conversation-log.sh" append operation "retired fix-auth"
```

The full orchestration contract (routing rules, PR-before-return, merge ⇒
retire, spawn/land/retire lifecycle) lives in [AGENTS.md](AGENTS.md).

## Configuration

**`config.json`** (repository root) — child difficulty levels under the
`taskLevels` section; sibling top-level keys are ignored by level
resolution. The file is the single source of truth for the mapped values —
edit it to retune; the shape is:

```json
{
  "taskLevels": {
    "default": "standard",
    "fallbackModel": "<model id>",
    "fallbackThinking": "<thinking level>",
    "levels": {
      "easy":     { "model": "<model id>", "thinking": "<thinking level>" },
      "standard": { "model": "<model id>", "thinking": "<thinking level>" },
      "hard":     { "model": "<model id>", "thinking": "<thinking level>" }
    }
  }
}
```

Precedence when spawning: `--model/--thinking` flags > `SUB_MODEL` /
`SUB_THINKING` env > the selected level's mapping; the level itself is
`--level` > `SUB_LEVEL` > `taskLevels.default`. A missing or malformed
config warns and degrades to no flags (the child then inherits pi's global
defaults) — no config problem can break a spawn.

**Environment overrides** (defaults from `scripts/_sub-common.sh`):

| Variable | Default | Purpose |
|---|---|---|
| `DEV_BRANCH` | `development` | base branch for child worktrees/PRs |
| `MAIN_SESSION` | `pi-main` | orchestrator tmux session notices target |
| `MAIN_PANE` | auto (invoking pane) | stable viewer/notice anchor pane |
| `PI_BIN` | `pi` | pi executable used by `mu` and the scripts |
| `PI_BOOT_DELAY` | `3` | seconds to wait for the pi TUI to boot |
| `SCRATCH_DIR` | `tmp/pi-sub` | gitignored brief/report exchange dir |
| `SUB_LEVEL` / `SUB_MODEL` / `SUB_THINKING` | — | spawn overrides (flags win) |
| `SUB_LEVELS_CONFIG` | `config.json` | relocate the levels config file |
| `SUB_FALLBACK_MODEL` / `SUB_FALLBACK_THINKING` | config `taskLevels` | fallback overrides for `sub-fallback.sh` |
| `SUB_SPAWN_NO_VIEWER` | `0` | set `1` to skip the live viewer pane |

## Development / tests

Repository layout:

| Path | Contents |
|---|---|
| `AGENTS.md` | the operating manual for the pattern |
| `mu` | root launcher for the `pi-main` session |
| `scripts/` | `sub-*` helpers, `start-main.sh`, `worktree-setup.sh`, `conversation-log.sh`, shared `_sub-common.sh` |
| `specs/` | per-feature Gherkin (`*.feature`) + design doc (`*-design.md`) |
| `tests/` | plain bash test scripts, one assertion block per scenario |

Workflow follows the atomic-specs flow: write/extend the Gherkin scenarios
and design doc under `specs/<feature>/`, implement with traceable tests,
then run the independent code audit.

Tests are plain bash — `tests/*.test.sh` plus `test-mu.sh` /
`test-start-main.sh` — no framework, no runner config. Each file exits 0
when green:

```bash
bash tests/task-levels.test.sh        # one feature

for t in tests/*.sh; do bash "$t" || exit 1; done   # everything
```

Assertions are tagged `[REQ-n]` to match the scenarios in the corresponding
`specs/` feature file. Several suites lint the scripts they touch with
`shellcheck` (pinned v0.10.0, provisioned by `scripts/worktree-setup.sh`)
and `bash -n`; they skip linting when shellcheck is not on `PATH`.
