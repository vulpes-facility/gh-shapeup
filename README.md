# gh-shapeup

Run [Shape Up](https://basecamp.com/shapeup) on GitHub Issues and Projects.

- A **CLI** that creates and edits pitches, scopes, cooldowns and bugs from your issue templates,
  bets pitches on cycles, moves scopes on the hill, comments on every issue it changes with the reason or a completion report,
  and audits the board for drift.
  It installs as the gh extension `gh shapeup`.
- A **GitHub Action** that draws each pitch's hill chart as an SVG and keeps it at the top of the pitch body.

Both read one config file that names your project, its fields and your templates.
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
   The pitch template also carries the hill markers the Action writes between.
4. **Config.** Copy [`examples/shapeup.json`](examples/shapeup.json) to `.github/shapeup.json` and set your project.
   Its `$schema` line gives editors a description of every key; see [`config.schema.json`](config.schema.json).
5. **Token.** Add a repository secret `SHAPEUP_PROJECT_TOKEN` that can read the project.
   For a user-owned project use a classic token with `read:project` and `repo`.
6. **Workflow.** Copy [`examples/workflows/shapeup-hill.yml`](examples/workflows/shapeup-hill.yml) to `.github/workflows/`.
7. **CLI.** Run `gh extension install vulpes33/gh-shapeup`.
   It is one binary for macOS, Linux or Windows that needs nothing but `gh`, and it uses your `gh` login.
   `gh extension upgrade shapeup` updates it.

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
gh shapeup cooldown new --title T --what … [--why …] --done …
gh shapeup cooldown edit <number> [--title T] [section parameters] --reason …
gh shapeup bug new --title T --symptom … --steps … --expected … [--environment …]
gh shapeup bug edit <number> [--title T] [section parameters] --reason …
gh shapeup audit [--pitch <number>]
gh shapeup init [--force]
```

- Section parameters are set per kind in the config's `kinds`; the ones above are the defaults.
  `title`, `from`, `footnote`, `reason`, `reason-file`, `report` and `report-file` are the CLI's own and cannot name a section.
- Every `new` and `edit` also takes `--from <file>` (Markdown split into `## ` sections) and repeated `--footnote name=description`.
- A command refuses any option it does not read, and an `edit` refuses when it names nothing to change, before it calls GitHub.
- Every command that changes an existing issue leaves a comment on it.
  `pitch done` and `scope done` need a [completion report](#completion-reports) from `--report-file <file>`.
  Every other one needs a reason: `--reason <text>`, or `--reason-file <file>` with Markdown that is posted as it is.
  Without one, with both, or with an empty one, the command changes nothing and exits with 2.
- The command makes its change first and then posts the reason or the report as one comment on the issue it names, with nothing added.
  `pitch bet`, `unbet` and `break` also change the pitch's scopes, but comment only on the pitch.
  Every check that can refuse the command comes before its first change.
  A failed change posts nothing; a comment that fails after the change is reported, and the command exits with 2.
- A comment on a scope wakes the Action, so the comment of every `scope` command wakes it; after `scope hill` that is what redraws the chart.
- `init` creates the labels, the project and its fields that the config names, and leaves whatever already exists alone with a warning.
  With `--force` it brings them back to the config: labels get their color and description, options are set to the config's (an option with the same name keeps its id, so items keep their values), and a field of the wrong type is deleted with its values and created again.
  A project that `init` creates gets a new number; set it in the config.
- `audit` reports scopes without a pitch, items missing from the board, empty or contradictory statuses, cycles that differ from the pitch, and charts that no longer match the board. It exits with 1 when it finds something.

The CLI asks `gh` for the token and the repository; `GH_TOKEN` and `SHAPEUP_REPOSITORY` override them.
It reads `.github/shapeup.json` from the nearest directory at or above the working directory,
so it runs from anywhere in the repository (override the path with `SHAPEUP_CONFIG`).

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

## Action inputs

| Input | Default | Use |
| --- | --- | --- |
| `project-token` | none | Reads the project. Without it the Action only warns. |
| `github-token` | `${{ github.token }}` | Commits the SVG and updates pitch bodies (`contents: write`, `issues: write`). |
| `config` | `.github/shapeup.json` | Path of the config in the checked-out repository. |

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
