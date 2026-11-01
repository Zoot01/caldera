# Changesets

Each change that users will notice gets a note here: `pnpm changeset`, pick the packages, and write a sentence about it. Every Caldera package shares one version, so they're released together.

To release: `pnpm changeset version` bumps the versions and writes each package's CHANGELOG.md; review it, commit, then `pnpm release` builds and publishes.
