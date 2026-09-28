Feature: Rename the project identifier to mu-commander
  The GitHub repository and the checkout folder are being renamed from
  ai-orchestrator/ai-commander to mu-commander. Every hyphenated project
  identifier and its derivations (`ai-orchestrator`, `ai-commander`,
  `repos/jseto/...`, `$XDG_DATA_HOME/.../shellcheck`, checkout paths under
  `/home/jseto/programming-projects/...`) must read `mu-commander` in
  tracked files. Generic prose uses of the English words
  "orchestrator"/"orchestration" describe a role, not the project, and stay
  untouched. Machine-level holders (the treehouse hook, PATH symlinks, the
  managed shellcheck directory) are updated by the orchestrator after the
  checkout folder rename, so this rename must not touch them.

  Scenario: No tracked file or path contains an old project identifier [REQ-1]
    Given the repository checkout on branch task/rename-mu-commander
    When the tracked files and their paths are searched for "ai-orchestrator"
      or "ai-commander"
    Then no tracked file or path matches
    And the rename documents (specs/rename-mu-commander/ and this suite) and
      the earlier rename documents (specs/rename-ai-commander/ and
      tests/rename-project.test.sh) are exempt, because they must name the
      old identifiers to define the renames

  Scenario: The checkout paths documented in AGENTS.md use the new identifier [REQ-2]
    Given the repository checkout
    When "AGENTS.md" is read
    Then the treehouse post_create hook path references
      "/home/jseto/programming-projects/mu-commander/scripts/worktree-setup.sh"
    And the SCRIPTS example references
      "/home/jseto/programming-projects/mu-commander/scripts"
    And neither path references "ai-orchestrator" or "ai-commander"

  Scenario: The managed shellcheck directory uses the new project name [REQ-3]
    Given a fresh environment with no shellcheck at the managed path
    When "worktree-setup.sh" runs
    Then the pinned shellcheck is installed under
      "$XDG_DATA_HOME/mu-commander/shellcheck"
    And the worktree-setup tests resolve the managed path under
      "$HOME/.local/share/mu-commander/shellcheck"

  Scenario: Rename documents are exempt from the identifier check [REQ-4]
    Given the identifier check excludes "specs/rename-mu-commander/",
      "tests/rename-mu-commander.test.sh",
      "specs/rename-ai-commander/" and "tests/rename-project.test.sh"
    When the design doc for this rename is read
    Then it documents each exempt path and why those documents must name the
      old identifiers
    And the earlier rename documents are updated to the same final state,
      keeping the old identifiers only where they define what was renamed

  Scenario: Role prose keeps the word orchestrator [REQ-5]
    Given the repository checkout
    When "AGENTS.md" is read
    Then it still describes the main session as the orchestrator
    And no occurrence of the generic words "orchestrator"/"orchestration"
      was rewritten as part of the rename

  Scenario: The GitHub repository and origin remote carry the new name [REQ-6]
    Given the GitHub repository jseto/ai-commander exists
    When the repository is renamed with the gh CLI
    Then the GitHub repository is named jseto/mu-commander
    And the git remote "origin" of this checkout points at
      "https://github.com/jseto/mu-commander.git"
    And the branch push and pull request target the renamed repository
