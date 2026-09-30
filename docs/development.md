# Development

## Commands

```sh
node --test "test/*.test.mjs"                                          # every unit test (the same as npm test)
node --test --test-name-pattern="<test name regex>" test/cli.test.mjs  # one test
node test/render-fixtures.mjs | python3 test/validate-svg.py           # parse the rendered SVGs with a real XML parser
sh script/build.sh                                                     # one gh extension binary per platform into dist/ (needs Bun; CI pins 1.4.2)
```

- Tests MUST run from the repository root,\
  because several of them read `examples/`, `package.json` or `plugins/` by relative path.
- `node bin/shapeup.mjs help` runs the CLI from source.\
  A real command also needs `GH_TOKEN`, `SHAPEUP_REPOSITORY` and `SHAPEUP_CONFIG`,\
  since this repository has no `.github/shapeup.json` of its own.

## Constraints

- There is no install step, no dependency and no linter.
- `src/` MUST stay free of dependencies and run on plain Node 24 or later.\
  Both Actions run `src/` straight from the tagged checkout under `node24`,\
  with no bundle and no install;\
  Bun only compiles the CLI into the extension binaries.
- Files use LF line endings (`.gitattributes`).

## Tests

- Every class takes its collaborators as arguments:\
  `Cli` takes `api`, `board`, the template and text readers and `out`;\
  `GitHub` takes `fetchImpl`;\
  `HillService` takes a store and a renderer.\
  Tests pass fakes,\
  and the tests of the entry points' `main` stub `globalThis.fetch`,\
  so nothing reaches GitHub.
- The CLI and board Action tests share the fake repository and board in `test/cli-fixture.mjs`.

## Keeping files in sync

- `plugins/gh-shapeup/.claude-plugin/plugin.json` MUST carry the version in `package.json` (tested).
- `plugins/gh-shapeup/skills/shapeup/SKILL.md` MUST name exactly the commands in `usage` in `src/cli.mjs` (tested).
- A new or changed CLI command also touches `usage`, `Cli.reads`, `needsReason` or `needsReport` in `src/cli.mjs`, the README and `SKILL.md`.
- A command the board Action runs is listed in `commands` in `src/board-action.mjs`, in the `command` input of `board/action.yml` and in the README's board table.
- A config key lives in `defaults` in `src/config.mjs`, in `config.schema.json` and in the README.\
  A CLI parameter name also goes into `reserved`,\
  so that no section can take it.
