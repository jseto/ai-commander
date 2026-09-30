Feature: Telegram /mudevserver command for mu-commander child pi sessions

  A pi session bridged to Telegram can list the running child pi sessions of
  the mu-commander orchestrator pattern (tmux sessions named pi-<task>, each
  rooted in a treehouse worktree of some repository's pool), offer every child as a tap
  button on an inline keyboard beside the typed selection, ask a selected child to start
  its project's dev server through the verified tmux send, discover the port
  that server binds, and deliver the phone-reachable intranet and Tailscale
  links as clickable HTML anchors - refreshing the same message when a slow
  child brings the server up. The command ships as a project extension of the
  mu-commander repository, so it exists only in mu-commander sessions, but its
  child menu spans every repository's treehouse pool on the machine - each
  entry labeled with the child's repo - and a child of any repository can be
  selected.

  Scenario: List all running child sessions with their repo, worktree, and dev-server state. [REQ-1]
    Given child tmux sessions "pi-alpha" and "pi-beta" are running with pi-main
    When the user sends "/mudevserver" with no arguments
    Then one chat message lists alpha and beta with their repo and worktree
    And each entry says whether a dev server is already listening in that worktree
    And the current session and pi-main are not listed

  Scenario: Show the reachable links for a child whose dev server already listens. [REQ-2]
    Given child "pi-alpha" has a non-loopback dev server listening in its worktree
    When the menu message is rendered
    Then the alpha entry shows the listener's port
    And every reachable URL for that port is an HTML anchor labeled by network

  Scenario: Resolve a selection by task name, unique prefix, or menu index. [REQ-3]
    Given the menu listed child "pi-alpha" as entry 1
    When the user sends "/mudevserver alpha", "/mudevserver pi-alpha", or "/mudevserver 1"
    Then the same child "alpha" is selected
    And no other child is addressed

  Scenario: Reject an unknown or ambiguous selection without side effects. [REQ-4]
    Given child tmux sessions "pi-alpha" and "pi-alpha-two" are running
    When the user selects with a prefix that matches both, or a name that matches none
    Then a message explains that the selection is unknown or ambiguous and names the candidates
    And no instruction is sent to any child session

  Scenario: Report when no child session is running. [REQ-5]
    Given no tmux session other than pi-main and the current one is named pi-<task>
    When the user sends "/mudevserver" with no arguments
    Then one message says no child session is running
    And no error is reported

  Scenario: Ask a selected child without a dev server through the verified send. [REQ-6]
    Given child "pi-alpha" has no dev server listening in its worktree
    When the user selects alpha
    Then the instruction text is typed into pi-alpha's tmux pane first
    And Enter is sent separately from the text
    And Enter is retried until the pane content changes after the keystrokes

  Scenario: Report an unconfirmed instruction instead of waiting for a server. [REQ-7]
    Given the tmux pane of the selected child never changes after the typed instruction
    When the request is handled
    Then the chat message says the instruction could not be confirmed
    And no port polling starts

  Scenario: Do not ask a child whose dev server is already running. [REQ-8]
    Given child "pi-alpha" already has a non-loopback dev server listening in its worktree
    When the user selects alpha
    Then no instruction is sent to pi-alpha
    And the reply reports the existing server's links

  Scenario: Capture the port the child's dev server binds. [REQ-9]
    Given the ask was confirmed for child "pi-alpha"
    And a non-loopback TCP listener appears in alpha's worktree after the first poll
    When the polls run
    Then the reported port is that listener's port

  Scenario: Deliver both reachable links as clickable HTML anchors. [REQ-10]
    Given the port was captured for child "pi-alpha"
    When an intranet URL and a Tailscale URL answer for that port
    Then the message contains an HTML anchor for the intranet URL labeled as intranet
    And the message contains an HTML anchor for the Tailscale URL labeled as Tailscale

  Scenario: Say so when no reachable URL answers. [REQ-11]
    Given the port was captured for child "pi-alpha"
    And neither the intranet nor the Tailscale probe answers
    When the message is rendered
    Then the message says no LAN or Tailscale address answered for the port
    And it does not offer a dead link

  Scenario: Report a slow child without hanging the command. [REQ-12]
    Given the ask was confirmed for child "pi-alpha"
    And no listener appears in alpha's worktree before the wait deadline
    When the deadline is reached
    Then the message says the dev server did not come up in time and how to check the child
    And the caller was not blocked until the server appeared

  Scenario: Refresh the same message when the server comes up. [REQ-13]
    Given a message was sent saying alpha's dev server is starting
    When the listener appears
    Then that same message is edited to carry the links
    And no second message is sent

  Scenario: Ignore a second request while a child is already being asked. [REQ-14]
    Given a request for child "pi-alpha" is waiting for its dev server
    When the user selects alpha again before the wait finishes
    Then no second instruction is sent to pi-alpha

  Scenario: Register the command on session_start and dispose it on shutdown. [REQ-15]
    Given a mu-commander session starts
    Then exactly one /mudevserver command handler is registered
    When session_start fires again after a reload
    Then still exactly one handler is registered
    When session_shutdown fires
    Then the command handler is removed

  Scenario: Ship the command inside the mu-commander project extensions directory. [REQ-16]
    Given the mu-commander repository
    Then the extension lives under the repository's .pi/extensions directory
    And it is not installed in the global pi extensions directory

  Scenario: List children of every repository's pool, labeled with their repo. [REQ-17]
    Given child sessions "pi-alpha" in a mu-commander worktree and "pi-riak-166-driver-info-view" in a riak-t worktree are running
    When the command lists the children
    Then both children are listed, ordered by task name
    And each entry shows that child's repo name so mu-commander and riak-t children are distinguishable

  Scenario: Select a child of another repository end to end. [REQ-18]
    Given child "pi-riak-166-driver-info-view" is rooted in a riak-t treehouse worktree
    When the user selects riak-166
    Then the instruction is confirmed into pi-riak-166-driver-info-view's tmux pane
    And a non-loopback listener in that riak-t worktree is captured as the port
    And the intranet and Tailscale links for that port are delivered as HTML anchors

  Scenario: Offer each child as a tap button on the menu. [REQ-19]
    Given child tmux sessions "pi-alpha" and "pi-beta" are running with pi-main
    And a selection callback can be built for both children
    When the user sends "/mudevserver" with no arguments
    Then the menu message carries an inline keyboard with one button per child
    And each button is labeled with the child's task name, repo, and dev-server state
    And each button's callback carries exactly that child's task name

  Scenario: Run the same flow when a menu button is tapped. [REQ-20]
    Given child "pi-alpha" has no dev server listening in its worktree
    And the menu message lists alpha with a selection button
    When the user taps alpha's button
    Then the instruction text is typed into pi-alpha's tmux pane through the verified send
    And the flow's progress and links are delivered as one logical message of their own
    And the menu message keeps its list and buttons

  Scenario: Answer the button tap before any selection work starts. [REQ-21]
    When the user taps a menu button
    Then the callback query is answered before child listing or instruction sending begins

  Scenario: Report a tap for a child that died since the menu was sent. [REQ-22]
    Given the menu message lists children "alpha" and "beta" with selection buttons
    And the tmux session "pi-alpha" has ended while the menu is still on screen
    When the user taps alpha's button
    Then a message says no child session matches alpha
    And no instruction is sent to any child session
    And no port polling starts

  Scenario: Register the tap surface with the command and dispose both on shutdown. [REQ-23]
    Given a mu-commander session starts
    Then exactly one command handler and one tap surface are registered
    When session_start fires again after a reload
    Then still exactly one of each is registered
    When session_shutdown fires
    Then both registrations are removed

  Scenario: Stay inert when pi-telegram is absent. [REQ-24]
    Given pi-telegram cannot be loaded in this session
    Then registering the command and the tap surface completes without throwing
    And exactly one diagnostic reports the missing package
    And no selection callback can be built

  Scenario: Keep a child whose button would not fit Telegram's callback limit. [REQ-25]
    Given a child whose name makes its selection callback longer than 64 bytes
    When the user sends "/mudevserver" with no arguments
    Then the menu message is still sent
    And that child's entry carries no button while shorter-named children keep theirs
    And selecting that child by name still works

  Scenario: Keep the command alive when the tap surface cannot register. [REQ-26]
    Given registering the tap surface fails
    When a mu-commander session starts
    Then the command handler is registered anyway
    And the failure is recorded as one diagnostic
    And the menu message is still delivered without a keyboard
