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
| Factories / seeders | `src/db/factories/`, `src/db/seeders/` | `caldera make:factory`, `caldera make:seeder` |

`.caldera/` is generated: never edit it. Run `caldera generate` after adding env, config, routes, models, policies or pages (`caldera dev` does it on save).

## Commands agents should use

- `caldera describe --json`: env schema, config (secrets redacted), providers and services
- `caldera route:list --json`, `caldera model:show <name> --json`, `caldera db:schema --json`, `caldera abilities --json`
- `caldera generate --check`: fails if generated types are stale
- `pnpm typecheck`, `pnpm test`

<!-- caldera:generated:start -->
<!-- caldera:generated:end -->
