Feature: mu-commander installable as a pi package (pi install)
  mu-commander is a shell-script orchestration project: the sub-*.sh helpers,
  config.json task levels, AGENTS.md conventions, tests, and specs. Packaging
  turns the repository into a pi package that a user installs with
  "pi install git:github.com/jseto/mu-commander" and that is eligible for
  the pi package gallery through the pi-package npm keyword. A root
  package.json carries the package identity and an explicit "pi" manifest
  declaring exactly the resources pi should load — the mu-orchestrator skill
  (the orchestrator guidance distilled from AGENTS.md) and the spawn-sub /
  retire-sub prompt templates. Everything the guidance names must resolve
  relative to the installed package: the skill points at the package's own
  scripts/ directory two levels below itself, because pi injects the skill's
  location into the context, while prompt templates defer path knowledge to
  the skill (an expanded template never learns where it was loaded from).
  The helper scripts and config.json ship with every clone as plain payload;
  _sub-common.sh already resolves config.json next to the scripts, so an
  installed package carries working task-level defaults. Repo tooling is
  untouched: the helpers keep taking the target repo as an argument, and the
  root package.json arrives with a committed lockfile and an ignored
  node_modules so the treehouse worktree-setup JS step stays deterministic
  and never dirties a worktree.

  Scenario: Root package.json declares pi package identity [REQ-1]
    Given the repository root package.json
    When it is parsed as JSON
    Then its name is "mu-commander"
    And its description is a non-empty string
    And its keywords include "pi-package"
    And its repository URL names github.com/jseto/mu-commander

  Scenario: Explicit pi manifest declares exactly skills and prompts [REQ-2]
    Given the repository root package.json
    When its "pi" manifest is read
    Then skills declare only "./skills"
    And prompts declare only "./prompts/*.md"
    And no extensions or themes key is declared
    And the declared roots exist and hold exactly the shipped resources:
      skills/mu-orchestrator/SKILL.md, prompts/spawn-sub.md, and
      prompts/retire-sub.md

  Scenario: Shipped guidance resolves helpers package-relative [REQ-3]
    Given the shipped skill and prompt templates
    When their text is scanned for paths
    Then it carries no absolute checkout path (no /home/..., .treehouse/...,
      or programming-projects references)
    And every helper script file it names exists in the package's scripts/
    And the skill instructs resolving the helpers relative to its own
      directory (../../scripts), so an installed clone resolves them inside
      the installed package

  Scenario: Local-path install exposes the resources [REQ-4]
    Given an empty pi agent directory
    When pi install is run against this checkout's path
    Then it succeeds and pi list reports the package source
    And pi's command discovery lists skill:mu-orchestrator, /spawn-sub, and
      /retire-sub as package resources rooted at the package directory
    And no model call or network access is needed for the discovery check

  Scenario: Git install from the pushed branch exposes the same resources [REQ-5]
    Given an empty pi agent directory
    When pi install git:github.com/jseto/mu-commander@<task-branch> runs
    Then it succeeds and pi list reports the git source
    And command discovery lists the same skill and templates as package
      resources rooted inside the installed clone
    And the package's scripts/sub-spawn.sh is reachable from the skill's
      relative rule inside that clone

  Scenario: README documents the GitHub install [REQ-6]
    Given the repository README.md
    When it is read
    Then it shows the exact command "pi install git:github.com/jseto/mu-commander"
    And it lists what the package provides (the mu-orchestrator skill and
      the spawn/retire prompt templates) and how to verify with pi list

  Scenario: Root package.json keeps worktree setup deterministic [REQ-7]
    Given the treehouse post_create hook picks the JS install by lockfile
    When the package files are added to the repository root
    Then a package-lock.json with no dependencies is committed beside
      package.json, so the hook takes the npm ci path and never generates a
      lockfile inside a worktree
    And node_modules/ is gitignored, so hook-created install state never
      shows up as untracked files in a worktree
    And package.json declares no runtime dependencies to install
