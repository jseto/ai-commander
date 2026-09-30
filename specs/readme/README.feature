Feature: README.md for the mu-commander repository

  The repository root holds a single README.md that describes mu-commander
  as it actually is: the AI orchestrator pattern (a main pi session spawning
  and driving child pi sessions in tmux + treehouse worktrees) plus the
  launcher, helper scripts, specs, and tests that implement it. Every command
  and claim must be verified against the files in this repository (AGENTS.md,
  config.json, mu, install.sh, scripts/*.sh, tests/, specs/); anything
  uncertain is left out rather than fabricated. The README is short and
  scannable, organized as exactly five sections in this order — "What is
  it", "Install", "How to use", "Mu usage for self-configuration",
  "Dependencies" — with fenced code blocks and no filler. No License
  section: the repository ships no LICENSE file, and guessing one would be
  fabrication.

  Scenario: Open with the project title and an accurate description [REQ-1]
    Given the README.md file at the repository root
    Then it begins with the heading "mu-commander"
    And before the first section heading it contains a one-paragraph
      description of the project as an AI orchestrator pattern where a
      main pi session spawns and drives child pi sessions in tmux and
      treehouse worktrees

  Scenario: Describe the pattern up front [REQ-2]
    Given the README.md file at the repository root
    Then it contains a "What is it" section
    And that section covers the orchestration pattern, the sub-* helper
      scripts, and the treehouse worktree pool
    And the "Mu usage for self-configuration" section covers the task
      levels and the free-provider fallback

  Scenario: Provide a dedicated Install section [REQ-3]
    Given the README.md file at the repository root
    Then it contains a top-level "Install" section
    And the section documents cloning the repository
    And it lists the dependencies the scripts actually invoke
    And it documents making the mu launcher available on PATH
    And it documents the one-time setup steps (treehouse init, the
      user-level treehouse hook, the .worktreeinclude manifest, config.json)

  Scenario: Document only verified commands in Install [REQ-4]
    Given the Install section of README.md
    Then every repository script path it mentions exists in the repository
    And it documents how to verify the installation using commands the
      repository actually supports

  Scenario: Give a concise "How to use" section with real commands [REQ-5]
    Given the README.md file at the repository root
    Then it contains a "How to use" section
    And its example commands match the actual usage lines of the scripts
      they invoke (sub-spawn, sub-status, sub-send, sub-report, sub-land,
      sub-retire, start-main or mu)

  Scenario: Document configuration sources [REQ-6]
    Given the README.md file at the repository root
    Then it contains a "Mu usage for self-configuration" section
    And it documents the config.json taskLevels structure (default, levels
      with model and thinking, fallbackModel, fallbackThinking)
    And every environment variable it names exists in the scripts

  Scenario: Document how the tests are run [REQ-7]
    Given the README.md file at the repository root
    Then it documents running the test suite directly with bash
    And it explains the [REQ-n] test/scenario linkage
    And it references test files that exist in tests/

  Scenario: Omit the License section when no license exists [REQ-8]
    Given the repository contains no LICENSE file
    Then README.md contains no License section and claims no license

  Scenario: Keep the README scannable [REQ-9]
    Given the README.md file at the repository root
    Then it is organized as Markdown sections with headings
    And commands are shown in fenced code blocks
    And it contains no filler boilerplate sections (no badges, no
      "Contributing" or "Changelog" stubs the repository does not honor)
