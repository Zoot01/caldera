# Caldera (framework monorepo)

A Laravel-inspired TypeScript framework: Hono, Drizzle 1.0, Zod, Better Auth, Inertia (React + Vite), BullMQ. The design and build order live in `~/Documents/Github/laravel-research/DESIGN.md`, which is the source of truth: read §12 (build order and status) and §13 (open questions) before starting work, and update them when you finish something.

## Layout

| Package | What |
| --- | --- |
| `packages/core` | env, config, providers, app lifecycle, the generic driver manager, durations |
| `packages/http` | routes, requests, middleware priority, errors, CSRF/security headers, sessions, redirects |
| `packages/db` | `defineModel`, transactions, factories, seeders, test databases |
| `packages/auth` | policies and the gate, Better Auth integration |
| `packages/inertia` | the Inertia v3 server adapter, Vite asset tags and plugin |
| `packages/cache` | cache stores, locks, tags, rate limiting |
| `packages/queue` | jobs, dispatch, drivers, the worker runtime |
| `packages/cli` | `caldera` commands: generate, dev, make:*, db:*, queue:work… |
| `packages/create-caldera` | the scaffolder and its bundled `template/` |

## Commands

- `pnpm test`: build every package, then run all tests.
- `pnpm typecheck`: build, then type-check every package (tests included).
- `pnpm test:e2e`: creates a real app from the template (`--link`, installs `@caldera/*` from `pnpm pack` tarballs, like npm would), then type-checks, tests, runs `pnpm dev` with Vite and a production build. Slow; run it before committing template changes.
- One package: `pnpm vitest run packages/<name>`. Packages import each other through `dist/`, so rebuild a dependency (`pnpm -s build` in it) after changing it.

## Tests against real backends

- **Redis:** cache, rate limiting, BullMQ and `caldera queue:work` tests start a throwaway `redis-server` on a free port (`test/redis-server.ts`). They're skipped when `redis-server` isn't installed (`brew install redis`). Don't mock Redis.
- **Postgres:** PGlite, in-process. **SQLite:** libsql and `node:sqlite`.
- **Browsers:** pages are checked in a real browser with the gstack `/browse` skill against an app created in the sandbox below.

## Sandbox for created apps: `~/Documents/testing-caldera`

Use this folder (not `/tmp`, not this repo) whenever a test needs a real app outside the monorepo: scaffolding with `create-caldera`, manual `pnpm install`/`pnpm dev`, browser checks, or anything pnpm behaves differently for inside a workspace. It's disposable: one subfolder per app, deleted or overwritten freely.

```sh
pnpm build
cd ~/Documents/testing-caldera
node ~/Documents/Github/caldera/packages/create-caldera/bin/create-caldera.js <name> --pm pnpm --link ~/Documents/Github/caldera --no-git
```

`--link` packs the local packages, so rebuild (`pnpm build`) and re-create the app after changing a package. Stop any dev servers you start there (ports 3000+ and Vite's 5173).

## Known issues

- `packages/cli/test/dev.test.ts` is flaky in full parallel runs only (DESIGN.md §13 has what's ruled out and the planned fix). A lone failure of that test in `pnpm test` isn't a regression; anything else is.
- pnpm 11 fails installs on build scripts nobody decided on. Approve or decline new ones in `pnpm-workspace.yaml` (`allowBuilds`) with a comment saying why; the template's own `pnpm-workspace.yaml` needs the same for anything it installs.

## Conventions

- Every `define*` returns plain data with a `kind`, so the CLI, codegen and AGENTS.md generation can find it.
- Optional backends (ioredis, bullmq…) are optional peer dependencies, imported on first use.
- Packages don't depend on each other just to recognise errors or objects: match a `code`, a `kind`, or a `Symbol.for(...)` on `globalThis`.
- Commit per feature, with a message that says what changed and why.
