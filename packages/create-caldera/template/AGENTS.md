# {{ name }}

A [Caldera](https://caldera.dev) app: TypeScript, Hono, Drizzle, Zod, and React pages over Inertia (Vite).

Pages get their data from the route that renders them: no API layer. A page's props are its component's props, so changing them makes every `c.render` call that passes the wrong data fail `pnpm typecheck`. Shared props (from `src/inertia.ts`) are on `usePage().props` and typed too. Validation errors come back as `props.errors`; `back(c).with('success', '…')` shows up as `usePage().flash`.

## Where things go

| What | Where | Generator |
| --- | --- | --- |
| Environment variables (Zod) | `src/env.ts` | |
| Config (the only place env is read) | `src/config/*.ts` | `caldera make:config <name>` |
| Tables | `src/db/schema.ts`, `src/db/tables/*.ts` | `caldera make:model <Name>` |
| Relations (register every table here) | `src/db/relations.ts` | |
| Models | `src/models/*.ts` | `caldera make:model <Name>` |
| Policies | `src/policies/*.ts` | `caldera make:policy <Name>` |
| Routes | `src/routes/*.ts` | `caldera make:routes <name>` |
| Pages (React, rendered with `c.render('Posts/Index', props)`) | `resources/pages/**/*.tsx` | `caldera make:page <Path/Name>` |
| Shared page props, asset tags, HTML shell | `src/inertia.ts` | |
| Frontend entry and CSS (Vite) | `resources/app.tsx`, `resources/app.css` | |
| Providers | `src/providers/*.ts` (add to `src/app.ts`) | `caldera make:provider <name>` |
| Queued jobs (`dispatch(Job, payload)` from `@caldera/queue`) | `src/jobs/*.ts` | `caldera make:job <Name>` |
| Events (`emit(Event, payload)` from `@caldera/events`) | `src/events/*.ts` | `caldera make:event <Name>` |
| Listeners (in process, or a job: `listen(Event, Job.fromEvent(map))`) | `src/listeners/*.ts` | `caldera make:listener <Name> --event <Event>` |
| Schedules (cron, each dispatches a job) | `src/schedules/*.ts` | `caldera make:schedule <Name> --job <Job>` |
| Direct upload kinds (`useUpload('avatar')` in pages) | `src/uploads.ts` | |
| Disks (local, public, s3) | `src/config/storage.ts` | |
| Mail (React Email + `defineMail`) | `src/mail/*.tsx` | `caldera make:mail <Name>` |
| Mailers (log, resend, postmark, ses, smtp) | `src/config/mail.ts` | |
| Notifications (mail, database and custom channels) | `src/notifications/*.ts` | `caldera make:notification <Name>` |
| Translations (ICU messages; `lang/en` is canonical) | `lang/<locale>/*.json` | |
| Factories / seeders | `src/db/factories/`, `src/db/seeders/` | `caldera make:factory`, `caldera make:seeder` |
| Migrations (committed; applied by `caldera db:migrate`, and by tests) | `drizzle/` | `caldera db:generate` |

Jobs run as soon as they're dispatched while `QUEUE_CONNECTION=sync` (the default). In production set `QUEUE_CONNECTION=database` (jobs in the `caldera_jobs` table, `src/db/tables/caldera-jobs.ts`) or `redis` (BullMQ, with `REDIS_URL`; the cache moves to Redis too), and run `pnpm worker` (`caldera queue:work`). Failed database jobs: `caldera queue:failed`, `queue:retry <id>|--all`, `queue:forget`. In tests, `app.services.queue.fake()` captures dispatched jobs for assertions.

Schedules run from `pnpm scheduler` (`caldera schedule:work`) on a server, or `* * * * * caldera schedule:run` in a crontab. On Cloudflare, export `scheduled: (controller, env) => handleScheduled(app, controller, env)`; on Vercel, set `CRON_SECRET`. `caldera schedule:sync --target cloudflare|vercel` writes the platform's cron config. `caldera schedule:list` shows next runs.

Files: `c.var.storage` is the default disk (`storage/app` here, S3 once `S3_BUCKET` is set); `storage.disk('public')` is served at `/storage`. Validate uploaded files with `zfile({ maxSize, mimes })` in `defineRequest` (it checks the bytes, not the client's type). For big files, or on Vercel (4.5MB request limit), upload straight to the bucket: define a kind in `src/uploads.ts` and use `useUpload()`. Store the result in a `zjson(fileRef)` column; `cleanupFiles('column')` in the model's hooks deletes replaced files. S3 buckets need CORS allowing PUT from your site for direct uploads.

Mail: `await mail.to(user).send(WelcomeEmail, props)` sends now; `.queue(...)` queues it (it renders in the worker). Nothing is queued implicitly. `MAIL_MAILER=log` (the default) prints a line and keeps an outbox at `/_caldera/mail/outbox`; `/_caldera/mail` previews every mail with its `PreviewProps`. In tests, `app.services.mail.fake()` records mail for `assertSent`/`assertQueued`.

Notifications: `await notify(user, Welcome, payload)` (from `@caldera/notifications`) sends one notification over each of its `channels`; `via()` picks channels per user. With `queue: true` each channel is its own job (a failed email retries alone), queued after the transaction commits. The `database` channel stores rows in `caldera_notifications` (`src/db/tables/caldera-notifications.ts`); read them with `inbox(user).list({ unread: true })`, `.unreadCount()`, `.markRead(ids)`. Inbox calls are scoped to that user, so ids from a request can't touch anyone else's. Send to an address without a user via `notify(route({ mail: 'ops@example.com' }), ...)`. Custom channels (Slack, SMS): `defineChannel`, passed in `channels` in `src/app.ts`. In tests, `app.services.notifications.fake()` records sends for `assertSentTo`.

Translations: messages are ICU (`{count, plural, one {# post} other {# posts}}`) in `lang/<locale>/<namespace>.json`, keyed `namespace.key`. On the server, `c.var.i18n.t('posts.count', { count })`; outside a request, `translator('fr').t(...)` from `@caldera/i18n`. Keys and parameters are typed from `lang/en`, so a wrong key or a missing parameter fails `pnpm typecheck`. A page lists what it needs with `export const messages = ['posts.*']` (a literal array) and reads it with `const { t, rich } = useT()` from `@caldera/i18n/react`; only those messages ship to the browser. The locale comes from the user's `locale`, then the `caldera_locale` cookie (`c.var.i18n.setLocale('fr')`), then `Accept-Language`. Validation errors and error messages are translated (`validation.*`, `errors.*`; built in for en, fr, es, de; override any key in `lang/<locale>/validation.json`, name fields in `validation.attributes`). `caldera i18n:missing` lists missing, extra, unused and mismatched messages; `caldera check` fails when a translation takes different parameters.

Cloudflare Workers: `caldera cloudflare:setup` adds `wrangler.json` and `src/worker.ts` (HTTP, Cloudflare Queues consumer, Cron Triggers). The app needs no changes: with the Workers bindings present, the config uses D1 (`DB`) for the database, the `database` cache store (`caldera_cache`, for locks and rate limits), R2 (`FILES`) for files, Cloudflare Queues (`QUEUE`) and Cloudflare Email Service (`EMAIL`). D1 migrations: `caldera db:generate`, `caldera d1:migrations`, then `wrangler d1 migrations apply DB --local|--remote`. Node-only pieces (SMTP, BullMQ/Redis, the local disk, the database queue's worker) don't run there.

Tests (`pnpm test`, Vitest): `const t = setupApp(app)` from `@caldera/testing` at the top of a test file boots the app with a fresh database built from your migrations (`drizzle/`), rolls each test back, and shuts down after. `t.client(http)` sends requests in-process with cookies (`.get`, `.post(path, { json | form })`, `.visit(path)` for Inertia, `await .actingAs(user)` with Better Auth); responses assert: `.assertOk()`, `.assertJson({...})`, `.assertRedirect('/x')`, `.assertInertia('Posts/Index', { posts })`, `await .assertValidationErrors(['title'])` (JSON or a form redirected back). `t.fake('mail' | 'queue' | 'events' | 'notifications' | 'storage')` fakes a service for one test. Code under test must use models or `db.current()` (not `db.client`) so it joins the test's transaction. Schema change: `caldera db:generate` makes the migration tests (and production, `caldera db:migrate`) use. Postgres apps set `DATABASE_TEST_URL` (its name must contain "test").

Vercel: `caldera vercel:setup` adds `vercel.json` (your build, `public/` on the CDN, everything else rewritten to the app) and `api/index.ts` (the app as a Node.js function, with Vercel's `waitUntil`); add `@vercel/functions`. In the Vercel project set a hosted `DATABASE_URL` (Turso or Postgres), `QUEUE_CONNECTION=deferred`, `S3_*` for files and a mailer; `vercel pull --environment=production` then `caldera check` reports what wouldn't work there. Schedules: `caldera schedule:sync --target vercel`.

Security headers are on by default in `src/http.ts`, including a strict CSP: only scripts with this request's nonce run (and what they load). Page and Vite tags get the nonce automatically; any inline `<script>` you add in a custom `rootView` needs `nonce="${nonce}"`. Don't loosen `script-src`; add other directives with `securityHeaders({ csp: { imgSrc: [...] } })`.

`.caldera/` is generated: never edit it. Run `caldera generate` after adding env, config, routes, models, policies or pages (`caldera dev` does it on save).

## MCP server

`.mcp.json` registers `caldera mcp` (stdio), so Claude Code and other MCP clients get these tools in this project:

- **Read the app:** `describe`, `routes`, `db_schema`, `model`, `abilities`, `schedules`, `mail_list`, `i18n_missing`, `check`.
- **Debug:**
  - `last_errors` (500s from `caldera dev`, with stacks pointing at your `.ts` lines) and `logs` (the dev server's output)
  - `route_call` (a request to the app in-process; add `x-inertia: true` for a page's props as JSON)
  - `db_query` (one SQL statement, always rolled back and read-only)
  - `mail_render`
- **Change things:** `generate`, and `make` (a dry run showing the files it would write).

Writes are off by default. Add `"--allow-writes"` to the args to allow non-GET `route_call`, `make` with `write: true`, and `db_seed`.

## Commands agents should use

- `caldera describe --json`: env schema, config (secrets redacted), providers and services
- `caldera route:list --json`, `caldera model:show <name> --json`, `caldera db:schema --json`, `caldera abilities --json`
- `caldera generate --check`: fails if generated types are stale
- `pnpm typecheck`, `pnpm test`

<!-- caldera:generated:start -->
<!-- caldera:generated:end -->
