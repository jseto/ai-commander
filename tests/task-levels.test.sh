#!/usr/bin/env bash
# Behavioural tests for the child task-levels feature (config/task-levels.json,
# resolve_child_launch_flags, pi_launch_command, thinking/trust inheritance,
# sub-spawn flag parsing).
# One test per Scenario in specs/child-task-levels/child-task-levels.feature.
#
# Hermetic by construction: resolver tests clear SUB_LEVEL/SUB_MODEL/
# SUB_THINKING/SUB_LEVELS_CONFIG from the environment and re-add exactly what
# the scenario needs; REQ-1/REQ-2/REQ-3 exercise the repository's real
# config/task-levels.json (the shipped defaults are part of the contract).
# The inheritance test redirects $HOME to a scratch fixture, like
# tests/sub-common.test.sh, so no real ~/.pi state is read or touched.
set -u

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
COMMON=${SUB_COMMON_UNDER_TEST:-$ROOT/scripts/_sub-common.sh}
SPAWN=${SUB_SPAWN_UNDER_TEST:-$ROOT/scripts/sub-spawn.sh}
CONFIG=${TASK_LEVELS_CONFIG_UNDER_TEST:-$ROOT/config/task-levels.json}

failures=0
fail() { printf '  ASSERT FAILED: %s\n' "$*" >&2; exit 1; }

SCRATCH=$(mktemp -d)
trap 'rm -rf "$SCRATCH"' EXIT

jq_ok() { command -v jq >/dev/null 2>&1 || { printf '  SKIP: jq not on PATH\n' >&2; return 0; }; }

# ---------------------------------------------------------------------------
# Harness: resolve <level> <model> <thinking> [ENV=VALUE ...]
# Runs resolve_child_launch_flags with SUB_* cleared, plus the given extras.
# Sets: RC, OUT (stdout), RERR (stderr).
# ---------------------------------------------------------------------------
resolve() {
  local level=$1 model=$2 thinking=$3
  shift 3
  local args
  args=$(printf '%q ' "$level" "$model" "$thinking")
  RC=0
  OUT=$(env -u SUB_LEVEL -u SUB_MODEL -u SUB_THINKING -u SUB_LEVELS_CONFIG \
        "$@" bash -c "source '$COMMON'; resolve_child_launch_flags $args" \
        2>"$SCRATCH/stderr") || RC=$?
  RERR=$(cat "$SCRATCH/stderr")
}

# launch <flags> — pi_launch_command with a fixed bin/task/kickoff. Sets: RC, OUT.
launch() {
  local kickoff="Read the task brief at /tmp/x.md and complete it."
  RC=0
  OUT=$(bash -c "source '$COMMON'; pi_launch_command pi demo $(printf '%q' "$1") $(printf '%q' "$kickoff")") \
    || RC=$?
  LAUNCH_KICKOFF=$kickoff
}

# spawn_bad <arg...> — run sub-spawn with the args, no work must happen.
# Sets: RC, RERR (stderr).
spawn_bad() {
  RC=0
  env -u SUB_LEVEL -u SUB_MODEL -u SUB_THINKING \
    bash "$SPAWN" "$@" >/dev/null 2>"$SCRATCH/stderr" || RC=$?
  RERR=$(cat "$SCRATCH/stderr")
}

# ---------------------------------------------------------------------------
# Scenarios
# ---------------------------------------------------------------------------

t_req1_default_level_uses_shipped_defaults() {
  jq_ok || return 0
  resolve "" "" ""
  [ "$RC" -eq 0 ] || fail "expected exit 0, got $RC ($RERR)"
  [ -z "$RERR" ] || fail "expected no warning, got: $RERR"
  [ "$OUT" = "--model opencode-zen-free/mimo-v2.6-flash-free --thinking xhigh" ] \
    || fail "default level should resolve to mimo @ xhigh, got: $OUT"
}

