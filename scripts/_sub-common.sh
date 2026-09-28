#!/usr/bin/env bash
# Shared helpers for the subsession scripts (see AGENTS.md, "pi sessions").
# Source this file; don't execute it.
# shellcheck shell=bash

: "${DEV_BRANCH:=development}"   # base branch for worktrees
# Keep this distinction so callers can fall back to the invoking tmux session
# only when MAIN_SESSION was not explicitly configured.
_SUB_MAIN_SESSION_WAS_SET=${MAIN_SESSION+x}
: "${MAIN_SESSION:=pi-main}"     # orchestrator tmux session
: "${MAIN_PANE:=}"               # stable orchestrator pane ID, when known
: "${PI_BIN:=pi}"                # pi executable
: "${PI_BOOT_DELAY:=3}"          # seconds to wait for the pi TUI to boot
: "${SCRATCH_DIR:=tmp/pi-sub}"      # gitignored scratch dir in the main checkout

# This script's own directory: anchors repo-local defaults (the child
# difficulty levels live in config.json at the repo root, next to this
# scripts/ dir).
# Pure parameter expansion — no external dirname at source time: this file
# must stay sourceable with a restricted PATH (tests/sub-common.test.sh) and
# under set -e.
_SUB_COMMON_DIR=${BASH_SOURCE[0]%/*}
if [ -z "$_SUB_COMMON_DIR" ] || [ "$_SUB_COMMON_DIR" = "${BASH_SOURCE[0]}" ]; then
  _SUB_COMMON_DIR=.
fi

die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
info() { printf '%s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }

need() {
  local c
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || die "missing command: $c"
  done
}

valid_task() { [[ "$1" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; }

# Echo the git toplevel of a directory (default: cwd), or die.
repo_root() {
  local r="${1:-$PWD}"
  [ -e "$r" ] || die "no such path: $r"
  git -C "$r" rev-parse --show-toplevel 2>/dev/null || die "not a git repository: $r"
}

# tmux session name for a task
session_of() { printf 'pi-%s' "$1"; }

# Echo the tmux session containing the invoking pane, when this script was
# launched from tmux. An empty result means there is no usable invoking pane.
invoking_tmux_session() {
  [ -n "${TMUX:-}" ] || return 0
  if [ -n "${TMUX_PANE:-}" ]; then
    tmux display-message -p -t "$TMUX_PANE" '#S' 2>/dev/null || true
  else
    tmux display-message -p '#S' 2>/dev/null || true
  fi
}

# Echo the stable pane ID containing the invoking shell, when launched from
# tmux. Pane IDs remain tied to the original pane even if another window is
# selected later (for example, by open_viewer_window).
invoking_tmux_pane() {
  [ -n "${TMUX:-}" ] || return 0
  if [ -n "${TMUX_PANE:-}" ]; then
    tmux display-message -p -t "$TMUX_PANE" '#{pane_id}' 2>/dev/null || true
  else
    tmux display-message -p '#{pane_id}' 2>/dev/null || true
  fi
}

# Echo the leased worktree path for a task (lease holder == task name),
# or print nothing when the task holds no lease.
wt_for_task() { # $1=task $2=repo-root
  ( cd "$2" && treehouse status --json 2>/dev/null \
      | jq -r --arg h "$1" '[.[] | select(.lease_holder == $h) | .path][0] // empty' \
    ) || true
}

branch_exists() { git -C "$1" show-ref --verify --quiet "refs/heads/$2"; }

# Pick an unused local task branch. A linked worktree cannot check out a branch
# already checked out by another worktree, so never assume task/<name> is free.
task_branch() { # $1=repo-root $2=task
  local root=$1 task=$2 candidate suffix=2
  candidate="task/$task"
  while branch_exists "$root" "$candidate"; do
    candidate="task/$task-$suffix"
    suffix=$((suffix + 1))
  done
  printf '%s' "$candidate"
}

# Shared file locations for the brief/report exchange with a child. They live
# in a gitignored scratch dir inside the MAIN checkout (outside any worktree,
# so they survive 'treehouse return --force') and are deleted when the task is
# retired (see sub-retire.sh). The default `tmp/pi-sub/` is covered by the
# global excludes file (~/.config/git/ignore); set SCRATCH_DIR to relocate it,
# but keep it gitignored. Do NOT use `.pi/` — that is pi's own config dir.
scratch_root() { printf '%s/%s' "$1" "$SCRATCH_DIR"; }
task_file()    { printf '%s/%s/tasks/%s.md'    "$1" "$SCRATCH_DIR" "$2"; }
report_file()  { printf '%s/%s/reports/%s.md'  "$1" "$SCRATCH_DIR" "$2"; }
patch_file()   { printf '%s/%s/reports/%s.patch' "$1" "$SCRATCH_DIR" "$2"; }

# The child difficulty-levels config (AGENTS.md, "Child model and thinking
# levels"): config.json at the repository root — a generic root-level file
# whose taskLevels section holds the levels; sibling top-level keys are
# future general settings and must stay invisible to level resolution.
# SUB_LEVELS_CONFIG relocates the file.
levels_config() {
  printf '%s' "${SUB_LEVELS_CONFIG:-$_SUB_COMMON_DIR/../config.json}"
}

# Echo the fallback model configured for a stuck child (AGENTS.md, "Child
# model and thinking levels"): the env override SUB_FALLBACK_MODEL, else
# .taskLevels.fallbackModel in the levels config. Empty when no fallback is
# configured — a missing, unreadable, or malformed config means "no
# fallback", never an error, so no caller breaks on a config problem.
resolve_fallback_model() {
  if [ -n "${SUB_FALLBACK_MODEL:-}" ]; then printf '%s' "$SUB_FALLBACK_MODEL"; return 0; fi
  _fallback_config_value fallbackModel
}

# Echo the thinking level to apply with the fallback model (env override
# SUB_FALLBACK_THINKING, else .taskLevels.fallbackThinking); empty means
# "leave pi's level as-is". Same graceful degradation as resolve_fallback_model.
resolve_fallback_thinking() {
  if [ -n "${SUB_FALLBACK_THINKING:-}" ]; then printf '%s' "$SUB_FALLBACK_THINKING"; return 0; fi
  _fallback_config_value fallbackThinking
}

# Echo one string key from the taskLevels section, or nothing.
_fallback_config_value() { # $1=key
  local cfg
  cfg=$(levels_config)
  [ -f "$cfg" ] || return 0
  jq -r --arg k "$1" '.taskLevels[$k] // empty' "$cfg" 2>/dev/null || true
  return 0
}

# Echo the quoted --model/--thinking option words for a child pi launch
# (possibly empty). Precedence: explicit flag > SUB_MODEL/SUB_THINKING env >
# the selected level's mapping in the config's taskLevels section; the level
# itself is: explicit flag > SUB_LEVEL env > .taskLevels.default. All jq
# queries are rooted at .taskLevels, so unknown sibling top-level keys in
# config.json are ignored by construction. Always exits 0 — a
# missing/malformed config or an unknown level warns on stderr and degrades
# to no flags, so the child inherits defaultThinkingLevel/modelThinkingLevels
# from the global settings instead of spawning ever failing.
resolve_child_launch_flags() { # $1=level $2=model $3=thinking
  local level=${1:-} model=${2:-} thinking=${3:-} cfg out=""
  [ -n "$model" ] || model=${SUB_MODEL:-}
  [ -n "$thinking" ] || thinking=${SUB_THINKING:-}
  [ -n "$level" ] || level=${SUB_LEVEL:-}
  if [ -z "$model" ] || [ -z "$thinking" ]; then
    cfg=$(levels_config)
    if [ ! -f "$cfg" ]; then
      warn "config.json not found: $cfg — child inherits model/thinking from settings"
    elif ! jq -e '(.taskLevels.levels | type) == "object"' "$cfg" >/dev/null 2>&1; then
      warn "config.json invalid: $cfg — child inherits model/thinking from settings"
    else
      [ -n "$level" ] || level=$(jq -r '.taskLevels.default // empty' "$cfg" 2>/dev/null || true)
      if [ -z "$level" ]; then
        warn "config.json has no default level: $cfg — child inherits model/thinking from settings"
      elif jq -e --arg l "$level" '.taskLevels.levels | has($l)' "$cfg" >/dev/null 2>&1; then
        [ -n "$model" ] || model=$(jq -r --arg l "$level" '.taskLevels.levels[$l].model // empty' "$cfg" 2>/dev/null || true)
        [ -n "$thinking" ] || thinking=$(jq -r --arg l "$level" '.taskLevels.levels[$l].thinking // empty' "$cfg" 2>/dev/null || true)
      else
        warn "unknown level '$level' in $cfg — child inherits model/thinking from settings"
      fi
    fi
  fi
  if [ -n "$model" ]; then
    out=$(printf '%q %q' --model "$model")
  fi
  if [ -n "$thinking" ]; then
    out+="${out:+ }$(printf '%q %q' --thinking "$thinking")"
  fi
  printf '%s' "$out"
  return 0
}

# Echo the pi command line that boots a child session. The resolved
# model/thinking option words ($3, from resolve_child_launch_flags) sit among
# the options — before the kickoff message argument — so pi parses them as
# options, not as part of the prompt.
pi_launch_command() { # $1=pi-bin $2=task $3=option words $4=kickoff
  if [ -n "${3:-}" ]; then
    printf '%q -n %q --no-extensions %s --approve %q' "$1" "$2" "$3" "$4"
  else
    printf '%q -n %q --no-extensions --approve %q' "$1" "$2" "$4"
  fi
}

# Prepare an isolated Pi agent directory for a child. It preserves non-extension
# resources such as settings metadata, skills, prompts, and themes, but gives
# the child no extensions or packages at all. The directory lives in the
# gitignored scratch dir of the main checkout (outside the worktree) and is
# removed on retirement.
prepare_child_agent_dir() { # $1=destination dir; echoes dir
  local agent_dir=$1 source name model_cfg
  rm -rf "$agent_dir"
  mkdir -p "$agent_dir/extensions"
  # An empty package list prevents package-provided extensions from loading.
  # Model defaults (defaultProvider/defaultModel/enabledModels) are inherited
  # from the global settings: without them the child has no configured default
  # and pi falls through to its built-in per-provider fallback map, landing on
  # an arbitrary model (e.g. google/gemini-3.1-pro-preview) whenever the
  # target repo has no project-level .pi/settings.json. defaultThinkingLevel /
  # modelThinkingLevels / defaultProjectTrust (specs/child-task-levels) ride
  # along as the baseline when sub-spawn passes no --model/--thinking flags.
  model_cfg=$(jq -c '{defaultProvider, defaultModel, enabledModels,
    defaultThinkingLevel, modelThinkingLevels, defaultProjectTrust}
    | with_entries(select(.value != null))' "$HOME/.pi/agent/settings.json" 2>/dev/null || printf '{}')
  jq -cn --argjson cfg "$model_cfg" '$cfg + {packages: []}' > "$agent_dir/settings.json" 2>/dev/null \
    || printf '{"packages":[]}\n' > "$agent_dir/settings.json" # jq absent → never leave an empty file

  for name in auth.json keybindings.json models.json models-store.json trust.json AGENTS.md AGENTS.override.md SYSTEM.md APPEND_SYSTEM.md; do
    source="$HOME/.pi/agent/$name"
    if [ -e "$source" ] || [ -L "$source" ]; then
      ln -s "$source" "$agent_dir/$name"
    fi
  done
  for name in npm node_modules skills prompts themes; do
    source="$HOME/.pi/agent/$name"
    if [ -e "$source" ] || [ -L "$source" ]; then
      ln -s "$source" "$agent_dir/$name"
    fi
  done

  printf '%s\n' "$agent_dir"
}

# Open a live viewer for a child session. When launched from tmux, prefer a
# pane in the invoking window; otherwise retain the old viewer-window
# fallback, but create it detached so a non-tmux invocation does not change
# the selected window. Best effort — every failure is silent and non-fatal;
# echoes the target session name on success, nothing on skip/failure. Panes
# inherit $TMUX, so the nested attach needs it cleared — and when the child
# session dies, the attach client exits and tmux closes the pane/window.
open_viewer_window() { # $1=task $2=child-session $3=invoking-pane (optional)
  local task=$1 child=$2 invoking_pane=${3:-} anchor target=$MAIN_SESSION wins
  [ "${SUB_SPAWN_NO_VIEWER:-0}" = 1 ] && return 0
  # An explicitly configured MAIN_PANE is the stable viewer anchor. Otherwise,
  # prefer the pane that invoked the spawn, and report that pane's session.
  anchor=${MAIN_PANE:-$invoking_pane}
  if [ -n "$anchor" ] \
     && tmux display-message -p -t "$anchor" '#{pane_id}' >/dev/null 2>&1; then
    target=$(tmux display-message -p -t "$anchor" '#S' 2>/dev/null) || return 0
    tmux split-window -h -t "$anchor" \
      "env -u TMUX tmux attach -t $child" >/dev/null 2>&1 || return 0
    # Keep the cursor focus where it was: the split made the viewer pane
    # active, so hand focus back to the anchor pane before the layout settles.
    tmux select-pane -t "$anchor" >/dev/null 2>&1 || true
    tmux set-window-option -t "$target" main-pane-width 50% >/dev/null 2>&1 || true
    tmux select-layout -t "$target" main-vertical >/dev/null 2>&1 || true
    tmux resize-pane -t "$anchor" -x 50% >/dev/null 2>&1 || true
    printf '%s\n' "$target"
    return 0
  fi
  tmux has-session -t "=$target" 2>/dev/null || return 0
  wins=$(tmux list-windows -t "=$target:" -F '#W' 2>/dev/null) || return 0
  if grep -Fxq -- "$task" <<<"$wins"; then return 0; fi
  tmux new-window -d -t "=$target:" -n "$task" \
    "env -u TMUX tmux attach -t $child" >/dev/null 2>&1 || return 0
  printf '%s\n' "$target"
}

# Flatten a string to its non-whitespace characters. tmux wraps text to the
# pane width, so a verbatim comparison would miss a message that landed.
_flatten() { printf '%s' "$1" | tr -d '[:space:]'; }

# Flattened text currently shown in a pane.
_pane_flattened() { tmux capture-pane -t "$1" -p 2>/dev/null | tr -d '[:space:]' || true; }

# Type a line into a tmux pane and make sure it actually runs.
#
# A bare `send-keys -l` + `Enter` races the target TUI's startup: pi can be
# mid-redraw (slow extension init) when the Enter arrives, and the keystroke is
# dropped, leaving the text parked in the composer. This helper is defensive on
# both halves of the problem — it re-types when the text never appeared, and it
# retries Enter while the pane content stays frozen (an unsubmitted line looks
# exactly like a static screen). Extra Enters on an empty composer are
# harmless; a silently unsent prompt is not.
#
# Returns 0 only when the pane content changed after an Enter — the line was
# confirmed submitted. Returns 1 when it could not be confirmed: the text
# never appeared after re-typing, the pane stayed frozen through every Enter
# retry, or send-keys itself failed (target gone). Callers decide what an
# unconfirmed send means for them; the sub-* scripts treat it as fatal so a
# stranded line can never be reported as delivered.
tmux_send_line() { # $1=tmux target $2=text [attempts] [settle seconds]
  local target=$1 text=$2 attempts=${3:-4} settle=${4:-1}
  local probe before after i
  probe=$(_flatten "$text")
  # The composer always shows the END of the text, so its tail survives the
  # pane wrapping even when the head scrolls out of view.
  probe=${probe: -60}
  for (( i = 0; i < 2; i++ )); do
    tmux send-keys -t "$target" -l "$text"
    sleep 0.4
    _pane_flattened "$target" | grep -qF -- "$probe" && break
    warn "text not visible in $target yet; retyping"
  done
  before=$(_pane_flattened "$target")
  for (( i = 0; i < attempts; i++ )); do
    tmux send-keys -t "$target" Enter
    sleep "$settle"
    after=$(_pane_flattened "$target")
    [ "$after" != "$before" ] && return 0
    before=$after
  done
  warn "could not confirm that $target picked up the line; check the pane"
  return 1
}

# Tail of the task's tmux pane (trailing blank lines dropped), or a note
# when it isn't running.
pane_tail() { # $1=task $2=lines
  local sess
  sess=$(session_of "$1")
  if tmux has-session -t "$sess" 2>/dev/null; then
    tmux capture-pane -t "$sess" -p | awk -v n="$2" '
      { if ($0 ~ /[^[:space:]]/) last=NR; line[NR]=$0 }
      END { start=last-n+1; if (start<1) start=1
            for (i=start; i<=last; i++) print line[i] }'
  else
    info "(tmux session $sess is not running)"
  fi
}

# Signature of pi's free-provider usage-limit failure in a pane: the JSON
# error type, or an HTTP 429 next to rate-limit wording. Deliberately textual
# (there is no other channel into a running TUI), so callers scan a bounded
# pane window instead of the whole scrollback.
_FALLBACK_ERROR_RE='FreeUsageLimitError|(^|[^0-9])429([^0-9]|$).*([Rr]ate[ -]?limit|[Tt]oo [Mm]any [Rr]equests)'

# Echo the last non-empty line currently shown in the task's pane — pi draws
# its status bar (path, token stats, model • thinking) there. Nothing when
# the session is not running.
pane_last_line() { # $1=task
  local sess
  sess=$(session_of "$1")
  tmux has-session -t "$sess" 2>/dev/null || return 0
  tmux capture-pane -t "$sess" -p 2>/dev/null \
    | awk 'NF { last=$0 } END { if (last != "") print last }'
}

# True when the task's pane tail shows the free-limit error.
pane_has_free_limit_error() { # $1=task [$2=scan lines]
  local task=$1 lines=${2:-50}
  pane_tail "$task" "$lines" | grep -qE -- "$_FALLBACK_ERROR_RE"
}

# True when the task's status bar shows the model. pi renders the model id
# (the part after the final "/") there, not the provider-qualified name.
pane_shows_model() { # $1=task $2=model
  local task=$1 model=$2 last id
  id=${model##*/}
  [ -n "$id" ] || return 1
  last=$(pane_last_line "$task")
  [ -n "$last" ] || return 1
  grep -qF -- "$id" <<<"$last"
}

# True when the task's status bar shows the thinking level. pi renders it
# after a bullet ("model • max"); "off" renders as "model • thinking off".
pane_shows_thinking() { # $1=task $2=level
  local last
  last=$(pane_last_line "$1")
  [ -n "$last" ] || return 1
  if [ "$2" = off ]; then
    grep -qF -- '• thinking off' <<<"$last"
  else
    grep -qF -- "• $2" <<<"$last"
  fi
}
