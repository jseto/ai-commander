#!/usr/bin/env bash
# Recover a child stuck on the free provider's usage limit (FreeUsageLimitError
# / HTTP 429): switch the running child's pi TUI to the fallback model from
# config.json (taskLevels.fallbackModel) through the shared verified send, and
# confirm the switch in the child's status bar.
#
# Never speculative: the child's pane must already show the free-limit error,
# and the child must not already be on the fallback model — the status-bar
# probe matches the model id as a delimited token, so an id that merely
# extends it (the free "…-free" variant of the fallback id) is not "already
# on". No error (or no configured fallback) means no switch is sent.
#
# The model switch is the recovery. A fallbackThinking the model does not
# accept is pi's 'Error: Unknown thinking level' answer: it degrades to a
# config-problem warning (exit 0) instead of failing the recovered child or
# loop-nudging a command the TUI will never take.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=_sub-common.sh
# shellcheck disable=SC1091  # followed with -x; plain runs must stay clean
source "$SCRIPT_DIR/_sub-common.sh"

usage() { die "usage: ${0##*/} <task-name>"; }

need tmux jq
[ "$#" -eq 1 ] || usage
TASK=$1
valid_task "$TASK" || usage
SESS=$(session_of "$TASK")

# Pane window searched for the error, and the status-bar poll after a switch
# (attempts × delay). The overrides exist mainly so tests need not wait.
: "${FALLBACK_SCAN_LINES:=50}"
: "${FALLBACK_PROBE_ATTEMPTS:=10}"
: "${FALLBACK_PROBE_DELAY:=0.5}"
: "${FALLBACK_SEND_ATTEMPTS:=4}"   # extra Enter nudges after the verified send

tmux has-session -t "$SESS" 2>/dev/null \
  || die "child session '$SESS' is not running"

# Detect first: a switch is only ever sent once the pane shows the provider
# failure, so a healthy child is never moved off its model.
if ! pane_has_free_limit_error "$TASK" "$FALLBACK_SCAN_LINES"; then
  info "no FreeUsageLimitError in $SESS — no model switch performed"
  exit 0
fi

MODEL=$(resolve_fallback_model)
if [ -z "$MODEL" ]; then
  die "free usage limit detected in $SESS, but no fallbackModel is configured in $(levels_config) — no model switch performed"
fi

# Re-running after a successful (or externally performed) switch is a no-op.
if pane_shows_model "$TASK" "$MODEL"; then
  info "$SESS is already on fallback model $MODEL — no model switch performed"
  exit 0
fi

THINKING=$(resolve_fallback_thinking)

# Wait for a switch to show up in the status bar, nudging the verified line
# with bare Enters while it has not. tmux_send_line confirms the pane reacted
# to Enter, but pi's argument completion can consume an Enter as "close the
# popup" without submitting the command (observed in a real TUI: the pane
# changes, the line stays in the composer). The status bar is the ground
# truth, so poll it; the nudged line was just verified present, so an extra
# Enter cannot submit anything else.
confirm_model() {
  local attempt i
  for (( attempt = 0; attempt <= FALLBACK_SEND_ATTEMPTS; attempt++ )); do
    if [ "$attempt" -gt 0 ]; then
      tmux send-keys -t "$SESS" Enter
      sleep "$FALLBACK_PROBE_DELAY"
    fi
    for (( i = 0; i < FALLBACK_PROBE_ATTEMPTS; i++ )); do
      pane_shows_model "$TASK" "$MODEL" && return 0
      sleep "$FALLBACK_PROBE_DELAY"
    done
  done
  return 1
}

# Returns 0 once the level shows in the status bar, 2 when pi rejected it
# (Error: Unknown thinking level — a fallbackThinking that does not match the
# model now in effect, i.e. a config.json problem, not a delivery problem:
# stop instead of nudging a command the TUI will never accept), 1 when it
# could not be confirmed at all.
confirm_thinking() {
  local attempt i
  for (( attempt = 0; attempt <= FALLBACK_SEND_ATTEMPTS; attempt++ )); do
    if [ "$attempt" -gt 0 ]; then
      tmux send-keys -t "$SESS" Enter
      sleep "$FALLBACK_PROBE_DELAY"
    fi
    for (( i = 0; i < FALLBACK_PROBE_ATTEMPTS; i++ )); do
      pane_shows_thinking "$TASK" "$THINKING" && return 0
      pane_thinking_level_rejected "$TASK" "$FALLBACK_SCAN_LINES" && return 2
      sleep "$FALLBACK_PROBE_DELAY"
    done
  done
  return 1
}

# Discard whatever is left in the child's composer after a send that could
# not be confirmed, so a parked slash command can never be submitted later by
# an unrelated Enter (pi's editor deleteToLineStart binding is ctrl+u).
clear_composer() { tmux send-keys -t "$SESS" C-u 2>/dev/null || true; }

# An unconfirmed model switch is a loud failure — reporting success for a
# child still on the limited model would be a lie.
if tmux_send_line "$SESS" "/model $MODEL" && confirm_model; then
  info "switched $SESS to fallback model $MODEL"
else
  clear_composer
  die "sent /model $MODEL to $SESS, but its status bar still does not show it — check the pane"
fi

# Thinking comes after the model switch: pi clamps the session's current level
# to the new model's range on /model, so if the clamp already lands on the
# configured level there is nothing to send. Otherwise apply it, still
# confirming against the status bar. This is a refinement, not the recovery —
# a thinking problem never fails a recovered child: a level pi rejects
# (confirm_thinking returns 2) is reported as the config problem it is, and
# any other unconfirmed send warns after clearing the composer.
if [ -n "$THINKING" ]; then
  if pane_shows_thinking "$TASK" "$THINKING"; then
    info "thinking level already $THINKING — nothing to change"
  else
    t_rc=0
    if tmux_send_line "$SESS" "/thinking $THINKING"; then
      confirm_thinking || t_rc=$?
    else
      t_rc=1
    fi
    case $t_rc in
      0) info "thinking level set to $THINKING" ;;
      2)
        clear_composer
        warn "$SESS rejected thinking level '$THINKING' (pi: $_FALLBACK_THINKING_ERROR_RE) — fallbackThinking in $(levels_config) does not match fallbackModel $MODEL; the model switch alone recovered the child"
        ;;
      *)
        clear_composer
        warn "could not confirm /thinking $THINKING in $SESS — check the pane"
        ;;
    esac
  fi
fi
