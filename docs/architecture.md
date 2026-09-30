# Architecture

One `src/` backs three products:\
the `gh shapeup` CLI, the hill chart Action and the board Action.\
`README.md` is the user-facing specification of every command, refusal and input;\
read it before changing behavior.

## Entry points

- **CLI**: `bin/shapeup.mjs` calls `main` in `src/cli.mjs`,\
  which finds the config, asks `gh` for the token and repository,\
  and runs `Cli.run`.
- **Hill chart Action**: `action.yml` runs `src/action.mjs`,\
  which hands the `issue_comment`, `issues` or `workflow_dispatch` event to `HillService`.
- **Board Action**: `board/action.yml` runs `board/main.mjs`,\
  which calls `main` in `src/board-action.mjs`.\
  It does not reimplement commands.\
  It validates the inputs, turns them into CLI arguments with `cliArgs`,\
  and runs the same `Cli`,\
  whose file reads `markdownReader` answers from the `body`, `reason` and `report` inputs.\
  It then calls `HillService.redraw` itself,\
  because a comment posted by a bot does not wake the hill chart workflow.

## Layers

- `GitHub` is the only transport.\
  It holds two tokens:\
  `request(..., { project: true })` uses the project token,\
  so every GraphQL call does;\
  REST calls use the repository token.
- `Board` reads and changes the GitHub Project (Projects v2).\
  `load()` MUST run before any option, iteration or mutation lookup,\
  since it resolves the field and option ids.\
  Issues and their field values are read from the issue side,\
  because the board's item listing lags behind.
- `HillService` and `GeneratedStore` draw the hill chart.\
  The service reads scopes as REST sub-issues and their positions through GraphQL,\
  renders the SVG with `renderHill`, commits it through `GeneratedStore`,\
  and rewrites the block between `<!-- hill:start -->` and `<!-- hill:end -->` in the pitch body.\
  The `<!-- hill:values ... -->` line records what was last drawn;\
  a pitch is redrawn only when its scopes no longer match it.
- `GeneratedStore` writes an orphan branch through the Git Data API.\
  The branch MUST start with `generated/`.\
  It refuses a branch holding any file other than its README and `hills/pitch-<n>.svg`,\
  and it never force-pushes.

## Rules every CLI command follows

- Every check that can refuse the command comes before its first change.\
  A status the command will set is looked up first with `requireStatus`.
- A command computes only the changes that differ from its result, as a list of `steps`,\
  and runs them through `Cli.apply`.\
  `apply` rolls nothing back.\
  A failure after the first step throws `ShapeUpError('partial')`,\
  listing what was made, what failed and what was not attempted.
- When no step differs,\
  a state command MUST throw with the code `holds` (the `holds` helper).\
  The board Action turns that code alone into a notice with `result=unchanged`;\
  any other refusal fails the step.
- A `new` command runs `apply` with `rerun: false`,\
  because running it again would create another issue;\
  its partial failure lists the changes left to make by hand instead.
- The reason or completion report is read and checked before any change,\
  and `explain` posts it last, as one comment.\
  A comment on a scope is also what wakes the hill chart Action.

## Errors and logging

- Throw `ShapeUpError(code, message)` for anything a user should read.\
  Entry points print only a `ShapeUpError`'s message,\
  and a generic internal error for anything else.
- `GitHub` replaces HTTP, GraphQL and network failures with its own messages,\
  so no API response reaches the output.
- The Actions MUST NOT log tokens, API response bodies, event contents or the Markdown inputs.
- The CLI exits with 0, with 1 when `audit` finds something, and with 2 on any error.\
  The Actions fail with 1.
