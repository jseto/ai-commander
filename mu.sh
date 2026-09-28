#!/usr/bin/env bash
# Launch pi in the durable "pi-main" tmux session (see AGENTS.md, "pi
# sessions"). Successor of pi.sh: where pi.sh refused the reserved pi-main /
# pi-* names, this launcher deliberately targets pi-main as a thin,
# standalone, root-level launcher. It coexists with scripts/start-main.sh —
# that one boots the orchestrator's session with layout and a verified pi
# startup; mu.sh only creates the session (when missing) and runs pi in it
# directly, attaching to an existing session instead of starting a second pi.
# The file is invoked as `mu` through a PATH symlink (e.g. ~/.local/bin/mu).
set -euo pipefail

# Resolve our own real path first (following symlinks), so that an invocation
# via the PATH symlink roots the session at the repository directory holding
# the real mu.sh — not at the symlink's directory. A direct ./mu.sh run takes
# the no-symlink fast path and behaves exactly as before.
SOURCE=${BASH_SOURCE[0]}
while [[ -h $SOURCE ]]; do
  DIR=$(cd -- "$(dirname -- "$SOURCE")" && pwd)
  SOURCE=$(readlink -- "$SOURCE")
  if [[ $SOURCE != /* ]]; then
    SOURCE=$DIR/$SOURCE
  fi
done
ROOT_DIR=$(cd -- "$(dirname -- "$SOURCE")" && pwd)
SESSION_NAME=pi-main

# PI_BIN wins over the PATH lookup so installations (and tests) can pin the
# binary; `command -v` accepts both a bare name and a path, and resolves to
# nothing when the target is missing or not executable.
if [[ -n "${PI_BIN:-}" ]]; then
  PI_COMMAND=$(command -v "$PI_BIN" || true)
else
  PI_COMMAND=$(command -v pi || true)
fi
if [[ -z "$PI_COMMAND" ]]; then
  printf 'mu: pi executable not found (set PI_BIN to its path)\n' >&2
  exit 127
fi

if tmux has-session -t "=$SESSION_NAME" 2>/dev/null; then
  : # The existing session already owns its pi process; do not start a second one.
else
  tmux new-session -d -s "$SESSION_NAME" -c "$ROOT_DIR" -- "$PI_COMMAND" "$@"
fi

# Exact "=pi-main" targets avoid tmux prefix matching. Inside tmux a nested
# attach-session would be refused, so switch the client instead (same trick
# as pi.sh and scripts/start-main.sh).
if [[ -n "${TMUX:-}" ]]; then
  exec tmux switch-client -t "=$SESSION_NAME"
else
  exec tmux attach-session -t "=$SESSION_NAME"
fi
