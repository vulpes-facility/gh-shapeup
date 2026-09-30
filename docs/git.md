# Git and releases

## GitHub Flow

- The repository follows GitHub Flow.\
  `main` MUST stay releasable,\
  and nothing is committed to it directly.
- Every change MUST start on a branch from the latest `main`,\
  named after its commit type, such as `feat/…`, `fix/…`, `docs/…` or `chore/…`.\
  The branch is pushed and lands on `main` through a pull request,\
  merged with a merge commit.\
  The pull request SHOULD pass the `test` workflow before it is merged.
- Commits follow Conventional Commits:\
  `feat`, `fix`, `docs`, `test`, `refactor` or `chore`, and `feat!` for a breaking change.

## Releases

- A release goes through the same flow.\
  A `chore/release-X.Y.Z` branch holds a `chore: release X.Y.Z` commit\
  that bumps `package.json` and `plugins/gh-shapeup/.claude-plugin/plugin.json`.\
  Once it is merged, the `vX.Y.Z` tag is pushed on the merge commit on `main`.
- The tag runs `.github/workflows/release.yml`,\
  which builds every binary, runs each on its own platform and publishes them.
- The `v1` tag points at the latest release.\
  `@v1` in the Action references and the `$schema` URL in configs resolve through it,\
  and the release workflow does not move it.
