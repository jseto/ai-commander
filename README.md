# mu-commander

Orchestration helpers for running **parallel pi coding sessions**: one
orchestrator session (`pi-main`) drives child sessions (`pi-<task>`) in
treehouse worktrees through the `scripts/sub-*.sh` helpers, following the
conventions in [AGENTS.md](AGENTS.md).

## Install as a pi package

```bash
pi install git:github.com/jseto/mu-commander
```

Verify the installation:

```bash
pi list        # shows the mu-commander package source
```

then in a pi session run `/skill:mu-orchestrator` (or just ask to spawn a
subsession — the skill routes itself).

### What the package provides

- **`mu-orchestrator` skill** — the orchestrator pattern: topology, the
  full `sub-*.sh` helper table, the verified-send rule, and the
  spawn → monitor → report → land → retire lifecycle. The skill resolves
  the helpers relative to its own location inside the installed package,
  so it works from this checkout and from any `pi install` clone alike.
- **`/spawn-sub`** prompt template — spawn a child session for a task
  (brief, worktree lease, verified kickoff, handles back).
- **`/retire-sub`** prompt template — retire a child after its PR merges,
  with the lost-work and squash-merge checks.
- **`scripts/` + `config.json`** — the helpers themselves and the child
  task-level defaults, shipped as package payload in the clone and
  resolved relative to the installed package (never a checkout path).

A local development install works the same way:

```bash
pi install ./mu-commander
```

Refresh installed git sources with `pi update`. The package carries the
`pi-package` npm keyword, making it eligible for the pi package gallery.

Repository development (tests, specs, the `mu` launcher, worktree setup)
is documented in [AGENTS.md](AGENTS.md).
