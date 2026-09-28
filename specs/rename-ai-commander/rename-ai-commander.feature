Feature: Rename the project identifier from ai-orchestrator to ai-commander
  The checkout folder was already renamed to ai-commander, but the hyphenated
  project identifier `ai-orchestrator` (and everything derived from it:
  `local-pi-ai-orchestrator`, `repos/jseto/ai-orchestrator`,
  `~/.local/share/ai-orchestrator/shellcheck`, paths under
  `/home/jseto/programming-projects/ai-orchestrator/`) still appears in
  tracked files and machine state. Generic prose uses of the English words
  "orchestrator"/"orchestration" describe a role, not the project, and must
  stay untouched.

  Scenario: No tracked file contains the old project identifier [REQ-1]
    Given the repository checkout on branch task/rename-ai-commander
    When the tracked files are searched for "ai-orchestrator"
    Then no tracked file matches
    And the rename's own specification and test documents
      (specs/rename-ai-commander/, tests/rename-project.test.sh) are exempt,
      since they must name the old identifier to define the rename
    And the derived identifiers reference "ai-commander" instead
      (AGENTS.md hook path and SCRIPTS path, scripts/worktree-setup.sh
      managed shellcheck path, pi.sh session default, and the specs
      documents under specs/)

  Scenario: pi.sh defaults to the renamed local session [REQ-2]
    Given no local pi tmux session exists
    When the user runs pi.sh without PI_TMUX_SESSION
    Then pi.sh attaches to the tmux session "local-pi-ai-commander"

  Scenario: The managed shellcheck directory uses the new project name [REQ-3]
    Given a fresh environment with no shellcheck at the managed path
    When "worktree-setup.sh" runs
    Then the shellcheck of the pinned version is installed under
      "$XDG_DATA_HOME/ai-commander/shellcheck"
    And the worktree-setup tests resolve the managed path under
      "$HOME/.local/share/ai-commander/shellcheck"

  Scenario: On this machine the provisioned shellcheck lives at the new path [REQ-4]
    Given this machine has a managed shellcheck install
    When the managed data directory is inspected
    Then "~/.local/share/ai-commander/shellcheck" exists
    And "~/.local/share/ai-orchestrator" does not exist
    And "~/.local/bin/shellcheck" resolves through the new managed path
      and reports the pinned version
    And running "worktree-setup.sh" performs no re-download

  Scenario: The treehouse post_create hook points at the renamed checkout [REQ-5]
    Given this machine has a user-level treehouse config
    When "~/.config/treehouse/config.toml" is read
    Then its post_create hook references
      "/home/jseto/programming-projects/ai-commander/scripts/worktree-setup.sh"
    And it does not reference "ai-orchestrator"

  Scenario: Role prose keeps the word orchestrator [REQ-6]
    Given the repository checkout
    When "AGENTS.md" is read
    Then it still describes the main session as the orchestrator
    And no occurrence of the generic words "orchestrator"/"orchestration"
      was rewritten as part of the rename

  Scenario: The origin remote carries the current repository name [REQ-7]
    Given the GitHub repository jseto/ai-orchestrator was renamed to
      jseto/ai-commander by this task
    And a follow-up task has since renamed it to jseto/mu-commander
    When the git remote "origin" of this checkout is inspected
    Then it points at "https://github.com/jseto/mu-commander.git"
    And it does not reference "ai-orchestrator"
