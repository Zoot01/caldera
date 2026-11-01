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
| `packages/create-caldera` | the scaffolder; apps are copied in layers: `template/` (shared base), then `kits/<kit>/` (Inertia: `blank`, then `starter`, then `starter-teams` with `--teams`; `*-postgres` layers hold their Postgres schema) or `template-next/`, with `databases/postgres/` underneath. Kits change earlier layers' files through checked `edit()`s in `create.ts`. A layer's `package.json` is merged. coss ui components in the kits come from `pnpm sync:coss` (`scripts/sync-coss.mjs`): change the kit's `USES` list there, not the files by hand |
| `apps/docs` | the docs site (Next.js + Fumadocs, Caldera's brand): pages are MDX in `content/docs/`, ordered by `meta.json`. `pnpm docs` runs it on :3200. Code in the docs is code that ran: build examples in a sandbox app first |

## Commands

- `pnpm test`: build every package, then run all tests.
- `pnpm docs`: the docs site, live, on http://localhost:3200 (`pnpm --filter @caldera-js/docs build` checks every page compiles).
- `pnpm typecheck`: build, then type-check every package (tests included).
- `pnpm test:e2e`: creates a real app from the template (`--link`, installs `@caldera-js/*` from `pnpm pack` tarballs, like npm would), then type-checks, tests, runs the app's own browser tests (Playwright, `pnpm test:browser`), `pnpm dev` with Vite and a production build, across Starter/Blank, teams and SQLite/Postgres. Slow; run it before committing template changes.
- One package: `pnpm vitest run packages/<name>`. Packages import each other through `dist/`, so rebuild a dependency (`pnpm -s build` in it) after changing it.

## Tests against real backends

- **Redis:** cache, rate limiting, BullMQ and `caldera queue:work` tests start a throwaway `redis-server` on a free port (`test/redis-server.ts`). They're skipped when `redis-server` isn't installed (`brew install redis`). Don't mock Redis.
- **Postgres:** PGlite in-process for most tests; the database queue tests start a real Postgres cluster (`initdb` + `pg_ctl`, `test/postgres-server.ts`) to prove concurrent claiming, skipped without `brew install postgresql`. **SQLite:** libsql and `node:sqlite`.
- **S3:** the storage tests start SeaweedFS's S3 gateway in Docker (`chrislusf/seaweedfs`, `test/s3-server.ts`) with SigV4 enforced; MinIO no longer publishes free images. Its config is copied into the container (`docker cp`), since Docker Desktop doesn't share macOS temp folders. Skipped without Docker. **R2** is tested on Miniflare.
- **SMTP:** the mail tests send through Mailpit in Docker (`axllent/mailpit`, `test/mailpit.ts`) and read messages back from its API. Resend, Postmark and SES are checked against their documented request formats (no local servers exist), with SES signatures re-computed.
- **Browsers:** pages are checked in a real browser with the gstack `/browse` skill against an app created in the sandbox below.

## Sandbox for created apps: `~/Documents/testing-caldera`

Use this folder (not `/tmp`, not this repo) whenever a test needs a real app outside the monorepo: scaffolding with `create-caldera`, manual `pnpm install`/`pnpm dev`, browser checks, or anything pnpm behaves differently for inside a workspace. It's disposable: one subfolder per app, deleted or overwritten freely.

```sh
pnpm build
cd ~/Documents/testing-caldera
node ~/Documents/Github/caldera/packages/create-caldera/bin/create-caldera.js <name> --pm pnpm --link ~/Documents/Github/caldera --no-git
```

`--link` installs packed copies of the packages (`.caldera-local/*.tgz`) as they were at create time: a later `pnpm build` doesn't reach an existing app. Create a fresh app, or for a quick retry copy a package's `dist/` over the app's installed copy (`cp -R packages/cli/dist/. "$(readlink -f <app>/node_modules/@caldera-js/cli)/dist/"`).

`--link` packs the local packages, so rebuild (`pnpm build`) and re-create the app after changing a package. Stop any dev servers you start there (ports 3000+ and Vite's 5173).

## Known issues

- `packages/cli/test/dev.test.ts` is flaky in full parallel runs only (DESIGN.md §13 has what's ruled out and the planned fix). A lone failure of that test in `pnpm test` isn't a regression; anything else is.
- pnpm 11 fails installs on build scripts nobody decided on. Approve or decline new ones in `pnpm-workspace.yaml` (`allowBuilds`) with a comment saying why; the template's own `pnpm-workspace.yaml` needs the same for anything it installs.

## Conventions

- Every `define*` returns plain data with a `kind`, so the CLI, codegen and AGENTS.md generation can find it.
- Optional backends (ioredis, bullmq, aws4fetch, nodemailer…) live in their own entry points (`@caldera-js/queue/bullmq`, `@caldera-js/storage/s3`, `@caldera-js/mail/smtp`) and are passed as `drivers: [...]`, so edge bundles never see them.
- The CLI loads a project with tsx (`openProject()`), in its own module graph: the project's packages are separate copies from the CLI's. Process-wide state goes on `globalThis` (`Symbol.for(...)`), errors are recognised by shape, and anything that must share the app's instances is loaded through `project.importPackage()`.
- Packages don't depend on each other just to recognise errors or objects: match a `code`, a `kind`, or a `Symbol.for(...)` on `globalThis`.
- Template and kit code (routes, middleware, models) never imports `src/app.ts`: `caldera generate` loads those files before the generated files `app.ts` imports exist, so a fresh app or clone couldn't generate. Services and the resolved config are on `c.var` (`c.var.config.auth`).
- Commit per feature, with a message that says what changed and why.
