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
| Factories / seeders | `src/db/factories/`, `src/db/seeders/` | `caldera make:factory`, `caldera make:seeder` |

Jobs run as soon as they're dispatched while `QUEUE_CONNECTION=sync` (the default). With `REDIS_URL` and `QUEUE_CONNECTION=redis` they go to BullMQ, and `pnpm worker` (`caldera queue:work`) runs them; the cache moves to Redis too. In tests, `app.services.queue.fake()` captures dispatched jobs for assertions.

Security headers are on by default in `src/http.ts`, including a strict CSP: only scripts with this request's nonce run (and what they load). Page and Vite tags get the nonce automatically; any inline `<script>` you add in a custom `rootView` needs `nonce="${nonce}"`. Don't loosen `script-src`; add other directives with `securityHeaders({ csp: { imgSrc: [...] } })`.

`.caldera/` is generated: never edit it. Run `caldera generate` after adding env, config, routes, models, policies or pages (`caldera dev` does it on save).

## Commands agents should use

- `caldera describe --json`: env schema, config (secrets redacted), providers and services
- `caldera route:list --json`, `caldera model:show <name> --json`, `caldera db:schema --json`, `caldera abilities --json`
- `caldera generate --check`: fails if generated types are stale
- `pnpm typecheck`, `pnpm test`

<!-- caldera:generated:start -->
<!-- caldera:generated:end -->
