/**
 * Built-in stubs. Placeholders: {{ Name }} (BlogPost), {{ name }} (blogPost), {{ kebab }} (blog-post),
 * {{ table }} (blog_posts), {{ plural }} (blogPosts). `caldera stub:eject <stub>` copies one to
 * `stubs/<stub>.stub` in the app, where it takes precedence.
 */
export const STUBS = {
  table: `import { snakeCase, text, uuid } from 'drizzle-orm/pg-core'
import { timestamps } from '@caldera/db/pg'

export const {{ plural }} = snakeCase.table('{{ table }}', {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  ...timestamps(),
})
`,
  'table-sqlite': `import { snakeCase, text } from 'drizzle-orm/sqlite-core'
import { timestamps } from '@caldera/db/sqlite'

export const {{ plural }} = snakeCase.table('{{ table }}', {
  id: text()
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text().notNull(),
  ...timestamps(),
})
`,
  model: `import { defineModel } from '@caldera/db'
import { {{ plural }} } from '../db/tables/{{ kebab }}.js'

export const {{ Name }} = defineModel({{ plural }}, {
  name: '{{ name }}',
})
`,
  policy: `import { definePolicy } from '@caldera/auth'
import { {{ Name }} } from '../models/{{ kebab }}.js'

export const {{ Name }}Policy = definePolicy({{ Name }}, {
  viewAny: { guest: true, check: () => true },
  view: { guest: true, check: () => true },
  create: () => false,
  update: () => false,
  delete: () => false,
})
`,
  factory: `import { defineFactory } from '@caldera/db/factories'
import { {{ Name }} } from '../../models/{{ kebab }}.js'

export const {{ Name }}Factory = defineFactory({{ Name }}, {
  definition: ({ faker, seq }) => ({
    name: \`\${faker.word.noun()} \${seq}\`,
  }),
})
`,
  seeder: `import { defineSeeder } from '@caldera/db/seeders'

export const {{ name }}Seeder = defineSeeder({
  name: '{{ kebab }}',
  environments: ['local', 'test'],
  run: async ({ log }) => {
    log('{{ kebab }} seeded')
  },
})
`,
  routes: `import { defineRoutes } from '@caldera/http'

export const {{ plural }} = defineRoutes('{{ plural }}', { prefix: '/{{ kebab }}' })
  .get('index', '/', (c) => c.json({ data: [] }))
`,
  config: `import { defineConfig } from '@caldera/core'

export const {{ name }} = defineConfig('{{ name }}', (env) => ({
  // Read env here only: config is the one place env is available.
}))
`,
  provider: `import { defineProvider } from '@caldera/core'

export const {{ name }}Provider = defineProvider({
  name: '{{ kebab }}',
  register: (app) => ({
    // {{ name }}: app.singleton(() => create{{ Name }}(app.config)),
  }),
})
`,
  job: `import { defineJob } from '@caldera/queue'
import { z } from 'zod'

export const {{ Name }} = defineJob({
  name: '{{ kebab }}',
  payload: z.object({ id: z.string() }),
  tries: 3,
  backoff: [10, 60],
  async handle({ id }, ctx) {
    // ctx.services has the app's services; ctx.signal aborts at the timeout.
  },
})
`,
  page: `import { Head } from '@inertiajs/react'

export default function {{ Name }}({ title }: { title: string }) {
  return (
    <>
      <Head title={title} />
      <h1>{title}</h1>
    </>
  )
}
`,
} as const

export type StubName = keyof typeof STUBS
