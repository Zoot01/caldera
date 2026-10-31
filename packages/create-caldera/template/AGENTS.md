# {{ name }}

A [Caldera](https://caldera.dev) app: TypeScript, Hono, Drizzle, Zod, and React pages over Inertia (Vite).

Pages get their data from the route that renders them: no API layer. A page's props are its component's props, so changing them makes every `c.render` call that passes the wrong data fail `pnpm typecheck`. Shared props (from `src/inertia.ts`) are on `usePage().props` and typed too. Validation errors come back as `props.errors`; `back(c).with('success', '…')` shows up as `usePage().flash`.

A helper that takes a route's `c` types it as `RouteContext<{ post: typeof Post }>` from `@caldera/http`: it sees `c.var` (your services, and the models the route binds), and any route with at least those bindings can pass its `c`. Hono's own `Context` won't accept it.

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
| UI components (coss ui: Base UI + Tailwind; the app's own code) | `resources/components/ui/*.tsx` | `npx shadcn add @coss/<name>` |
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
| Realtime channels (who may join) | `src/channels/*.ts` | `caldera make:channel <Name>` |
| Translations (ICU messages; `lang/en` is canonical) | `lang/<locale>/*.json` | |
| Factories / seeders | `src/db/factories/`, `src/db/seeders/` | `caldera make:factory`, `caldera make:seeder` |
| Migrations (committed; applied by `caldera db:migrate`, and by tests) | `drizzle/` | `caldera db:generate` |

Jobs run as soon as they're dispatched while `QUEUE_CONNECTION=sync` (the default). In production set `QUEUE_CONNECTION=database` (jobs in the `caldera_jobs` table, `src/db/tables/caldera-jobs.ts`) or `redis` (BullMQ, with `REDIS_URL`; the cache moves to Redis too), and run `pnpm worker` (`caldera queue:work`). Failed database jobs: `caldera queue:failed`, `queue:retry <id>|--all`, `queue:forget`. In tests, `app.services.queue.fake()` captures dispatched jobs for assertions.

Schedules run from `pnpm scheduler` (`caldera schedule:work`) on a server, or `* * * * * caldera schedule:run` in a crontab. On Cloudflare, export `scheduled: (controller, env) => handleScheduled(app, controller, env)`; on Vercel, set `CRON_SECRET`. `caldera schedule:sync --target cloudflare|vercel` writes the platform's cron config. `caldera schedule:list` shows next runs.

Files: `c.var.storage` is the default disk (`storage/app` here, or `STORAGE_ROOT`; S3 once `S3_BUCKET` is set); `storage.disk('public')` is served at `/storage`. Serve a stored private file with `return fileResponse(row.file)` (after checking who may see it): it downloads under the user's original name. Validate uploaded files with `zfile({ maxSize, mimes })` in `defineRequest` (it checks the bytes, not the client's type). For big files, or on Vercel (4.5MB request limit), upload straight to the bucket: define a kind in `src/uploads.ts` and use `useUpload()`. It resolves with a signed pending upload: send it with the form, validate it with `zupload(avatar)` (never `fileRef`, which trusts whatever disk and key the browser sends), then store `await claimUpload(file)` in a `zjson(fileRef)` column. Claiming moves the file into the upload's directory, once: sending the same upload twice gets a validation error, so two rows never share a file. Unclaimed uploads wait in `tmp/uploads/`; schedule `pruneUploads(storage)` daily to clear them. `cleanupFiles('column')` in the model's hooks deletes replaced files. S3 buckets need CORS allowing PUT from your site for direct uploads.

Mail: `await mail.to(user).send(WelcomeEmail, props)` sends now; `.queue(...)` queues it (it renders in the worker). Nothing is queued implicitly. Never write the app's name into a mail: `useApp().name` in the component and `subject: (p, { app }) => …` read `config.app`, and a `MAIL_FROM` without a name is sent as the app's name. `MAIL_MAILER=log` (the default) prints a line and keeps an outbox at `/_caldera/mail/outbox`; `/_caldera/mail` previews every mail with its `PreviewProps`. In tests, `app.services.mail.fake()` records mail for `assertSent`/`assertQueued`. For Tailwind in mail, `import { Tailwind, pixelBasedPreset } from '@caldera/mail/tailwind'` (not React Email's): `caldera generate` compiles your templates' classes once with React Email's own Tailwind, so sending never compiles Tailwind (about 1.3MB less in an edge bundle, and no per-send CPU). Write classes as literals (`className="…"`); classes built at runtime fall back to per-class styles.

Notifications: `await notify(user, Welcome, payload)` (from `@caldera/notifications`) sends one notification over each of its `channels`; `via()` picks channels per user. With `queue: true` each channel is its own job (a failed email retries alone), queued after the transaction commits. The `database` channel stores rows in `caldera_notifications` (`src/db/tables/caldera-notifications.ts`); read them with `inbox(user).list({ unread: true })`, `.find(id)`, `.unreadCount()`, `.markRead(ids)`. A row's `data` is typed by its notification's `database.schema` once you check its `type` (`if (n.type === 'users.welcome') n.data.url`). `caldera make:notification billing.InvoicePaid` writes the notification and its mail, with the id `billing.invoice-paid`. Inbox calls are scoped to that user, so ids from a request can't touch anyone else's. Send to an address without a user via `notify(route({ mail: 'ops@example.com' }), ...)`. Custom channels (Slack, SMS): `defineChannel`, passed in `channels` in `src/app.ts`. In tests, `app.services.notifications.fake()` records sends for `assertSentTo`.

Realtime: an event with `broadcast` also reaches browsers. `defineEvent({ name: 'post.updated', payload, broadcast: { on: (p) => PostChannel.with({ post: p.postId }), with: (p) => ({ title: p.title }) } })`, then `emit(...)` as usual: it's sent after the transaction commits, without holding up the response (`queue: true` sends it from a job). `with` picks what browsers get; without it they get the whole payload. Channels live in `src/channels`: private by default, joined only when `authorize` allows (`bind: { post: Post }` loads the row; `({ gate, post }) => gate.can(Post, 'view', post)` reuses a policy); `type: 'presence'` adds `member` (what others see) and `clientEvents` (whispers). In pages: `useChannel('posts.{post}', { post: post.id }, { on: { 'post.updated': () => router.reload() } })` and `const { members, whisper } = usePresence(...)` from `@caldera/broadcast/react`, typed from your channels and events. `emit(E, payload, { toOthers: true })` skips the browser that made the request. Models can broadcast their own writes: `defineModel(posts, { name: 'post', broadcast: { on: (post) => channel('posts.{post}', { post: post.id }), with: (post) => ({ id: post.id, title: post.title }) } })` sends `post.created`, `post.updated` and `post.deleted` after the write commits (`with` is required; in models name channels with `channel()` from `@caldera/broadcast`, since channel files import models). Where broadcasts go is `BROADCAST_CONNECTION`: unset, they're only logged (browsers don't connect), so an app that sets nothing still boots anywhere. `.env` picks `server`, and `caldera dev` runs that server (pusher protocol, on `BROADCAST_PORT`). In production: `pnpm realtime` (`caldera broadcast:serve`) behind a TLS proxy with `BROADCAST_PUBLIC_URL` (with `REDIS_URL` set, run it on as many machines as you like: they share connections and presence); or hosted Pusher (`BROADCAST_CONNECTION=pusher`, `PUSHER_APP_ID`, `PUSHER_KEY`, `PUSHER_SECRET`, `PUSHER_CLUSTER`); or Soketi/Reverb at `BROADCAST_HOST` with their `BROADCAST_SECRET`; or `sse`: the app streams events itself, nothing else to run, but one-way (no presence or whispers; with `REDIS_URL`, several processes share it). Our own server and the app derive their shared secret from `APP_KEY`, so there's nothing else to set. On Workers, `caldera cloudflare:setup` adds the BroadcastHub Durable Object. Vercel functions can't hold WebSockets: use hosted Pusher or a server elsewhere; `caldera check` warns when the app broadcasts events that would reach no browser. `caldera broadcast:authorize private-posts.42 --user 1` explains who may join; in tests, `t.fake('broadcast')` then `.assertBroadcast(PostUpdated, { on: PostChannel.with({ post: 1 }) })`. Whispers come from other users' browsers: treat them as untrusted.

Translations: messages are ICU (`{count, plural, one {# post} other {# posts}}`) in `lang/<locale>/<namespace>.json`, keyed `namespace.key`. On the server, `c.var.i18n.t('posts.count', { count })`; outside a request, `translator('fr').t(...)` from `@caldera/i18n`. Keys and parameters are typed from `lang/en`, so a wrong key or a missing parameter fails `pnpm typecheck`. A page lists what it needs with `export const messages = ['posts.*']` (a literal array) and reads it with `const { t, rich } = useT()` from `@caldera/i18n/react`; only those messages ship to the browser. The locale comes from the user's `locale`, then the `caldera_locale` cookie (`c.var.i18n.setLocale('fr')`), then `Accept-Language`. Validation errors and error messages are translated (`validation.*`, `errors.*`; built in for en, fr, es, de; override any key in `lang/<locale>/validation.json`, name fields in `validation.attributes`). `caldera i18n:missing` lists missing, extra, unused and mismatched messages; `caldera check` fails when a translation takes different parameters.

Cloudflare Workers: `caldera cloudflare:setup` adds `wrangler.json` and `src/worker.ts` (HTTP, Cloudflare Queues consumer, Cron Triggers). The app needs no changes: with the Workers bindings present, the config uses D1 (`DB`) for the database, the `database` cache store (`caldera_cache`, for locks and rate limits), R2 (`FILES`) for files, Cloudflare Queues (`QUEUE`) and Cloudflare Email Service (`EMAIL`). D1 migrations: `caldera db:generate`, `caldera d1:migrations`, then `wrangler d1 migrations apply DB --local|--remote`. Node-only pieces (SMTP, BullMQ/Redis, the local disk, the database queue's worker) don't run there.

Tests (`pnpm test`, Vitest): `const t = setupApp(app)` from `@caldera/testing` at the top of a test file boots the app with a fresh database built from your migrations (`drizzle/`), rolls each test back, and shuts down after. `t.client(http)` sends requests in-process with cookies (`.get`, `.post(path, { json | form })`, `.visit(path)` for Inertia, `await .actingAs(user)` with Better Auth); responses assert: `.assertOk()`, `.assertJson({...})`, `.assertRedirect('/x')`, `.assertInertia('Posts/Index', { posts })`, `await .assertValidationErrors(['title'])` (JSON or a form redirected back). Downloads: `.assertDownload('report.pdf')`, and `.bytes()` for the exact body (`.body` is text). `t.fake('mail' | 'queue' | 'events' | 'notifications' | 'storage')` fakes a service for one test. Code under test must use models or `db.current()` (not `db.client`) so it joins the test's transaction. Schema change: `caldera db:generate` makes the migration tests (and production, `caldera db:migrate`) use. Postgres apps set `DATABASE_TEST_URL` (its name must contain "test").

Vercel: `caldera vercel:setup` adds `vercel.json` (your build, `public/` on the CDN, everything else rewritten to the app) and `api/index.ts` (the app as a Node.js function, with Vercel's `waitUntil`); add `@vercel/functions`. In the Vercel project set a hosted `DATABASE_URL` (Turso or Postgres), `QUEUE_CONNECTION=deferred`, `S3_*` for files and a mailer; `vercel pull --environment=production` then `caldera check` reports what wouldn't work there. Schedules: `caldera schedule:sync --target vercel`.

Server-side rendering: first loads are rendered on the server from `resources/ssr.tsx` (`ssr: viteSsr()` in `src/inertia.ts`), then hydrated; Inertia visits stay JSON. In development Vite renders them (with HMR); `pnpm build` also builds `build/ssr/ssr.js`, which `pnpm start` renders in-process (no second server); `cloudflare:setup` and `vercel:setup` bundle it. Pages render on the server, so don't touch `window`, `document` or `localStorage` while rendering: do it in `useEffect` or event handlers. A page built on browser-only code (maps, charts, rich editors) can skip the server: `c.render('Places/Map', props, { ssr: false })`, or for a group `viteSsr({ except: ['Admin/*'] })`. If SSR fails or takes over 2s, the page renders in the browser instead and the error is logged.

UI: Tailwind CSS v4 and coss ui (https://coss.com/ui), built on Base UI, not Radix: compose with `render={<Link href="/x" />}` (not `asChild`); `Dialog` parts are `DialogPopup`/`DialogPanel` (not `DialogContent`), menus are `Menu*`, toasts are `toastManager.add({ title, type })` inside a `ToastProvider`. Import from `@/…`, which is `resources/` (`@/components/ui/button`); `npx shadcn add @coss/<name>` adds a component to `resources/components/ui` (only the ones in use are there, so check before importing). Theme colors, radius and fonts are CSS variables in `resources/app.css` (`:root` light, `.dark` dark); use the tokens (`bg-background`, `text-muted-foreground`, `border-border`), not raw colors, so both themes work. Light/dark/system comes from the `appearance` cookie: `appearance()` in `src/inertia.ts` renders it on the server, `useAppearance()` / `setAppearance()` from `@/hooks/use-appearance` read and change it, `<AppearanceTabs />` is a ready switcher.

Security headers are on by default in `src/http.ts`, including a strict CSP: only scripts with this request's nonce run (and what they load). Page and Vite tags get the nonce automatically; any inline `<script>` you add in a custom `rootView` needs `nonce="${nonce}"`. Don't loosen `script-src`; add other directives with `securityHeaders({ csp: { imgSrc: [...] } })`.

`.caldera/` is generated: never edit it. Run `caldera generate` after adding env, config, routes, models, policies or pages (`caldera dev` does it on save; use `caldera dev --poll` in Docker, WSL2 on a Windows drive or a network filesystem, where file events don't arrive).

## MCP server

`.mcp.json` registers `caldera mcp` (stdio), so Claude Code and other MCP clients get these tools in this project:

- **Read the app:** `describe`, `routes`, `db_schema`, `model`, `abilities`, `schedules`, `mail_list`, `broadcast_list`, `i18n_missing`, `check`.
- **Realtime:** `broadcast_authorize` (runs a channel's `authorize` for a user id and says why it allows or refuses).
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