t_req2_named_levels_select_their_mapping() {
  jq_ok || return 0
  resolve easy "" ""
  [ "$OUT" = "--model opencode-zen-free/mimo-v2.6-flash-free --thinking medium" ] \
    || fail "easy should resolve to mimo @ medium, got: $OUT"
  resolve hard "" ""
  [ "$OUT" = "--model opencode-go/deepseek-v4.1-flash --thinking xhigh" ] \
    || fail "hard should resolve to deepseek @ xhigh, got: $OUT"
}

t_req3_explicit_flags_beat_the_level_mapping() {
  jq_ok || return 0
  resolve "" "" low
  [ "$OUT" = "--model opencode-zen-free/mimo-v2.6-flash-free --thinking low" ] \
    || fail "thinking flag should keep the level's model, got: $OUT"
  resolve "" custom/m ""
  [ "$OUT" = "--model custom/m --thinking xhigh" ] \
    || fail "model flag should keep the level's thinking, got: $OUT"
}

t_req4_env_overrides_and_flag_precedence() {
  jq_ok || return 0
  resolve "" "" "" SUB_LEVEL=easy
  [ "$OUT" = "--model opencode-zen-free/mimo-v2.6-flash-free --thinking medium" ] \
    || fail "SUB_LEVEL=easy should win over the default level, got: $OUT"
  resolve "" "" "" SUB_LEVEL=easy SUB_MODEL=env/m
  [ "$OUT" = "--model env/m --thinking medium" ] \
    || fail "SUB_MODEL should win over the level mapping, got: $OUT"
  resolve "" flag/m "" SUB_LEVEL=easy SUB_MODEL=env/m
  [ "$OUT" = "--model flag/m --thinking medium" ] \
    || fail "--model flag should win over SUB_MODEL, got: $OUT"
}

t_req5_missing_config_degrades_to_no_flags() {
  resolve "" "" "" SUB_LEVELS_CONFIG="$SCRATCH/does-not-exist.json"
  [ "$RC" -eq 0 ] || fail "expected exit 0, got $RC"
  [ -z "$OUT" ] || fail "expected no flags, got: $OUT"
  case $RERR in
    *"levels config not found"*) ;;
    *) fail "expected a 'levels config not found' warning, got: $RERR" ;;
  esac
}

t_req6_unknown_level_degrades_to_no_flags() {
  jq_ok || return 0
  resolve bogus "" ""
  [ "$RC" -eq 0 ] || fail "expected exit 0, got $RC"
  [ -z "$OUT" ] || fail "expected no flags, got: $OUT"
  case $RERR in
    *"unknown level"*) ;;
    *) fail "expected an 'unknown level' warning, got: $RERR" ;;
  esac
}

t_req7_malformed_config_degrades_to_no_flags() {
  printf '{not valid json' > "$SCRATCH/broken.json"
  resolve "" "" "" SUB_LEVELS_CONFIG="$SCRATCH/broken.json"
  [ "$RC" -eq 0 ] || fail "expected exit 0, got $RC"
  [ -z "$OUT" ] || fail "expected no flags, got: $OUT"
  case $RERR in
    *"levels config invalid"*) ;;
    *) fail "expected a 'levels config invalid' warning, got: $RERR" ;;
  esac
}

t_req8_child_settings_inherit_thinking_and_trust_baseline() {
  jq_ok || return 0
  local sb home
  sb=$(mktemp -d "$SCRATCH/case.XXXXXX")
  home=$sb/home
  mkdir -p "$home/.pi/agent"
  cat > "$home/.pi/agent/settings.json" <<'JSON'
{"defaultProvider":"opencode-zen-free","defaultModel":"opencode-zen-free/mimo-v2.6-flash-free","enabledModels":["opencode-zen-free/mimo-v2.6-flash-free"],"defaultThinkingLevel":"high","modelThinkingLevels":{"opencode-zen-free/mimo-v2.6-flash-free":"xhigh"},"defaultProjectTrust":"always"}
JSON
  env HOME="$home" bash -c \
    "source '$COMMON'; prepare_child_agent_dir '$sb/agent-dir'" >/dev/null \
    || fail "prepare_child_agent_dir failed"
  jq -e '.defaultThinkingLevel == "high"
         and .modelThinkingLevels["opencode-zen-free/mimo-v2.6-flash-free"] == "xhigh"
         and .defaultProjectTrust == "always"
         and .defaultModel == "opencode-zen-free/mimo-v2.6-flash-free"
         and (.packages == [])' "$sb/agent-dir/settings.json" >/dev/null \
    || fail "thinking/trust baseline not inherited: $(cat "$sb/agent-dir/settings.json")"
}

