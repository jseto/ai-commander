Feature: required skills synced by git hooks and the installer

  mu-commander's workflow relies on the skills curated in ~/.agents/skills
  (atomic-specs, implement, code-auditor, testing, ...), but a clone ships
  only the machinery. Two versioned git hooks — pre-push and post-merge,
  living in .githooks/ and activated through core.hooksPath — mirror the
  user's ~/.agents/skills into the repository's required-skills/ folder at
  push and merge time; the installer copies required-skills/ into
  .agents/skills/ — the project location pi discovers — on every run. Both
  folders are gitignored local caches of a per-machine skill set, never
  committed. The sync mirrors the source set: stale copies are replaced and
  skills the source dropped are pruned, but a missing or empty source never
  destroys the destination. No sync problem may ever fail a push or a
  merge, and the installer's contract (exit status reflects PATH
  dependencies only) is untouched: skills and hooks problems only warn.
  The hooks are activated idempotently by the installer and by
  scripts/worktree-setup.sh, never overwriting a foreign core.hooksPath,
  and only in a repository that actually has a .githooks/ directory.

  Scenario: A push mirrors ~/.agents/skills into required-skills [REQ-1]
    Given a clone with core.hooksPath set to ".githooks"
    And ~/.agents/skills contains the skill directories "alpha" and "beta"
    When the user pushes a commit in the clone
    Then the push succeeds
    And required-skills contains a copy of "alpha" and "beta" whose content
      matches the source directories

  Scenario: A merge mirrors ~/.agents/skills into required-skills [REQ-2]
    Given a clone with core.hooksPath set to ".githooks"
    And ~/.agents/skills contains the skill directory "alpha"
    When the user completes a merge in the clone
    Then the merge succeeds
    And required-skills contains a copy of "alpha" whose content matches
      the source directory

  Scenario: Syncing replaces a stale destination skill with the source version [REQ-3]
    Given a source containing the skill "alpha" with the file "SKILL.md"
    And a destination where "alpha/SKILL.md" holds outdated content and an
      extra file "OLD.md" the source does not have
    When the skills are synced
    Then the destination "alpha/SKILL.md" equals the source version
    And the destination "alpha/OLD.md" no longer exists

  Scenario: Syncing removes destination skills the source no longer has [REQ-4]
    Given a source containing the skill "alpha"
    And a destination containing the skills "alpha" and "extra"
    When the skills are synced
    Then the destination contains "alpha"
    And the destination no longer contains "extra"

  Scenario: A missing or empty source leaves the destination unchanged [REQ-5]
    Given a destination containing the skill "alpha"
    And a source that contains no skill directories
    When the skills are synced
    Then the sync reports a warning
    And the sync exits with status 0
    And the destination still contains "alpha" unchanged

  Scenario Outline: A failing sync never blocks the git operation [REQ-6]
    Given a clone with core.hooksPath set to ".githooks"
    And ~/.agents/skills contains the skill directory "alpha"
    And the clone's required-skills folder exists but is not writable
    When the user runs "<operation>" in the clone
    Then the git operation succeeds
    And the sync failure is reported

    Examples:
      | operation |
      | push      |
      | merge     |

  Scenario: The installer copies required-skills into .agents/skills on every run [REQ-7]
    Given required-skills contains the skill "alpha"
    And .agents/skills does not exist
    When the installer runs while every dependency is already present
    Then the run reports the skills sync
    And .agents/skills contains a copy of "alpha"
    And the installer exits with status 0

  Scenario: A skills failure warns without changing the installer's exit status [REQ-8]
    Given required-skills contains the skill "alpha"
    And the .agents/skills destination cannot be created
    When the installer runs while every dependency is already present
    Then the installer reports the skills failure as a warning
    And the installer exits with status 0

  Scenario: The installer activates the repository's hooks when core.hooksPath is unset [REQ-9]
    Given a clone whose core.hooksPath is unset
    When the installer runs in the clone while every dependency is present
    Then core.hooksPath is ".githooks"
    And the installer reports the activation

  Scenario: A foreign core.hooksPath is never overwritten by the installer [REQ-10]
    Given a clone whose core.hooksPath is "custom-hooks"
    When the installer runs in the clone while every dependency is present
    Then core.hooksPath is still "custom-hooks"
    And the installer warns how to activate the repository's hooks
    And the installer exits with status 0

  Scenario: Worktree provisioning activates the repository's hooks [REQ-11]
    Given a fresh worktree containing a .githooks directory
    And the worktree's core.hooksPath is unset
    When scripts/worktree-setup.sh runs in the worktree
    Then core.hooksPath is ".githooks"

  Scenario: Worktree provisioning skips a repository without .githooks [REQ-12]
    Given a worktree of a repository that has no .githooks directory
    When scripts/worktree-setup.sh runs in the worktree
    Then the script does not read or set core.hooksPath
