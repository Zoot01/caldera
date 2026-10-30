# {{ name }}

A [Caldera](https://caldera.dev) app: TypeScript, Hono, Drizzle, Zod.

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
| Providers | `src/providers/*.ts` (add to `src/app.ts`) | `caldera make:provider <name>` |
| Factories / seeders | `src/db/factories/`, `src/db/seeders/` | `caldera make:factory`, `caldera make:seeder` |

`.caldera/` is generated: never edit it. Run `caldera generate` after adding env, config, routes, models or policies.

## Commands agents should use

- `caldera describe --json`: env schema, config (secrets redacted), providers and services
- `caldera route:list --json`, `caldera model:show <name> --json`, `caldera db:schema --json`, `caldera abilities --json`
- `caldera generate --check`: fails if generated types are stale
- `pnpm typecheck`, `pnpm test`

<!-- caldera:generated:start -->
<!-- caldera:generated:end -->
