#!/usr/bin/env bash
# Test suite for mu (invoked as `mu`) — one assertion block per Gherkin
# scenario in specs/mu-launcher/mu-launcher.feature ([REQ-n] traceable).
# Migrated from test-pi-sh.sh, whose coverage this suite replaces: pi.sh's
# "refuses the reserved pi-main name" scenario is inverted — mu must use
# exactly pi-main ([REQ-1]).
#
# Hermetic: pi and tmux are replaced by logging fakes found first on PATH, so
# no real tmux session is ever created.
#
# Usage: bash tests/test-mu.sh   (exit 0 = all green)
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
MU="$ROOT/mu"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/nopi"

cat > "$TMP/bin/pi" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat > "$TMP/bin/tmux" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%q ' "$@" >> "${TMUX_LOG:?}"
printf '\n' >> "$TMUX_LOG"
if [[ ${1:-} == has-session ]]; then
  if [[ -e ${TMUX_EXISTS:?} ]]; then
    exit 0
  else
    exit 1
  fi
fi
EOF
chmod +x "$TMP/bin/pi" "$TMP/bin/tmux"

# A second pi binary deliberately kept OFF PATH, to prove [REQ-6] prefers
# PI_BIN over the PATH lookup.
cat > "$TMP/other-pi" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$TMP/other-pi"

# A fully controlled PATH for [REQ-7]'s "no pi anywhere" half: the logging
# fake tmux plus the external tools mu invokes on this direct-invocation
# path (bash for its #! line, dirname). Nothing here can provide a pi binary;
# readlink is only reached when mu is itself a symlink, which this path
# never is.
ln -s "$(command -v bash)" "$TMP/nopi/bash"
ln -s "$(command -v dirname)" "$TMP/nopi/dirname"
cp "$TMP/bin/tmux" "$TMP/nopi/tmux"

unset PI_BIN 2>/dev/null || true

# --- harness ----------------------------------------------------------------

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
reset() { : > "$TMP/log"; rm -f "$TMP/exists"; }
assert_has()   { grep -F -- "$1" "$2" >/dev/null || fail "$3 — [$1] not found in $2"; }
assert_not()   { if grep -F -- "$1" "$2" >/dev/null; then fail "$3 — [$1] unexpectedly in $2"; fi; }
assert_empty() { if [ -s "$TMP/log" ]; then fail "$1 — tmux was called: $(cat "$TMP/log")"; fi; }
assert_rc_nz() { if [ "$1" -eq 0 ]; then fail "$2 — expected non-zero exit, got 0"; fi; }

run_mu() { # mu args… — outside tmux, fake tools first on PATH
  PATH="$TMP/bin:$PATH" TMUX='' TMUX_LOG="$TMP/log" TMUX_EXISTS="$TMP/exists" "$MU" "$@"
}

# --- scenarios --------------------------------------------------------------

printf '[REQ-1] Create a detached session named exactly pi-main at the repository root\n'
reset
run_mu
assert_has 'new-session -d -s pi-main -c '"$ROOT"' -- ' "$TMP/log" 'REQ-1 session creation'
# The pi binary was resolved from PATH — the default when PI_BIN is unset.
assert_has '-- '"$TMP"'/bin/pi' "$TMP/log" 'REQ-1 pi resolved from PATH'

printf '[REQ-2] Forward extra arguments to pi unchanged\n'
reset
run_mu --model 'name with spaces'
assert_has '--model name\ with\ spaces' "$TMP/log" 'REQ-2 argument boundaries preserved'

printf '[REQ-3] Reuse an existing pi-main session without starting a second pi\n'
reset
touch "$TMP/exists"
run_mu
assert_not 'new-session' "$TMP/log" 'REQ-3 no second session'
assert_has 'attach-session -t =pi-main' "$TMP/log" 'REQ-3 hand-off to existing session'

printf '[REQ-4] Attach to pi-main when invoked outside tmux\n'
reset
run_mu
assert_has 'attach-session -t =pi-main' "$TMP/log" 'REQ-4 attach'
assert_not 'switch-client' "$TMP/log" 'REQ-4 no switch outside tmux'
# The attach is the final tmux operation (mu execs into the hand-off).
[ "$(tail -n 1 "$TMP/log")" = 'attach-session -t =pi-main ' ] \
  || fail "REQ-4 final operation — last log line: $(tail -n 1 "$TMP/log")"

printf '[REQ-5] Switch the client to pi-main when invoked inside tmux\n'
reset
PATH="$TMP/bin:$PATH" TMUX=client TMUX_LOG="$TMP/log" TMUX_EXISTS="$TMP/exists" "$MU"
assert_has 'switch-client -t =pi-main' "$TMP/log" 'REQ-5 switch'
assert_not 'attach-session' "$TMP/log" 'REQ-5 no attach inside tmux'

printf '[REQ-6] Use PI_BIN when it points at a pi executable\n'
reset
PATH="$TMP/bin:$PATH" TMUX='' PI_BIN="$TMP/other-pi" \
  TMUX_LOG="$TMP/log" TMUX_EXISTS="$TMP/exists" "$MU"
assert_has '-- '"$TMP"'/other-pi' "$TMP/log" 'REQ-6 PI_BIN used as the command'
assert_not "$TMP/bin/pi" "$TMP/log" 'REQ-6 PATH fallback not used'

printf '[REQ-7] Fail with a clear error before touching tmux when no pi is found\n'
reset
rc=0
PATH="$TMP/bin:$PATH" TMUX='' PI_BIN="$TMP/no-such-pi" \
  TMUX_LOG="$TMP/log" TMUX_EXISTS="$TMP/exists" "$MU" 2>"$TMP/err" || rc=$?
assert_rc_nz "$rc" 'REQ-7 unusable PI_BIN'
grep -F 'mu: pi executable not found' "$TMP/err" >/dev/null \
  || fail "REQ-7 error message — stderr: $(cat "$TMP/err")"
assert_empty 'REQ-7 unusable PI_BIN'
reset
rc=0
PATH="$TMP/nopi" TMUX='' TMUX_LOG="$TMP/log" TMUX_EXISTS="$TMP/exists" \
  "$MU" 2>"$TMP/err" || rc=$?
assert_rc_nz "$rc" 'REQ-7 no pi on PATH'
grep -F 'mu: pi executable not found' "$TMP/err" >/dev/null \
  || fail "REQ-7 error message — stderr: $(cat "$TMP/err")"
assert_empty 'REQ-7 no pi on PATH'

printf '[REQ-8] Root the session at the real mu when invoked through a PATH symlink\n'
reset
ln -s "$MU" "$TMP/bin/mu" # a PATH command, exactly like ~/.local/bin/mu
PATH="$TMP/bin:$PATH" TMUX='' TMUX_LOG="$TMP/log" TMUX_EXISTS="$TMP/exists" \
  "$TMP/bin/mu"
assert_has 'new-session -d -s pi-main -c '"$ROOT"' -- ' "$TMP/log" \
  'REQ-8 rooted at the repository, not the symlink directory'
assert_not "-c $TMP/bin" "$TMP/log" 'REQ-8 symlink directory is never the root'

# --- gates ------------------------------------------------------------------

printf '[gate] mu is executable and shellcheck-clean\n'
[ -x "$MU" ] || fail 'mu is not executable'
if command -v shellcheck >/dev/null 2>&1; then
  shellcheck "$MU" "$ROOT/tests/test-mu.sh" || fail 'shellcheck reported issues'
else
  printf 'skip: shellcheck not available\n' >&2
fi

printf 'all mu tests passed\n'
