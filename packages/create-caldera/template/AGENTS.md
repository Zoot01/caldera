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
| Factories / seeders | `src/db/factories/`, `src/db/seeders/` | `caldera make:factory`, `caldera make:seeder` |

Jobs run as soon as they're dispatched while `QUEUE_CONNECTION=sync` (the default). In production set `QUEUE_CONNECTION=database` (jobs in the `caldera_jobs` table, `src/db/tables/caldera-jobs.ts`) or `redis` (BullMQ, with `REDIS_URL`; the cache moves to Redis too), and run `pnpm worker` (`caldera queue:work`). Failed database jobs: `caldera queue:failed`, `queue:retry <id>|--all`, `queue:forget`. In tests, `app.services.queue.fake()` captures dispatched jobs for assertions.

Schedules run from `pnpm scheduler` (`caldera schedule:work`) on a server, or `* * * * * caldera schedule:run` in a crontab. On Cloudflare, export `scheduled: (controller, env) => handleScheduled(app, controller, env)`; on Vercel, set `CRON_SECRET`. `caldera schedule:sync --target cloudflare|vercel` writes the platform's cron config. `caldera schedule:list` shows next runs.

Files: `c.var.storage` is the default disk (`storage/app` here, S3 once `S3_BUCKET` is set); `storage.disk('public')` is served at `/storage`. Validate uploaded files with `zfile({ maxSize, mimes })` in `defineRequest` (it checks the bytes, not the client's type). For big files, or on Vercel (4.5MB request limit), upload straight to the bucket: define a kind in `src/uploads.ts` and use `useUpload()`. Store the result in a `zjson(fileRef)` column; `cleanupFiles('column')` in the model's hooks deletes replaced files. S3 buckets need CORS allowing PUT from your site for direct uploads.

Mail: `await mail.to(user).send(WelcomeEmail, props)` sends now; `.queue(...)` queues it (it renders in the worker). Nothing is queued implicitly. `MAIL_MAILER=log` (the default) prints a line and keeps an outbox at `/_caldera/mail/outbox`; `/_caldera/mail` previews every mail with its `PreviewProps`. In tests, `app.services.mail.fake()` records mail for `assertSent`/`assertQueued`.

Notifications: `await notify(user, Welcome, payload)` (from `@caldera/notifications`) sends one notification over each of its `channels`; `via()` picks channels per user. With `queue: true` each channel is its own job (a failed email retries alone), queued after the transaction commits. The `database` channel stores rows in `caldera_notifications` (`src/db/tables/caldera-notifications.ts`); read them with `inbox(user).list({ unread: true })`, `.unreadCount()`, `.markRead(ids)`. Inbox calls are scoped to that user, so ids from a request can't touch anyone else's. Send to an address without a user via `notify(route({ mail: 'ops@example.com' }), ...)`. Custom channels (Slack, SMS): `defineChannel`, passed in `channels` in `src/app.ts`. In tests, `app.services.notifications.fake()` records sends for `assertSentTo`.

Security headers are on by default in `src/http.ts`, including a strict CSP: only scripts with this request's nonce run (and what they load). Page and Vite tags get the nonce automatically; any inline `<script>` you add in a custom `rootView` needs `nonce="${nonce}"`. Don't loosen `script-src`; add other directives with `securityHeaders({ csp: { imgSrc: [...] } })`.

`.caldera/` is generated: never edit it. Run `caldera generate` after adding env, config, routes, models, policies or pages (`caldera dev` does it on save).

## Commands agents should use

- `caldera describe --json`: env schema, config (secrets redacted), providers and services
- `caldera route:list --json`, `caldera model:show <name> --json`, `caldera db:schema --json`, `caldera abilities --json`
- `caldera generate --check`: fails if generated types are stale
- `pnpm typecheck`, `pnpm test`

<!-- caldera:generated:start -->
<!-- caldera:generated:end -->
