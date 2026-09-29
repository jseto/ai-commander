---
description: Spawn a mu-commander child pi session for a task
argument-hint: "<task> <repo> [brief-file] [--level easy|standard|hard]"
---
Read the `mu-orchestrator` skill first — it owns the package-relative
`SCRIPTS` resolution; drive the helpers from there, never from a hardcoded
checkout path.

Spawn a subsession for: $ARGUMENTS

- Check `tmux ls` and `treehouse status` first: route to an existing live
  child instead of double-booking the name.
- No brief file in the arguments? Write the requirements to
  `tmp/pi-sub/tasks/<task>.md` in the main checkout first, and include the
  instruction to write the final report to `tmp/pi-sub/reports/<task>.md`.
- Run `"$SCRIPTS/sub-spawn.sh" <task> <repo> [brief] --level <level>` with
  a kebab-case task name (2–4 words, say what it does). Pick the level from
  `config.json` taskLevels: `easy` chores, `standard` (default)
  features/bug fixes, `hard` architecture / long-haul.
- Report the handles back: task, worktree, branch, tmux session, brief and
  report paths.
