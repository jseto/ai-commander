#!/usr/bin/env bash
# Behavioural tests for README.md — one assertion block per Gherkin scenario
# in specs/readme/README.feature ([REQ-n] traceable).
#
# Two kinds of truth are checked:
#   - structure: the sections the feature requires are present (and the ones
#     the repository does not honor, e.g. License, are absent);
#   - referential honesty: every repository path, script, test file, CLI
#     flag, and environment variable README.md mentions must exist in this
#     repository — the README can be reworded freely, but never fabricate a
#     command, file, or variable.
#
# Hermetic: reads only files in this checkout; no network, no tmux, no pi.
#
# Usage: bash tests/readme.test.sh   (exit 0 = all green)
set -u

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
README=$ROOT/README.md

failures=0
fail() { printf '  ASSERT FAILED: %s\n' "$*" >&2; exit 1; }

[ -f "$README" ] || { echo "no README.md at repo root" >&2; exit 1; }

SCRATCH=$(mktemp -d)
trap 'rm -rf "$SCRATCH"' EXIT

# section <heading-regex> — stdout: body of the matching `## ` section,
# from the heading up to (excluding) the next `## ` heading.
section() {
  awk -v pat="$1" '
    /^## / { if (insec) exit; if ($0 ~ pat) { insec=1 } }
    insec  { print }
  ' "$README"
}

# tokens <regex-with-1-group> — stdout: sorted unique captures from README.
tokens() {
  grep -oE "$1" "$README" | sort -u
}

# --- [REQ-1] title + description -------------------------------------------
t_req1_title_and_description() {
  local first
  first=$(grep -m1 -v '^[[:space:]]*$' "$README")
  [ "$first" = "# mu-commander" ] \
    || fail "first non-empty line must be '# mu-commander', got: $first"
  local desc
  desc=$(sed -n '2,/^## /p' "$README")
  local word
  for word in pi tmux treehouse orchestrator child; do
    printf '%s' "$desc" | grep -qi -- "$word" \
      || fail "opening description must mention '$word'"
  done
}

# --- [REQ-2] feature overview ----------------------------------------------
t_req2_feature_overview() {
  local feat
  feat=$(section '^## Features')
  [ -n "$feat" ] || fail "no '## Features' section"
  local topic
  for topic in "sub-" treehouse "task level" fallback orchestrat; do
    printf '%s' "$feat" | grep -qi -- "$topic" \
      || fail "features section must cover '$topic'"
  done
}

# --- [REQ-3] dedicated Installation section ---------------------------------
t_req3_installation_section() {
  local inst
  inst=$(section '^## Installation')
  [ -n "$inst" ] || fail "no top-level '## Installation' section"
  printf '%s' "$inst" | grep -qF 'git clone https://github.com/jseto/mu-commander.git' \
    || fail "Installation must show cloning this repository"
  # dependencies the scripts actually `need`
  local dep
  for dep in git tmux treehouse jq realpath pi gh; do
    printf '%s' "$inst" | grep -qw -- "$dep" \
      || fail "Installation must list dependency '$dep'"
  done
  # mu on PATH
  printf '%s' "$inst" | grep -q 'local/bin' \
    || fail "Installation must show installing mu into ~/.local/bin"
  printf '%s' "$inst" | grep -qE 'ln -s(f)? ' \
    || fail "Installation must show the mu symlink command"
  # one-time setup steps
  printf '%s' "$inst" | grep -qF 'treehouse init' \
    || fail "Installation must document 'treehouse init'"
  printf '%s' "$inst" | grep -q 'config/treehouse/config.toml' \
    || fail "Installation must document the user-level treehouse hook"
  printf '%s' "$inst" | grep -qF '.worktreeinclude' \
    || fail "Installation must document the .worktreeinclude manifest"
  printf '%s' "$inst" | grep -qF 'config.json' \
    || fail "Installation must document config.json setup"
}

