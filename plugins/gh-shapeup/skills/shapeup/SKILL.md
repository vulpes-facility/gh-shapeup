---
name: shapeup
description: Run Shape Up on the repository's GitHub Issues and Project for the user with the gh shapeup CLI - write and change pitches, bet them on a cycle or take the bet back, stop one with the circuit breaker, add, start, move, finish or cut scopes, finish pitches with a completion report, file cooldown work and bugs, check the board for drift, and set up the labels and the project. Use when the user asks for any of these.
---

# gh shapeup

Run `gh shapeup` for the user, so they never have to type it.
Each command prints what it made; relay it.
If `gh shapeup` is not found, install it with `gh extension install vulpes-facility/gh-shapeup`.
It reads `.github/shapeup.json` from the nearest directory at or above the working directory; the README of vulpes-facility/gh-shapeup covers the setup.

## What it manages

- **Pitch**: an issue with the pitch label, on the project with a Status, an Appetite and a Cycle.
  Its Status is Shaped, then Bet once it is bet on a cycle, In progress once its first scope starts, and in the end Done or Dropped.
- **Scope**: an issue with the scope label, a sub-issue of its pitch, with a Hill Position from 0 to 100.
  Up to 50 is figuring things out; at 50 no unknowns are left; past 50 is making it happen.
  The hill chart at the top of the pitch body is drawn from these positions.
- **Cooldown work** and **bugs**: issues made from their templates.
- Labels, fields, options and section names are the config's; the ones here are the defaults.
  Each kind's sections are in the config's `kinds`, and its template in `.github/ISSUE_TEMPLATE/`.

## From request to command

| The user wants | Do |
| --- | --- |
| A new pitch | `gh shapeup pitch new --title … --appetite <key> --from <file>`, the file holding the pitch template's `## ` sections |
| To change a pitch | `gh shapeup pitch edit <number> [--title …] [--from <file>] [--appetite <key>] --reason …`; the appetite changes only while the pitch is Shaped |
| To bet a pitch on a cycle | `gh shapeup pitch bet <number> --cycle "<cycle title>" --reason …` |
| To take a bet back | `gh shapeup pitch unbet <number> --reason …` |
| To stop a pitch that ran out of time | `gh shapeup pitch break <number> --reason …`, the circuit breaker |
| To finish a pitch | `gh shapeup pitch done <number> --report-file <file>` |
| A new scope | `gh shapeup scope new --pitch <number> --title … --done …` |
| To change a scope | `gh shapeup scope edit <number> [--title …] [--done …] --reason …` |
| To start a scope | `gh shapeup scope start <number> --reason …` |
| To move a scope on the hill | `gh shapeup scope hill <number> --position <0-100> --reason …` |
| To finish a scope | `gh shapeup scope done <number> --report-file <file>` |
| To cut a scope the pitch can ship without | `gh shapeup scope drop <number> --reason …` |
| Cooldown work | `gh shapeup cooldown new --title … --what … [--why …] --done …`, and `gh shapeup cooldown edit <number> … --reason …` to change it |
| To file a bug | `gh shapeup bug new --title … --symptom … --steps … --expected … [--environment …]`, and `gh shapeup bug edit <number> … --reason …` to change it |
| To check the board for drift | `gh shapeup audit [--pitch <number>]` |
| The labels, the project and its fields | `gh shapeup init [--force]` |

## Rules

- **Every change leaves its reason.** Every command that changes an existing issue needs a reason, which it posts as a comment on that issue;
  `pitch done` and `scope done` post a completion report instead.
  Take the reason from what the user said, and ask when they gave none; never make one up.
  Pass a short one with `--reason`, and Markdown or anything longer as a file with `--reason-file`.
- **Sections go in a file.** For a `new` or an `edit` with more than a line of text, write the sections to a Markdown file under `## ` headings named exactly as the kind's template, and pass `--from <file>`.
  A heading the config does not name is left out, so check the template's headings first.
- **Completion reports follow their template.** `pitch done` and `scope done` post a report from `--report-file`: exactly the report template's `## ` sections, in order, none empty.
  The defaults are Outcome, Evidence and Follow-ups for a scope, and Outcome, Scopes, Accepted limits and Follow-ups for a pitch;
  a repository may change them in the config's `reports` or in `.github/shapeup/scope-report.md` and `.github/shapeup/pitch-report.md`, so read those first.
  Write each section from what happened, such as merged pull requests and passing tests; where nothing applies, write `None.`
  Show the user a report you wrote before you post it.
- **Keep your files out of the repository.** Write reason, section and report files to a temporary directory, not the working tree.
- **Scopes are worked on only while their pitch is bet.** `scope start` and `scope hill` refuse a scope whose pitch is not Bet or In progress; betting is the user's decision, so ask instead of betting the pitch yourself.
- **Move on the hill with what changed.** The reason for `scope hill` says what was learned or built, such as the unknown that was solved when a scope passes 50.
- **Finished stays finished.** A done or dropped scope is never started again; work that follows it is a new scope.
  A pitch is done only when none of its scopes is open: finish each with `scope done`, or cut it with `scope drop`.
- **Ask before taking things away.** `pitch break` closes a pitch and its unfinished scopes as not planned, `scope drop` closes a scope as not planned, and `init --force` may delete a field of the wrong type with its values.
  Confirm with the user first.
- **A refusal changed nothing.** A refusal exits with 2 before any change and says why; do what it says instead of running the same command again.
  A message with "already" means the result already holds and nothing is left to do.
  A `partial` error lists what was made, what failed and how to finish; follow it.
  A state command finishes when run again, but a `new` must never be run again, since it would create another issue.
- **Check at the end.** After a series of changes, run `gh shapeup audit`, which exits with 1 when it finds something, and relay what it finds.
- **Tokens stay out of sight.** The CLI uses the `gh` login, and `SHAPEUP_PROJECT_TOKEN` for the project when it is set. Never print a token or put one on a command line.
- **Some setup is the user's.** After `init`, the user turns on *Auto-add to project* and *Auto-add sub-issues to project* in the project's Workflows, which the API cannot do.
  A project that `init` creates may get a new number; set `projectNumber` in the config to it before running `init --force`.
