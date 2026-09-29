#!/usr/bin/env bash
# Behavioural tests for the pi-package-install feature (root package.json,
# explicit pi manifest, package-relative guidance, local/git installs,
# README, worktree-setup determinism).
# One test per Scenario in specs/pi-package-install/pi-package-install.feature.
#
# Hermetic by construction: the install tests redirect PI_CODING_AGENT_DIR
# to scratch agent directories and run from a scratch cwd, so the real
# ~/.pi/agent settings are never read or written; resource discovery is
# asserted through `pi --mode rpc` get_commands (no model call, no network).
# The git-install test [REQ-5] needs the branch on GitHub, so it is gated
# behind MU_PKG_GIT_VERIFY=1 and skips otherwise.
set -u

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PKG="$ROOT/package.json"
LOCK="$ROOT/package-lock.json"
SKILL_DIR="$ROOT/skills/mu-orchestrator"
SKILL="$SKILL_DIR/SKILL.md"
PROMPTS_DIR="$ROOT/prompts"
README="$ROOT/README.md"

failures=0
fail() { printf '  ASSERT FAILED: %s\n' "$*" >&2; exit 1; }

SCRATCH=$(mktemp -d)
trap 'rm -rf "$SCRATCH"' EXIT

need_jq()  { command -v jq >/dev/null 2>&1 || { printf '  SKIP: jq not on PATH\n' >&2; return 1; }; }
need_pi()  { command -v pi >/dev/null 2>&1 || { printf '  SKIP: pi not on PATH\n' >&2; return 1; }; }

# get_commands_json <agent-dir> <cwd> — the command list as a JSON array.
# Offline + no-session: startup resource discovery only, never a model call.
get_commands_json() {
  local agent=$1 cwd=$2
  ( cd "$cwd" \
    && printf '{"id":"t","type":"get_commands"}\n' \
       | PI_CODING_AGENT_DIR="$agent" pi --mode rpc --no-session --offline \
           2>"$SCRATCH/rpc.err" ) \
    | jq -s -e '[.[] | select(.type == "response"
                              and .command == "get_commands"
                              and .success == true)][0].data.commands'
}

# The full command object of a named command, or nothing when absent.
command_obj() { # $1=commands-json $2=name
  printf '%s' "$1" \
    | jq -c --arg n "$2" '[.[] | select(.name == $n)][0] // empty'
}

# ---------------------------------------------------------------------------
# [REQ-1] Root package.json declares pi package identity
# ---------------------------------------------------------------------------
t_req1_package_identity() {
  need_jq || return 0
  [ -f "$PKG" ] || fail "package.json missing at $PKG"
  jq -e '.name == "mu-commander"' "$PKG" >/dev/null \
    || fail 'package.json .name must be "mu-commander"'
  jq -e '(.description | type == "string" and length > 0)' "$PKG" >/dev/null \
    || fail "package.json .description must be a non-empty string"
  jq -e '.keywords | index("pi-package") != null' "$PKG" >/dev/null \
    || fail 'package.json .keywords must include "pi-package"'
  jq -e '(.repository.url // (.repository | strings) // ""
         | tostring | test("github.com/jseto/mu-commander"))' "$PKG" >/dev/null \
    || fail "package.json repository must name github.com/jseto/mu-commander"
}

# ---------------------------------------------------------------------------
# [REQ-2] Explicit pi manifest declares exactly skills and prompts
# ---------------------------------------------------------------------------
t_req2_manifest_declares_exact_resources() {
  need_jq || return 0
  [ -f "$PKG" ] || fail "package.json missing at $PKG"
  jq -e '.pi.skills == ["./skills"]' "$PKG" >/dev/null \
    || fail 'pi.skills must be exactly ["./skills"]'
  jq -e '.pi.prompts == ["./prompts/*.md"]' "$PKG" >/dev/null \
    || fail 'pi.prompts must be exactly ["./prompts/*.md"]'
  jq -e '.pi | has("extensions") | not' "$PKG" >/dev/null \
    || fail "pi manifest must not declare extensions"
  jq -e '.pi | has("themes") | not' "$PKG" >/dev/null \
    || fail "pi manifest must not declare themes"

  # The declared roots exist and hold exactly the shipped resources.
  [ -f "$SKILL" ] || fail "skill file missing at $SKILL"
  local skills prompts
  skills=$(find "$ROOT/skills" -name SKILL.md | sort) || fail "find skills"
  [ "$skills" = "$SKILL" ] \
    || fail "exactly one skill expected ($SKILL), found: $(printf '%s' "$skills" | tr '\n' ' ')"
  prompts=$(find "$PROMPTS_DIR" -maxdepth 1 -name '*.md' | sort) || fail "find prompts"
  local expected
  expected=$(printf '%s\n%s' "$PROMPTS_DIR/retire-sub.md" "$PROMPTS_DIR/spawn-sub.md" | sort)
  [ "$prompts" = "$expected" ] \
    || fail "exactly two templates expected, found: $(printf '%s' "$prompts" | tr '\n' ' ')"
}