# --- [REQ-4] verified commands in Installation ------------------------------
t_req4_installation_commands_exist() {
  # Every scripts/… reference anywhere in the README must exist — matched
  # case-insensitively so "$SCRIPTS/sub-x.sh" references are covered too.
  local ref rel missing=0
  while read -r ref; do
    [ -n "$ref" ] || continue
    rel=${ref##*/}
    [ -f "$ROOT/scripts/$rel" ] || { printf 'missing: scripts/%s\n' "$rel"; missing=1; }
  done < <(grep -ioE 'scripts/[A-Za-z0-9._-]+\.sh' "$README" | sort -u)
  [ "$missing" -eq 0 ] || fail "README references non-existent scripts"
  # The repo's mu launcher is referenced and supports passthrough --help.
  local inst
  inst=$(section '^## Installation')
  printf '%s' "$inst" | grep -qF './mu --help' \
    || fail "Installation must document './mu --help' as a verification"
  printf '%s' "$inst" | grep -qF 'bash tests/' \
    || fail "Installation must document running the test suite"
}

# --- [REQ-5] Usage section with real commands -------------------------------
t_req5_usage_commands_match_scripts() {
  local usage
  usage=$(section '^## Usage')
  [ -n "$usage" ] || fail "no '## Usage' section"
  local script
  for script in sub-spawn.sh sub-status.sh sub-changes.sh sub-send.sh \
                sub-report.sh sub-land.sh sub-retire.sh; do
    printf '%s' "$usage" | grep -qF "$script" \
      || fail "Usage must show $script"
  done
  printf '%s' "$usage" | grep -qE 'start-main\.sh|^mu|[[:space:]]mu ' \
    || fail "Usage must show how to start the orchestrator (start-main.sh or mu)"
  # Flags shown in examples must exist in the scripts they target.
  grep -q -- '--level'  "$ROOT/scripts/sub-spawn.sh"  || fail "--level missing in sub-spawn.sh"
  grep -q -- '--patch'  "$ROOT/scripts/sub-land.sh"   || fail "--patch missing in sub-land.sh"
  grep -q -- '--force'  "$ROOT/scripts/sub-retire.sh" || fail "--force missing in sub-retire.sh"
  grep -q -- '--detach' "$ROOT/scripts/start-main.sh" || fail "--detach missing in start-main.sh"
  printf '%s' "$usage" | grep -q -- '--level'  || fail "Usage must show sub-spawn --level"
  printf '%s' "$usage" | grep -q -- '--patch'  || fail "Usage must show sub-land --patch"
  printf '%s' "$usage" | grep -q -- '--force'  || fail "Usage must show sub-retire --force"
}

# --- [REQ-6] configuration sources -----------------------------------------
t_req6_configuration_documented() {
  local conf
  conf=$(section '^## Configuration')
  [ -n "$conf" ] || fail "no '## Configuration' section"
  local key
  for key in taskLevels default fallbackModel fallbackThinking easy standard hard; do
    printf '%s' "$conf" | grep -qF "$key" \
      || fail "Configuration must document '$key'"
  done
  # Every env var the README names must exist in the scripts.
  local var missing=0
  for var in $(tokens '\b(SUB_[A-Z0-9_]+|DEV_BRANCH|MAIN_SESSION|MAIN_PANE|PI_BIN|PI_BOOT_DELAY|SCRATCH_DIR)\b'); do
    if ! grep -rqE -- "$var" "$ROOT/scripts/"; then
      printf 'env var not found in scripts/: %s\n' "$var"; missing=1
    fi
  done
  [ "$missing" -eq 0 ] || fail "README names env vars the scripts do not use"
}

# --- [REQ-7] development / tests -------------------------------------------
t_req7_development_tests_documented() {
  local dev
  dev=$(section '^## Development')
  [ -n "$dev" ] || fail "no '## Development' section"
  printf '%s' "$dev" | grep -qF 'bash tests/' \
    || fail "Development must show how to run tests with bash"
  printf '%s' "$dev" | grep -qF '[REQ-n]' \
    || fail "Development must explain the [REQ-n] test/scenario linkage"
  local ref missing=0
  for ref in $(tokens 'tests/[A-Za-z0-9._-]+\.sh'); do
    [ -f "$ROOT/$ref" ] || { printf 'missing: %s\n' "$ref"; missing=1; }
  done
  [ "$missing" -eq 0 ] || fail "README references non-existent test files"
}

# --- [REQ-8] no License section while no LICENSE file exists ----------------
t_req8_no_license_section_without_license() {
  if ls "$ROOT"/LICENSE* >/dev/null 2>&1; then
    fail "repo now ships a LICENSE — the README should document it"
  fi
  if grep -qiE '^##+ .*licen[sc]e' "$README"; then
    fail "README must not carry a License section (no LICENSE file exists)"
  fi
}

# --- [REQ-9] scannable structure, no filler --------------------------------
t_req9_scannable_structure() {
  local headings
  headings=$(grep -cE '^## ' "$README")
  [ "$headings" -ge 5 ] || fail "expected at least 5 '## ' sections, got $headings"
  local fences
  fences=$(grep -c '^```' "$README")
  [ "$fences" -ge 6 ] || fail "expected fenced code blocks (>= 6 fence lines), got $fences"
  # no badge/filler boilerplate the repository does not honor
  if grep -qE 'shields\.io|!\[.*\]\(.*badge' "$README"; then
    fail "README must not carry badge boilerplate"
  fi
  local filler
  for filler in Contributing Changelog; do
    if grep -qiE "^##+ $filler" "$README"; then
      fail "README must not carry a '$filler' stub"
    fi
  done
}

# --- [supp] lint ------------------------------------------------------------
t_sup_lint() {
  bash -n "$0" || fail "bash -n reported findings"
  if command -v shellcheck >/dev/null 2>&1; then
    shellcheck "$0" || fail "shellcheck reported findings"
  else
    printf '  SKIP: shellcheck not on PATH\n' >&2
  fi
}

# --- harness ----------------------------------------------------------------
run() {
  local name=$1 fn=$2 out
  if out=$( "$fn" 2>&1 ); then
    printf 'ok     %s\n' "$name"
  else
    printf 'NOT OK %s\n%s\n' "$name" "$out"
    failures=$((failures + 1))
  fi
}

run "[REQ-1]  title and accurate opening description"          t_req1_title_and_description
run "[REQ-2]  feature overview covers the pattern"            t_req2_feature_overview
run "[REQ-3]  dedicated Installation section"                 t_req3_installation_section
run "[REQ-4]  Installation references only real commands"     t_req4_installation_commands_exist
run "[REQ-5]  Usage shows real scripts and flags"             t_req5_usage_commands_match_scripts
run "[REQ-6]  Configuration documents config + env vars"      t_req6_configuration_documented
run "[REQ-7]  Development section documents the tests"        t_req7_development_tests_documented
run "[REQ-8]  no License section without a LICENSE file"      t_req8_no_license_section_without_license
run "[REQ-9]  scannable sections, no filler"                  t_req9_scannable_structure
run "[supp]   shellcheck + bash -n of this suite"             t_sup_lint

if [ "$failures" -gt 0 ]; then
  printf '\n%d test(s) failed\n' "$failures"
  exit 1
fi
printf '\nall tests passed\n'
