# Caldera

A TypeScript framework for web apps, in the spirit of Laravel. Everything a real app needs is part of the framework, there's one obvious way to do each thing, and the app you create on day one already has sign-up, settings, tests and a deploy target.

**[Documentation](https://calderajs.dev)** · [Installation](https://calderajs.dev/docs/installation) · [Your first app](https://calderajs.dev/docs/first-app)

```bash
npm create caldera@latest my-app
cd my-app
npm run dev
```

Requires Node.js 22 or newer. Works with pnpm, npm, Yarn and Bun.

## What you get

- **Routes and pages.** Routes are [Hono](https://hono.dev). Pages are React components rendered with [Inertia](https://inertiajs.com), so there's no API layer to write, and a page's props are type-checked against its route.
- **A database.** Tables are [Drizzle](https://orm.drizzle.team) schemas, with models, migrations, factories and seeders on top. SQLite (a local file, Turso or D1) or Postgres.
- **Auth.** Sign-up, login, email verification, password reset, passkeys and two-factor, with [Better Auth](https://better-auth.com). Policies decide who may do what, and teams with roles are one flag away.
- **Background work.** Queued jobs (Redis, a database table, or a platform queue), events and listeners, and cron schedules.
- **Mail and notifications.** Mails are [React Email](https://react.email) components. Notifications go out by mail, to an in-app inbox, or both.
- **Realtime.** Broadcast to private and presence channels from Caldera's own server, Pusher, or Cloudflare.
- **The rest.** File storage (local, S3, R2), caching and rate limits, translations, and a test client for all of it.

It runs on a Node server, on Vercel, or on Cloudflare Workers. Backends like Redis or S3 are swappable drivers, so edge bundles never pull in Node-only code. There's also a [Next.js variant](https://calderajs.dev/docs/nextjs) if you'd rather render with Next.

## A taste

```ts
// src/routes/notes.ts
const NoteForm = defineRequest({
  body: z.object({ title: z.string().trim().min(1).max(200), body: z.string().default('') }),
})

export const notes = defineRoutes('notes', { prefix: '/notes', middleware: [mw.auth()] })
  .get('index', '/', async (c) => {
    const mine = await Note.findMany({ where: { userId: c.var.user!.id } })
    return c.render('Notes/Index', { notes: mine }) // checked against the page's props
  })
  .post('store', '/', { request: NoteForm }, async (c) => {
    await Note.create({ ...c.req.valid('json'), userId: c.var.user!.id })
    return back(c).with('success', 'Note added.')
  })
  .delete('destroy', '/:note', { bind: { note: Note } }, async (c) => {
    await Note.delete(c.var.note)
    return back(c)
  })
```

```bash
caldera make:model Note
caldera db:generate --name notes && caldera db:migrate
caldera make:page Notes/Index
```

## Made to be read by coding agents

Every Caldera app explains itself. `AGENTS.md` at its root says where each kind of code goes and lists your routes, models, jobs and channels, and it's regenerated as you work. `caldera mcp` gives coding agents access to the running app: its routes, schema, recent errors and logs, and read-only SQL. New apps ship a `.mcp.json`, so agents find it on their own.

## Packages

| Package | What |
| --- | --- |
| [`create-caldera`](packages/create-caldera) | The app scaffolder: starter or blank kit, teams, SQLite or Postgres, deploy target |
| [`@caldera-js/core`](packages/core) | Env, config, providers, app lifecycle, driver managers |
| [`@caldera-js/http`](packages/http) | Routes, requests, middleware, errors, CSRF, sessions |
| [`@caldera-js/db`](packages/db) | Models, transactions, factories, seeders, test databases |
| [`@caldera-js/auth`](packages/auth) | Better Auth integration, policies and the gate |
| [`@caldera-js/inertia`](packages/inertia) | Inertia v3 server adapter and Vite integration |
| [`@caldera-js/next`](packages/next) | Caldera inside a Next.js app |
| [`@caldera-js/queue`](packages/queue) | Jobs, dispatch, drivers, the worker |
| [`@caldera-js/events`](packages/events) | Events and listeners |
| [`@caldera-js/schedule`](packages/schedule) | Cron schedules |
| [`@caldera-js/mail`](packages/mail) | React Email mails; SMTP, Resend, Postmark, SES |
| [`@caldera-js/notifications`](packages/notifications) | Mail and database notifications |
| [`@caldera-js/broadcast`](packages/broadcast) | Realtime channels |
| [`@caldera-js/cache`](packages/cache) | Cache stores, locks, rate limiting |
| [`@caldera-js/storage`](packages/storage) | File storage: local, S3, R2 |
| [`@caldera-js/i18n`](packages/i18n) | Translations |
| [`@caldera-js/testing`](packages/testing) | The test client and helpers |
| [`@caldera-js/cli`](packages/cli) | The `caldera` command |

## Status

Caldera is at 0.1.0. It works and is tested end to end, but expect rough edges and some API changes before 1.0. Bug reports and feedback are very welcome in [issues](../../issues).

## Contributing

This is a pnpm monorepo:

```bash
pnpm install
pnpm test        # build every package, then run the tests
pnpm typecheck
pnpm docs        # the docs site on http://localhost:3200
```

Some tests run against real backends (Redis, Postgres, Docker for S3 and SMTP). They're skipped when those aren't installed. See [AGENTS.md](AGENTS.md) for details.

## License

[MIT](LICENSE)
