# mu-commander

mu-commander is the AI orchestrator pattern for parallel coding sessions:
one main **pi** session (the orchestrator) drives child pi sessions in
**tmux** sessions and the **treehouse** worktree pool.

## What is it

This repository is the playbook and the tooling for that pattern: the
`AGENTS.md` operating manual for the orchestrator session, the `mu`
launcher, the `scripts/sub-*` helper suite (spawn, monitor, message, land,
retire), the treehouse worktree pool integration, per-feature Gherkin specs
under `specs/`, and plain-bash tests tagged `[REQ-n]`.

## Install

### 1. Clone

```bash
git clone https://github.com/jseto/mu-commander.git
cd mu-commander
```

### 2. Dependencies

Recommended — installs just the missing tools (idempotent, never
overwrites an existing tool; exits 0 only when every dependency resolves on
PATH):

```bash
./install.sh
```

Manual reference for what `./install.sh` covers:

| Tool | Used for |
|---|---|
| `bash` | every script and test |
| `git` | worktrees, branches, status |
| `tmux` | orchestrator/child sessions and all verified sends |
| `treehouse` | the worktree pool (`get --lease`, `return`, `status`) |
| `pi` | the AI coding assistant both orchestrator and children run |
| `jq` | config/lease parsing (`config.json`, `treehouse status --json`) |
| `realpath` (coreutils) | brief-file resolution in `sub-spawn.sh` |
| `gh` | creating/inspecting PRs (`sub-land.sh` prints, `sub-retire.sh` checks) |

Also expected on a normal Unix system: `sed`, `grep`, `awk`, `date`,
`readlink`, `sha256sum`, `tar`, `mktemp`. shellcheck is auto-provisioned —
see [Dependencies](#dependencies) below.

### 3. Put the `mu` launcher on PATH

`mu` creates (or reuses) the durable `pi-main` tmux session at the repository
root and runs pi inside it; it resolves its own symlink, so the session is
always rooted at the checkout:

```bash
mkdir -p ~/.local/bin
ln -sf "$(pwd)/mu" ~/.local/bin/mu   # ensure ~/.local/bin is on PATH
```

If `pi` is not on PATH, point `PI_BIN` at it.

### 4. One-time setup

```bash
# a) Create the treehouse pool config (pool under $HOME, no repo scripts run):
treehouse init

# b) Register the worktree-setup hook USER-LEVEL only (repo-level hooks are
#    deliberately ignored) — add to ~/.config/treehouse/config.toml:
#    [hooks]
#    post_create = "/absolute/path/to/mu-commander/scripts/worktree-setup.sh"

# c) Optional: seed gitignored files into each worktree via a committed
#    .worktreeinclude manifest (none required for this repo).

# d) Review config.json — see "Mu usage for self-configuration" below.
```

### 5. Verify

```bash
./mu --help               # pi's usage; exits 127 if pi is missing
bash tests/readme.test.sh # one test file
for t in tests/*.test.sh; do bash "$t"; done   # full suite, exit 0 = green
```

## How to use

Set `SCRIPTS` once (or call the scripts by path):

```bash
SCRIPTS=/absolute/path/to/mu-commander/scripts

# Start the orchestrator (pi-main session, layout + verified pi startup;
# --detach leaves it running in the background):
"$SCRIPTS/start-main.sh"
mu # equivalent thin launcher, attaches/switches

# Spawn a child: lease a worktree, cut task/<name> from development, write
# the brief, boot pi in tmux session pi-<task>:
"$SCRIPTS/sub-spawn.sh" fix-auth /path/to/repo path/to/brief.md --level standard

# Monitor:
"$SCRIPTS/sub-status.sh"  fix-auth /path/to/repo   # lease + pane + report
"$SCRIPTS/sub-changes.sh" fix-auth /path/to/repo   # commits + diff stats

# Talk to a child / children reporting back:
"$SCRIPTS/sub-send.sh"   fix-auth "continue with the tests"
"$SCRIPTS/sub-report.sh" fix-auth "DONE: all green (PR #12)"  # run by the child

# Publish (read-only: prints the push + PR commands, never merges):
"$SCRIPTS/sub-land.sh"   fix-auth /path/to/repo --patch

# Retire once the PR is merged (refuses when work would be lost):
"$SCRIPTS/sub-retire.sh" fix-auth /path/to/repo   # --force only after merge
```

The full orchestration contract (routing rules, PR-before-return,
merge ⇒ retire) lives in [AGENTS.md](AGENTS.md).

## Mu usage for self-configuration

`mu` boots the main session, which configures itself from the repository's
own conventions — edit those, not the code:

**`AGENTS.md`** — the operating manual; edit it to change the main
session's behaviour (routing rules, lifecycle, conventions).

**`config.json` → `taskLevels`** — difficulty levels mapped to a child's
model and thinking level; the single source of truth, edit it to retune:

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

Spawn precedence: `--model`/`--thinking` flags > `SUB_MODEL`/`SUB_THINKING`
env > the level's mapping; the level is `--level` > `SUB_LEVEL` >
`taskLevels.default`. A missing or malformed config warns and degrades to
pi's global defaults — no config problem can break a spawn. When a child
stalls on the free provider's usage limit, `scripts/sub-fallback.sh`
switches it to the configured `fallbackModel`.

**Environment overrides** for the scripts (defaults in
`scripts/_sub-common.sh`):

| Variable | Default | Purpose |
|---|---|---|
| `DEV_BRANCH` | `development` | base branch for child worktrees/PRs |
| `MAIN_SESSION` | `pi-main` | orchestrator session notices target |
| `SCRATCH_DIR` | `tmp/pi-sub` | gitignored brief/report exchange dir |
| `SUB_LEVEL` / `SUB_MODEL` / `SUB_THINKING` | — | spawn overrides (flags win) |
| `SUB_FALLBACK_MODEL` / `SUB_FALLBACK_THINKING` | config `taskLevels` | fallback overrides for `sub-fallback.sh` |

## Dependencies

Required: `bash`, `git`, `tmux`, `treehouse`, `pi`, `jq`, `realpath`
(coreutils), `gh` — the table under [Install](#install) says what each is
for, and `./install.sh` installs whatever is missing.

Most scripts verify their tools up front (`need git tmux treehouse jq
realpath`) and die with a clear `ERROR: missing command: …`. Two are
softer: `start-main.sh` refuses to start without `pi` (`mu` exits 127), and
without `gh`, `sub-retire.sh` reports the PR as `unknown` rather than
failing.

Provided automatically, not installed by hand — **shellcheck**, a declared
dependency of this repository: `scripts/worktree-setup.sh` downloads the
pinned, checksum-verified release into `~/.local/bin` the first time a
worktree is provisioned (`curl` or `wget` is used for that one-time
download). Language toolchains (Node, `flutter`/`dart`, `cargo`, `go`) are
*target-repo* concerns of `worktree-setup.sh`, not of this repository.
