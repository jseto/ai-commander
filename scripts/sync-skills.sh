#!/usr/bin/env bash
# Mirror skill directories from a source folder into a destination folder.
#
# Usage: scripts/sync-skills.sh <source-dir> <dest-dir>
#
# A "skill" is an immediate subdirectory of <source-dir> (Agent Skills
# spec). Every source skill is copied into <dest-dir>, replacing a stale
# copy wholesale (per-skill remove-then-copy, so files the source dropped
# cannot survive), and destination skills the source no longer contains are
# pruned — the destination mirrors the source set. Destination entries that
# are not directories are left alone.
#
# Never destructive: a missing source, or one without a single skill
# directory, leaves the destination untouched and only warns (exit 0) — an
# empty ~/.agents/skills must never wipe the cache. Only a real copy
# failure exits 1; callers decide what that means (the git hooks never fail
# the push/merge, see specs/skills-sync-hook/skills-sync-hook.feature).
set -uo pipefail

usage() { printf 'usage: scripts/sync-skills.sh <source-dir> <dest-dir>\n' >&2; }

src=${1:-}
dst=${2:-}
if [ -z "$src" ] || [ -z "$dst" ] || [ "$#" -gt 2 ]; then
  usage
  exit 2
fi

# Collect the source skills first: an empty set is a warning, never a wipe.
skills=()
if [ -d "$src" ]; then
  for skill in "$src"/*/; do
    [ -d "$skill" ] && skills+=("$skill")
  done
fi
if [ "${#skills[@]}" -eq 0 ]; then
  printf 'skills-sync: no skills in %s - leaving %s unchanged\n' "$src" "$dst" >&2
  exit 0
fi

if ! mkdir -p "$dst"; then
  printf 'skills-sync: cannot create %s\n' "$dst" >&2
  exit 1
fi

for skill in "${skills[@]}"; do
  name=${skill%/}
  name=${name##*/}
  if ! rm -rf "${dst:?}/$name" || ! cp -a "$skill" "$dst/$name"; then
    printf 'skills-sync: failed to copy %s into %s\n' "$skill" "$dst" >&2
    exit 1
  fi
done

# Prune destination skills the source dropped (mirror the source set).
for stale in "$dst"/*/; do
  [ -d "$stale" ] || continue
  name=${stale%/}
  name=${name##*/}
  if [ -d "$src/$name" ]; then
    continue
  fi
  if ! rm -rf "$stale"; then
    printf 'skills-sync: failed to remove stale skill %s\n' "$stale" >&2
    exit 1
  fi
done

printf 'skills-sync: %d skill(s) synced %s -> %s\n' "${#skills[@]}" "$src" "$dst"
