Feature: mu — launch pi in the "pi-main" tmux session

  mu (mu.sh) supersedes pi.sh. Where pi.sh refused the reserved session names
  "pi-main" and "pi-*", mu deliberately targets the orchestrator session
  "pi-main": it is a thin, standalone, root-level launcher that runs pi inside
  that one durable session. It coexists with scripts/start-main.sh, the
  orchestrator's own launcher of the same session. The file is named mu.sh
  and is installed on PATH as the command `mu` through a symlink in
  ~/.local/bin.

  Scenario: Create a detached session named exactly pi-main at the repository root [REQ-1]
    Given no tmux session named "pi-main" exists
    When the user runs mu
    Then mu creates a detached tmux session named exactly "pi-main"
    And the session is rooted at the repository root that contains mu.sh
    And mu does not refuse the reserved name "pi-main"

  Scenario: Forward extra arguments to pi unchanged [REQ-2]
    Given no tmux session named "pi-main" exists
    When the user runs mu with extra pi arguments
    Then mu passes every extra argument through to pi with its boundaries preserved

  Scenario: Reuse an existing pi-main session without starting a second pi [REQ-3]
    Given the tmux session "pi-main" already exists
    When the user runs mu
    Then mu does not create a session nor start a second pi process
    And mu hands the terminal to the existing session

  Scenario: Attach to pi-main when invoked outside tmux [REQ-4]
    Given the caller is outside tmux
    When the user runs mu
    Then mu attaches a tmux client to "pi-main"

  Scenario: Switch the client to pi-main when invoked inside tmux [REQ-5]
    Given the caller is inside tmux
    When the user runs mu
    Then mu switches the current client to "pi-main" instead of attaching

  Scenario: Use PI_BIN when it points at a pi executable [REQ-6]
    Given "PI_BIN" points to an executable pi binary that is not on PATH
    When the user runs mu
    Then the new session runs exactly that binary

  Scenario: Fail with a clear error before touching tmux when no pi is found [REQ-7]
    Given "PI_BIN" points to a non-executable path, or "PI_BIN" is unset and no "pi" executable is on PATH
    When the user runs mu
    Then mu exits with a non-zero status and an error message prefixed "mu:" on standard error
    And no tmux session is created

  Scenario: Root the session at the real repository when invoked through a PATH symlink [REQ-8]
    Given "~/.local/bin/mu" is a symlink to the repository's mu.sh
    When the user runs mu
    Then the session is rooted at the directory containing the real mu.sh, not at the symlink's directory
    And running ./mu.sh directly roots the session exactly as before