# ---------------------------------------------------------------------------
# [REQ-3] Shipped guidance resolves helpers package-relative
# ---------------------------------------------------------------------------
t_req3_guidance_is_package_relative() {
  local -a scope
  scope=("$SKILL_DIR" "$PROMPTS_DIR" "$README")
  [ -f "$SKILL" ] || fail "skill file missing: $SKILL"
  [ -d "$PROMPTS_DIR" ] || fail "prompts directory missing: $PROMPTS_DIR"
  [ -f "$README" ] || fail "README missing: $README"

  # No absolute checkout path anywhere in the shipped guidance.
  local bad
  if bad=$(grep -REn '/home/[[:alnum:]]|\.treehouse/|programming-projects' "${scope[@]}"); then
    fail "hardcoded checkout path in shipped guidance: $bad"
  fi

  # Every helper script file named in the guidance exists in scripts/.
  local token
  while IFS= read -r token; do
    [ -f "$ROOT/scripts/$token" ] \
      || fail "guidance names $token but scripts/$token does not exist"
  done < <(grep -Eho '[[:alnum:]_-]+\.sh' "${scope[@]}" | sort -u)

  # The skill carries the relative rule itself (the path authority).
  grep -Fq '../../scripts' "$SKILL" \
    || fail "SKILL.md must instruct resolving scripts as ../../scripts (skill-relative)"
}

# ---------------------------------------------------------------------------
# [REQ-4] Local-path install exposes the resources
# ---------------------------------------------------------------------------
t_req4_local_install_exposes_resources() {
  need_jq && need_pi || return 0
  local agent="$SCRATCH/agent-local" proj="$SCRATCH/proj-local" cmds obj
  mkdir -p "$agent" "$proj"
  ( cd "$proj" && PI_CODING_AGENT_DIR="$agent" pi install "$ROOT" \
      >"$SCRATCH/install-local.out" 2>&1 ) \
    || fail "pi install (local) failed: $(cat "$SCRATCH/install-local.out")"
  ( cd "$proj" && PI_CODING_AGENT_DIR="$agent" pi list ) >"$SCRATCH/list-local.out" 2>&1 \
    || fail "pi list failed: $(cat "$SCRATCH/list-local.out")"
  grep -Fq "$ROOT" "$SCRATCH/list-local.out" \
    || fail "pi list does not report the package source ($ROOT)"

  cmds=$(get_commands_json "$agent" "$proj") || fail "get_commands failed (local): $(cat "$SCRATCH/rpc.err")"
  obj=$(command_obj "$cmds" "skill:mu-orchestrator")
  [ -n "$obj" ] || fail "skill:mu-orchestrator not discovered"
  printf '%s' "$obj" | jq -e --arg b "$ROOT" \
    '.source == "skill" and .sourceInfo.origin == "package" and .sourceInfo.baseDir == $b' >/dev/null \
    || fail "skill not a package resource rooted at the package dir: $obj"
  local tpl
  for tpl in spawn-sub retire-sub; do
    obj=$(command_obj "$cmds" "$tpl")
    [ -n "$obj" ] || fail "/$tpl template not discovered"
    printf '%s' "$obj" | jq -e --arg b "$ROOT" \
      '.source == "prompt" and .sourceInfo.origin == "package" and .sourceInfo.baseDir == $b' >/dev/null \
      || fail "/$tpl not a package prompt resource: $obj"
  done
}

# ---------------------------------------------------------------------------
# [REQ-5] Git install from the pushed branch exposes the same resources
# ---------------------------------------------------------------------------
t_req5_git_install_exposes_resources() {
  if [ -z "${MU_PKG_GIT_VERIFY:-}" ]; then
    printf '  SKIP: set MU_PKG_GIT_VERIFY=1 (needs the branch pushed to GitHub)\n' >&2
    return 0
  fi
  need_jq && need_pi || return 0
  local ref=${MU_PKG_GIT_REF:-task/pi-package-install}
  local src="git:github.com/jseto/mu-commander@$ref"
  local agent="$SCRATCH/agent-git" proj="$SCRATCH/proj-git" cmds obj basedir
  mkdir -p "$agent" "$proj"
  ( cd "$proj" && PI_CODING_AGENT_DIR="$agent" pi install "$src" \
      >"$SCRATCH/install-git.out" 2>&1 ) \
    || fail "pi install (git) failed: $(cat "$SCRATCH/install-git.out")"
  ( cd "$proj" && PI_CODING_AGENT_DIR="$agent" pi list ) >"$SCRATCH/list-git.out" 2>&1 \
    || fail "pi list failed: $(cat "$SCRATCH/list-git.out")"
  grep -Fq 'github.com/jseto/mu-commander' "$SCRATCH/list-git.out" \
    || fail "pi list does not report the git source: $(cat "$SCRATCH/list-git.out")"

  cmds=$(get_commands_json "$agent" "$proj") || fail "get_commands failed (git): $(cat "$SCRATCH/rpc.err")"
  obj=$(command_obj "$cmds" "skill:mu-orchestrator")
  [ -n "$obj" ] || fail "skill:mu-orchestrator not discovered after git install"
  basedir=$(printf '%s' "$obj" | jq -r '.sourceInfo.baseDir // empty')
  [ -n "$basedir" ] || fail "skill has no baseDir: $obj"
  [ "$basedir" != "$ROOT" ] \
    || fail "git install loads from the checkout ($ROOT), not the installed clone"
  printf '%s' "$obj" | jq -e '.source == "skill" and .sourceInfo.origin == "package"' >/dev/null \
    || fail "skill not a package resource after git install: $obj"
  [ -f "$basedir/scripts/sub-spawn.sh" ] \
    || fail "scripts/sub-spawn.sh unreachable from the installed clone ($basedir)"
  [ -f "$basedir/skills/mu-orchestrator/SKILL.md" ] \
    || fail "skill missing from the installed clone ($basedir)"
  local tpl
  for tpl in spawn-sub retire-sub; do
    obj=$(command_obj "$cmds" "$tpl")
    [ -n "$obj" ] || fail "/$tpl template not discovered after git install"
    printf '%s' "$obj" | jq -e '.source == "prompt" and .sourceInfo.origin == "package"' >/dev/null \
      || fail "/$tpl not a package prompt after git install: $obj"
  done
}

