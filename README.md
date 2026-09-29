# gh-shapeup

Run [Shape Up](https://basecamp.com/shapeup) on GitHub Issues and Projects.

- A **CLI** that creates and edits pitches, scopes, cooldowns and bugs from your issue templates,
  bets pitches on cycles, moves scopes on the hill, comments on every issue it changes with the reason or a completion report,
  and audits the board for drift.
  It installs as the gh extension `gh shapeup`.
- A **hill chart Action** that draws each pitch's hill chart as an SVG and keeps it at the top of the pitch body.
- A **board Action** that runs the cycle's commands from a workflow, such as after an agent's work, with the CLI's checks and refusals.
- A **Claude Code plugin** that runs the CLI for you when you ask Claude.

The CLI and both Actions read one config file that names your project, its fields and your templates.
The config holds names only: issues, statuses, cycles and hill positions are always read live from GitHub.

## How Shape Up maps onto GitHub

| Shape Up | GitHub |
| --- | --- |
| Pitch | An issue with the `pitch` label |
| Scope | An issue with the `scope` label, linked as a sub-issue of its pitch |
| Betting table | A GitHub Project with a single-select **Status** field (Shaped, Bet, In progress, Done, Dropped) |
| Appetite | A single-select **Appetite** field on the pitch |
| Cycle | An iteration field **Cycle** |
| Hill position | A Number field **Hill Position** (0–100) on each scope; empty counts as 0 |
| Circuit breaker | `gh shapeup pitch break`: closes the pitch and its open scopes as not planned |
| Scope hammering | `gh shapeup scope drop`: closes a scope the pitch can ship without as not planned |
| Cooldown work, bugs | Issues with the `cooldown` and `bug` labels, created from their templates |

Every field, option and label name above is a default and can be renamed in the config.

## Setup

1. **Project and labels.** Once the config and the CLI are in place (steps 4 and 7), `gh shapeup init` creates the four labels, a project linked to the repository and the four fields above, all named as the config says.
   Or create them by hand on a user or organization project.
2. **Project workflows.** In the project's Workflows, turn on *Auto-add to project* for the repository and *Auto-add sub-issues to project*.
   The API cannot turn them on, so `init` only reminds you.
3. **Issue templates.** Copy [`examples/ISSUE_TEMPLATE/`](examples/ISSUE_TEMPLATE) to `.github/ISSUE_TEMPLATE/`.
   A template needs front matter with `title` (the prefix, such as `"Pitch: "`) and `labels`,
   one `## ` section per CLI parameter of its kind, and the footnote markers.
   The pitch template also carries the hill markers the hill chart Action writes between.
4. **Config.** Copy [`examples/shapeup.json`](examples/shapeup.json) to `.github/shapeup.json` and set your project.
   Its `$schema` line gives editors a description of every key; see [`config.schema.json`](config.schema.json).
5. **Token.** Add a repository secret `SHAPEUP_PROJECT_TOKEN` that can read the project.
   For a user-owned project use a classic token with `read:project` and `repo`.
   The [board Action](#board-action) changes the project, so its token needs more; see [Tokens](#tokens).
6. **Workflow.** Copy [`examples/workflows/shapeup-hill.yml`](examples/workflows/shapeup-hill.yml) to `.github/workflows/`.
   To change the board from a workflow, start from [`examples/workflows/shapeup-board.yml`](examples/workflows/shapeup-board.yml).
7. **CLI.** Run `gh extension install vulpes-facility/gh-shapeup`.
   It is one binary for macOS, Linux or Windows that needs nothing but `gh`, and it uses your `gh` login.
   `gh extension upgrade shapeup` updates it.
8. **Claude Code plugin** (optional). Run `claude plugin marketplace add vulpes-facility/claude-plugins`
   and `claude plugin install gh-shapeup@vulpes-facility`; see [Claude Code plugin](#claude-code-plugin).

## CLI

```
gh shapeup pitch new --title T --appetite <key> --problem … --solution … --rabbit-holes … --no-gos …
gh shapeup pitch edit <number> [--title T] [section parameters] [--appetite <key>] --reason …
gh shapeup pitch bet <number> --cycle "<cycle title>" --reason …
gh shapeup pitch unbet <number> --reason …
gh shapeup pitch break <number> --reason …
gh shapeup pitch done <number> --report-file <file>
gh shapeup scope new --pitch <number> --title T --done …
gh shapeup scope edit <number> [--title T] [--done …] --reason …
gh shapeup scope start <number> --reason …
gh shapeup scope hill <number> --position 0-100 --reason …
gh shapeup scope done <number> --report-file <file>
gh shapeup scope drop <number> --reason …
gh shapeup cooldown new --title T --what … [--why …] --done …
gh shapeup cooldown edit <number> [--title T] [section parameters] --reason …
gh shapeup bug new --title T --symptom … --steps … --expected … [--environment …]
gh shapeup bug edit <number> [--title T] [section parameters] --reason …
gh shapeup audit [--pitch <number>]
gh shapeup init [--force]
```

- Section parameters are set per kind in the config's `kinds`; the ones above are the defaults.
  `title`, `from`, `footnote`, `reason`, `reason-file`, `report`, `report-file`, `appetite`, `pitch`, `cycle`, `position` and `force`
  are the CLI's own parameters and cannot name a section.
- Every `new` and `edit` also takes `--from <file>` (Markdown split into `## ` sections) and repeated `--footnote name=description`.
- A command refuses any option it does not read, and an `edit` refuses when it names nothing to change, before it calls GitHub.
- Every command that changes an existing issue leaves a comment on it.
  `pitch done` and `scope done` need a [completion report](#completion-reports) from `--report-file <file>`.
  Every other one needs a reason: `--reason <text>`, or `--reason-file <file>` with Markdown that is posted as it is.
  Without one, with both, or with an empty one, the command changes nothing and exits with 2.
- The command makes its change first and then posts the reason or the report as one comment on the issue it names, with nothing added.
  `pitch bet`, `unbet` and `break` also change the pitch's scopes, but comment only on the pitch.
  `scope start` also sets its pitch In progress when the pitch is Bet, but comments only on the scope.
  Every check that can refuse the command comes before its first change.
  A failed change posts nothing; a comment that fails after the change is reported, and the command exits with 2.
- A command whose result already holds refuses, and one that stops part-way says what it made; see [State commands](#state-commands).
- A comment on a scope wakes the hill chart Action, so the comment of every `scope` command wakes it; after `scope hill` that is what redraws the chart.
- `init` creates the labels, the project and its fields that the config names, and leaves whatever already exists alone with a warning.
  With `--force` it brings them back to the config: labels get their color and description, options are set to the config's (an option with the same name keeps its id, so items keep their values), and a field of the wrong type is deleted with its values and created again.
  A project that `init` creates gets a new number; set it in the config.
- `audit` reports scopes without a pitch, items missing from the board, empty or contradictory statuses, cycles that differ from the pitch, and charts that no longer match the board. It exits with 1 when it finds something.

The CLI asks `gh` for the token and the repository; `GH_TOKEN` and `SHAPEUP_REPOSITORY` override them.
When `SHAPEUP_PROJECT_TOKEN` is set, the CLI uses it for the project and the other token for everything else.
It reads `.github/shapeup.json` from the nearest directory at or above the working directory,
so it runs from anywhere in the repository (override the path with `SHAPEUP_CONFIG`).

## State commands

A command changes only what differs from its result, and refuses without a comment when nothing differs.
A pitch or scope is finished when it is closed, or open with the Status Done or Dropped: the issue's state comes first, and the Status counts only while the issue is open.
It is done when it was closed as completed, or is open and Done; it was dropped when it was closed as anything else, or is open and Dropped.
A finished scope is never reopened: the work that follows it is a new scope, made with `scope new`.
A done scope that did not reach the top of the hill may still be moved to 100.
A scope is worked on only while its pitch is bet: `scope start` and `scope hill` refuse a scope without a pitch,
and one whose pitch is finished or is neither Bet nor In progress.
A pitch that is Bet goes In progress when the first of its scopes starts.
A scope the pitch can ship without is cut with `scope drop`, whatever the pitch's status: it is closed as not planned and set Dropped,
keeps its hill position and cycle, and leaves the chart, so `pitch done` no longer waits for it.

| Command | Refuses when |
| --- | --- |
| `pitch bet` | the pitch is finished, or it and its unfinished scopes are already on the cycle and past Shaped |
| `pitch unbet` | the pitch is finished, or it and its unfinished scopes are already Shaped with no cycle |
| `pitch break` | the pitch is done, or it and its scopes that are not done are already closed as not planned and Dropped |
| `pitch done` | the pitch was dropped, is already closed as completed and Done, or has an open scope |
| `scope start` | the scope is finished; it has no pitch, or its pitch is finished or neither Bet nor In progress; or the scope and its pitch are both already In progress |
| `scope hill` | the scope was dropped, or is done and the position is not 100; it has no pitch, or its pitch is finished or neither Bet nor In progress; or the scope is already at the position (empty counts as 0) |
| `scope done` | the scope was dropped, or is already closed as completed and Done |
| `scope drop` | the scope is done, or is already closed as anything but completed and Dropped |
| `scope new` | the pitch is finished |
| `pitch edit --appetite` | the pitch is not Shaped, or the appetite is the only change and the pitch already has it |

A finished scope keeps its state when its pitch is bet, unbet or broken, and a pitch that is bet keeps a status past Bet.

A command with several changes makes them in order and rolls nothing back.
When one fails after an earlier one was made, the command exits with 2, posts no comment and says what is left:

```
pitch bet #10 stopped after 2 of 5 changes. Nothing was rolled back, and the reason was not posted.
Made:
- set Cycle of #10 to Cycle 2
- set Status of #10 to Bet
Failed:
- set Cycle of #11 to Cycle 2: A GitHub Project GraphQL request failed. …
Not attempted:
- set Status of #11 to Bet
- set Cycle of #12 to Cycle 2
To finish, run the same command again: it makes only the changes still missing and then posts the reason. Or make them by hand and post the reason yourself.
If running it again says the result already holds, post the reason by hand.
```

Running the same command again finishes it, since it skips what already holds.
A change that failed in the CLI may still have landed on GitHub; then the second run finds nothing left to change, and the reason or report is posted by hand.
`init` also finishes when run again. If it created the project, first set `projectNumber` to the number it printed, when that differs, and run it with `--force`.
`pitch new` and `scope new` would make another issue, so they list the changes left to make by hand instead.

## Completion reports

`pitch done` and `scope done` post a completion report that follows a template of `## ` sections:

| Command | Sections, in order |
| --- | --- |
| `pitch done` | Outcome, Scopes, Accepted limits, Follow-ups |
| `scope done` | Outcome, Evidence, Follow-ups |

- The file given with `--report-file` has exactly these sections, in this order, and nothing but HTML comments before the first one.
- Every section has content besides HTML comments; where nothing applies, say so, as in `None.`
- Anything else stops the command before it changes anything, with a message that names the section.
- The report is posted as given: nothing is reordered, dropped or added.
- It is read only from a file, because a report with its `## ` lines does not fit one command-line argument in every shell.

```
## Outcome

The settings page saves every change as it is made.

## Evidence

- Pull request #42, merged with its tests passing.

## Follow-ups

None.
```

A repository changes the template in either of two ways:

- **Config.** `reports.pitch` and `reports.scope` in `.github/shapeup.json` set the sections, in order,
  such as `"scope": { "template": ".github/shapeup/scope-report.md", "sections": ["Outcome", "Verification", "Follow-ups"] }`.
  A report left out keeps its default.
- **Template file.** A file at the path in `template` becomes the template: its `## ` sections, in its order, are the report's.
  The paths are `.github/shapeup/pitch-report.md` and `.github/shapeup/scope-report.md` by default, next to the config;
  `template` can name another path, relative to the repository root.
  The file carries at least the sections the config names, may add more, and may hold HTML comments as guidance.
  Without that file, the config's sections are the template.

## Hill chart

The Action keeps this block at the top of each pitch body:

```
<!-- hill:start -->
![Hill chart](https://github.com/<owner>/<repo>/blob/generated/shapeup/hills/pitch-<number>.svg?raw=true&v=<commit>)
<!-- hill:values 11=30 12=60 -->
<!-- hill:end -->
```

- The second line records the values last drawn; the Action redraws a pitch only when its scopes or their positions no longer match it.
- A person's comment on a scope, and a scope opening, closing or reopening, wake the Action.
  Each run aligns the scope's pitch and every open pitch that has scopes, so a run cancelled in the queue loses nothing.
- Scopes closed as not planned leave the chart. Scopes at the same position share one badge, as in `1, 4, 7–9`.
- The SVG is committed to an orphan branch (default `generated/shapeup`, which must start with `generated/`).
  The branch holds only a README and the charts; the Action refuses any other branch and never force-pushes.
- The link is absolute because the Projects side panel resolves relative links against the project page.
  Viewers of a private repository need to be signed in.
- `workflow_dispatch` with an empty `pitch_number` redraws every open pitch that has scopes; with a number it redraws that pitch.

## Hill chart Action inputs

| Input | Default | Use |
| --- | --- | --- |
| `project-token` | none | Reads the project. Without it the Action only warns. |
| `github-token` | `${{ github.token }}` | Commits the SVG and updates pitch bodies (`contents: write`, `issues: write`). |
| `config` | `.github/shapeup.json` | Path of the config in the checked-out repository. |

## Board Action

`vulpes-facility/gh-shapeup/board@v1` runs one command of the cycle from a workflow, with the same checks and refusals as the CLI.
It is meant for a job that runs after automated work, such as an agent's:
that work never sees the project token, and hands over only values that the workflow passes in as inputs.
See [`examples/workflows/shapeup-board.yml`](examples/workflows/shapeup-board.yml).

| Command | Needs | Also takes |
| --- | --- | --- |
| `scope new` | `pitch`, `title`, `body` | |
| `scope edit` | `number`, `reason` | `title`, `body`; at least one of them |
| `scope start` | `number`, `reason` | |
| `scope hill` | `number`, `position`, `reason` | |
| `scope done` | `number`, `report` | |
| `pitch done` | `number`, `report` | |
| `bug new` | `title`, `body` | |

Shaping, betting, the circuit breaker, dropping a scope, cooldown work, bug edits and `init` are left to people on the CLI.

- `body` is Markdown split into `## ` sections, as with `--from`: its headings name the kind's sections in the config, and anything else in it is left out.
  `reason` is Markdown posted as it is, as with `--reason-file`, and `report` is a [completion report](#completion-reports), as with `--report-file`.
  A refusal from the CLI names those parameters.
- Every input is checked before the first call to GitHub, and no message repeats what an input holds.
  A blank input counts as not given; an input the command needs must be given, and one it does not take must not.
  `number` and `pitch` are issue numbers, `position` is an integer from 0 to 100, and `title` is one line of at most 256 characters.
  `reason` holds at most 4,000 characters, `body` and `report` at most 65,536, and none holds a control character other than tab and newline.
- A command whose result already holds changes nothing and posts nothing, as in the CLI, but ends with a notice instead of failing and sets `result` to `unchanged`.
  A workflow that returns to an earlier station can then run the same step again.
  Every other refusal fails the step before the first change.
- A command that stops part-way fails with the CLI's message.
  Running a state command again finishes it; running `scope new` or `bug new` again would create another issue.
- After `scope new`, `scope hill` and `scope done`, the step aligns the chart of the scope's pitch, even when the result already held,
  since a bot's comment does not wake the hill chart workflow.
  When the chart cannot be drawn, the step warns and still succeeds; run the hill chart workflow by hand with the pitch number.
- The step logs no token, no API response and none of the Markdown inputs.

### Tokens

The config's `projectOwnerType` says whether a user or an organization owns the project; the step does not guess it from the token.

- `project-token` changes the project. It also reads the repository's issues, since an issue's project fields are read from the issue.
  For a user's project it is a classic token with `project` and `repo`.
  For an organization's project it is a GitHub App installation token with `organization_projects: write` and `issues: read` on the repository,
  or a personal access token that can do the same.
  `bug new` does not need it.
- `github-token` creates, closes and comments on issues, commits the chart and updates the pitch body, so it needs `issues: write` and `contents: write`.
  The comments are posted as its owner: `github-actions[bot]` by default, or your App with the App's token.
- When the automated work runs as the same App, give its job a token without `organization_projects`,
  for instance with the `permission-*` inputs of `actions/create-github-app-token`; an installation token otherwise carries every permission of the App.

### Workflow

- Name the command and the issue in the workflow, and take only the values from the work before it, through `with:`.
  Never put `${{ }}` inside a `run:` script.
- Check out the config and the templates from the default branch, never from a branch the work wrote.
- End a multi-line output with a delimiter the work cannot guess, so its text cannot set another output.
- Keep the board job out of the hill chart workflow's concurrency group: a pending job is cancelled when another joins its group,
  and a cancelled board job loses its change.

### Board Action inputs and outputs

| Input | Default | Use |
| --- | --- | --- |
| `command` | none | One of the commands above. |
| `number` | none | The issue the command changes. |
| `pitch` | none | The pitch of a new scope. |
| `title` | none | The title; the template's prefix is added once. |
| `body` | none | The sections, as with `--from`. |
| `position` | none | The hill position, from 0 to 100. |
| `reason` | none | The reason, as with `--reason-file`. |
| `report` | none | The completion report, as with `--report-file`. |
| `project-token` | none | Changes the project; see [Tokens](#tokens). |
| `github-token` | `${{ github.token }}` | Creates, closes and comments on issues, commits the chart and updates pitch bodies (`issues: write`, `contents: write`). |
| `config` | `.github/shapeup.json` | Path of the config in the checked-out repository. |

| Output | Value |
| --- | --- |
| `result` | `changed`, or `unchanged` when the result already held |
| `number` | The issue the command changed, or the one `scope new` or `bug new` created |

## Claude Code plugin

The plugin in [`plugins/gh-shapeup`](plugins/gh-shapeup) gives Claude Code a skill that turns a request,
such as "bet #10 on Cycle 2" or "scope #11 is over the hill", into the `gh shapeup` command that makes it.
It asks for a reason when you gave none, writes sections and completion reports to files that follow your templates,
asks before `pitch break`, `scope drop` and `init --force`, and runs `audit` at the end.
It comes from the [vulpes-facility marketplace](https://github.com/vulpes-facility/claude-plugins), at the CLI's version,
and the tests check that it names every command the CLI takes and no other.

## Development

```
node --test "test/*.test.mjs"
node test/render-fixtures.mjs | python3 test/validate-svg.py
sh script/build.sh
```

There are no dependencies. The code runs on Node 24 or later, and `script/build.sh` compiles it with Bun
into one binary per platform in `dist/`, named as `gh` expects.
Pushing a `v*.*.*` tag runs every binary on its own platform and releases them under the tag.

## License

[MIT](LICENSE)