t_req9_launch_line_carries_options_ahead_of_kickoff() {
  launch "--model a/b --thinking xhigh"
  [ "$RC" -eq 0 ] || fail "pi_launch_command failed (rc=$RC)"
  local want
  want="pi -n demo --no-extensions --model a/b --thinking xhigh --approve $(printf '%q' "$LAUNCH_KICKOFF")"
  [ "$OUT" = "$want" ] || fail "expected: $want
     got: $OUT"
  launch ""
  want="pi -n demo --no-extensions --approve $(printf '%q' "$LAUNCH_KICKOFF")"
  [ "$OUT" = "$want" ] || fail "expected: $want
     got: $OUT"
}

t_req10_bad_spawn_invocations_die_early() {
  spawn_bad
  [ "$RC" -ne 0 ] || fail "no-arg invocation should fail"
  case $RERR in *"usage:"*) ;; *) fail "expected usage line, got: $RERR" ;; esac
  spawn_bad demo /nonexistent --bogus
  [ "$RC" -ne 0 ] || fail "unknown option should fail"
  case $RERR in *"unknown option"*) ;; *) fail "expected unknown-option error, got: $RERR" ;; esac
  spawn_bad demo /nonexistent --level
  [ "$RC" -ne 0 ] || fail "--level without a value should fail"
  case $RERR in *"--level"*) ;; *) fail "expected --level value error, got: $RERR" ;; esac
}

t_req11_shellcheck_and_bash_n_clean() {
  bash -n "$COMMON" || fail "bash -n reported syntax errors in $COMMON"
  bash -n "$SPAWN" || fail "bash -n reported syntax errors in $SPAWN"
  if ! command -v shellcheck >/dev/null 2>&1; then
    printf '  SKIP: shellcheck not on PATH\n' >&2
    return 0
  fi
  shellcheck "$COMMON" "$SPAWN" || fail "shellcheck reported findings"
}

run() {
  local name=$1 fn=$2 out
  if out=$( "$fn" 2>&1 ); then
    printf 'ok     %s\n' "$name"
  else
    printf 'NOT OK %s\n%s\n' "$name" "$out"
    failures=$((failures + 1))
  fi
}

run "[REQ-1]  default level resolves the shipped initial config"   t_req1_default_level_uses_shipped_defaults
run "[REQ-2]  named levels select their configured mapping"        t_req2_named_levels_select_their_mapping
run "[REQ-3]  explicit flags beat the level mapping"               t_req3_explicit_flags_beat_the_level_mapping
run "[REQ-4]  env overrides apply, flags win over env"             t_req4_env_overrides_and_flag_precedence
run "[REQ-5]  missing config degrades to no flags"                 t_req5_missing_config_degrades_to_no_flags
run "[REQ-6]  unknown level degrades to no flags"                  t_req6_unknown_level_degrades_to_no_flags
run "[REQ-7]  malformed config degrades to no flags"               t_req7_malformed_config_degrades_to_no_flags
run "[REQ-8]  child settings inherit thinking/trust baseline"      t_req8_child_settings_inherit_thinking_and_trust_baseline
run "[REQ-9]  launch line carries options ahead of the kickoff"    t_req9_launch_line_carries_options_ahead_of_kickoff
run "[REQ-10] bad spawn invocations die before any work"           t_req10_bad_spawn_invocations_die_early
run "[REQ-11] touched scripts shellcheck-clean"                    t_req11_shellcheck_and_bash_n_clean

if [ "$failures" -gt 0 ]; then
  printf '\n%d test(s) failed\n' "$failures"
  exit 1
fi
printf '\nall tests passed\n'