# ---------------------------------------------------------------------------
# [REQ-6] README documents the GitHub install
# ---------------------------------------------------------------------------
t_req6_readme_documents_install() {
  [ -f "$README" ] || fail "README.md missing at $README"
  grep -Fq 'pi install git:github.com/jseto/mu-commander' "$README" \
    || fail 'README must show "pi install git:github.com/jseto/mu-commander"'
  grep -Fq 'mu-orchestrator' "$README" \
    || fail "README must list the mu-orchestrator skill"
  grep -Fq '/spawn-sub' "$README" \
    || fail "README must list the /spawn-sub template"
  grep -Fq 'pi list' "$README" \
    || fail "README must show how to verify with pi list"
}

# ---------------------------------------------------------------------------
# [REQ-7] Root package.json keeps worktree setup deterministic
# ---------------------------------------------------------------------------
t_req7_worktree_setup_deterministic() {
  need_jq || return 0
  [ -f "$PKG" ] || fail "package.json missing at $PKG"
  [ -f "$LOCK" ] || fail "package-lock.json missing (hook would generate it inside worktrees)"
  # The package must declare nothing to install.
  jq -e '((.dependencies // {}) + (.devDependencies // {})) | length == 0' "$PKG" >/dev/null \
    || fail "package.json must declare no dependencies"
  # ...and the lockfile must lock that empty set.
  jq -e 'has("lockfileVersion")' "$LOCK" >/dev/null \
    || fail "package-lock.json must be a lockfile"
  jq -e '(.packages[""].dependencies // {}) | length == 0' "$LOCK" >/dev/null \
    || fail "package-lock.json must lock no dependencies"
  # The hook writes node_modules/ + marker even for an empty install: it
  # must be ignored so a worktree never looks dirty.
  grep -Eq '^node_modules/$' "$ROOT/.gitignore" \
    || fail ".gitignore must contain node_modules/ (hook-written install state)"
  # And the lockfile must be tracked, so fresh worktrees already have it.
  git -C "$ROOT" ls-files --error-unmatch package-lock.json >/dev/null 2>&1 \
    || fail "package-lock.json must be committed (index entry), not just present"
}

# ---------------------------------------------------------------------------
# [supp] this test file is bash -n / shellcheck clean
# ---------------------------------------------------------------------------
t_supp_shellcheck_clean() {
  bash -n "${BASH_SOURCE[0]}" || fail "bash -n reported syntax errors"
  if ! command -v shellcheck >/dev/null 2>&1; then
    printf '  SKIP: shellcheck not on PATH\n' >&2
    return 0
  fi
  shellcheck "${BASH_SOURCE[0]}" || fail "shellcheck reported findings"
}

# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

run() {
  local name=$1 fn=$2 out
  if out=$( "$fn" 2>&1 ); then
    printf 'ok     %s\n' "$name"
  else
    printf 'NOT OK %s\n%s\n' "$name" "$out"
    failures=$((failures + 1))
  fi
}

run "[REQ-1] Root package.json declares pi package identity"   t_req1_package_identity
run "[REQ-2] Explicit pi manifest declares exactly skills and prompts" t_req2_manifest_declares_exact_resources
run "[REQ-3] Shipped guidance resolves helpers package-relative" t_req3_guidance_is_package_relative
run "[REQ-4] Local-path install exposes the resources"         t_req4_local_install_exposes_resources
run "[REQ-5] Git install from the pushed branch exposes the same resources" t_req5_git_install_exposes_resources
run "[REQ-6] README documents the GitHub install"              t_req6_readme_documents_install
run "[REQ-7] Root package.json keeps worktree setup deterministic" t_req7_worktree_setup_deterministic
run "[supp] bash -n and shellcheck clean"                      t_supp_shellcheck_clean

if [ "$failures" -gt 0 ]; then
  printf '\n%d test(s) failed\n' "$failures"
  exit 1
fi
printf '\nall tests passed\n'
