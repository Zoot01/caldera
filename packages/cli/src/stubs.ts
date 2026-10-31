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

// Everything is denied until you allow it, and signed-out visitors are denied unless an ability
// opts in with \`{ guest: true, check }\`. For example: \`update: (user, row) => row.userId === user.id\`.
export const {{ Name }}Policy = definePolicy({{ Name }}, {
  viewAny: () => false,
  view: () => false,
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
  'queue-table': `import { bigint, index, integer, pgTable, text } from 'drizzle-orm/pg-core'

/**
 * Jobs for the \`database\` queue driver: written on dispatch, claimed by \`caldera queue:work\`, kept here
 * when they fail (\`caldera queue:failed\`). Caldera reads and writes it; no model needed.
 */
export const calderaJobs = pgTable(
  'caldera_jobs',
  {
    id: text('id').primaryKey(),
    queue: text('queue').notNull(),
    envelope: text('envelope').notNull(),
    attempts: integer('attempts').notNull().default(0),
    timeoutSeconds: integer('timeout_seconds').notNull(),
    availableAt: bigint('available_at', { mode: 'number' }).notNull(),
    reservedUntil: bigint('reserved_until', { mode: 'number' }),
    reservedBy: text('reserved_by'),
    failedAt: bigint('failed_at', { mode: 'number' }),
    error: text('error'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [index('caldera_jobs_queue_available').on(t.queue, t.availableAt)],
)
`,
  'queue-table-sqlite': `import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * Jobs for the \`database\` queue driver: written on dispatch, claimed by \`caldera queue:work\`, kept here
 * when they fail (\`caldera queue:failed\`). Caldera reads and writes it; no model needed.
 */
export const calderaJobs = sqliteTable(
  'caldera_jobs',
  {
    id: text('id').primaryKey(),
    queue: text('queue').notNull(),
    envelope: text('envelope').notNull(),
    attempts: integer('attempts').notNull().default(0),
    timeoutSeconds: integer('timeout_seconds').notNull(),
    availableAt: integer('available_at').notNull(),
    reservedUntil: integer('reserved_until'),
    reservedBy: text('reserved_by'),
    failedAt: integer('failed_at'),
    error: text('error'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('caldera_jobs_queue_available').on(t.queue, t.availableAt)],
)
`,
  notification: `import { defineNotification } from '@caldera/notifications'
import { z } from 'zod'

export const {{ Name }} = defineNotification({
  name: '{{ kebab }}',
  payload: z.object({ id: z.string() }),
  channels: {
    // Shown in the app's inbox: \`await inbox(user).list()\`. Needs \`caldera notifications:table\`.
    database: {
      schema: z.object({ id: z.string(), message: z.string() }),
      data: (to, { id }) => ({ id, message: '{{ Name }}' }),
    },
    // A mail from src/mail, to the notifiable's mail route:
    // mail: (to, { id }) => ({ mail: {{ Name }}Email, props: { name: '...' } }),
  },
  // Which channels, per notifiable (default: all of them):
  // via: (to) => ['database'],
  // One job per channel, after the transaction commits:
  // queue: true,
})
`,
  'cache-table': `import { bigint, pgTable, text } from 'drizzle-orm/pg-core'

/**
 * The \`database\` cache store (@caldera/cache/database): one row per key, plus rate-limit counters.
 * Caldera reads and writes it; no model needed.
 */
export const calderaCache = pgTable('caldera_cache', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  expiresAt: bigint('expires_at', { mode: 'number' }),
})
`,
  'cache-table-sqlite': `import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * The \`database\` cache store (@caldera/cache/database): one row per key, plus rate-limit counters.
 * Caldera reads and writes it; no model needed. Works on SQLite, libSQL and D1.
 */
export const calderaCache = sqliteTable('caldera_cache', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at'),
})
`,
  'notifications-table': `import { bigint, index, jsonb, pgTable, text } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

/**
 * Notifications for the \`database\` channel (@caldera/notifications/database): one row per send, read
 * back with \`inbox(user)\`. Caldera reads and writes it; no model needed.
 */
export const calderaNotifications = pgTable(
  'caldera_notifications',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    notifiableType: text('notifiable_type').notNull(),
    notifiableId: text('notifiable_id').notNull(),
    data: jsonb('data').notNull(),
    readAt: bigint('read_at', { mode: 'number' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    index('caldera_notifications_notifiable').on(t.notifiableType, t.notifiableId, t.createdAt),
    index('caldera_notifications_unread').on(t.notifiableType, t.notifiableId).where(sql\`\${t.readAt} is null\`),
  ],
)
`,
  'notifications-table-sqlite': `import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

/**
 * Notifications for the \`database\` channel (@caldera/notifications/database): one row per send, read
 * back with \`inbox(user)\`. \`data\` is JSON text. Caldera reads and writes it; no model needed.
 */
export const calderaNotifications = sqliteTable(
  'caldera_notifications',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    notifiableType: text('notifiable_type').notNull(),
    notifiableId: text('notifiable_id').notNull(),
    data: text('data').notNull(),
    readAt: integer('read_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('caldera_notifications_notifiable').on(t.notifiableType, t.notifiableId, t.createdAt),
    index('caldera_notifications_unread').on(t.notifiableType, t.notifiableId).where(sql\`\${t.readAt} is null\`),
  ],
)
`,
  mail: `import { defineMail } from '@caldera/mail'
import { Body, Container, Head, Html, Preview, Text } from '@react-email/components'
import { z } from 'zod'

function {{ Name }}({ name }: { name: string }) {
  return (
    <Html>
      <Head />
      <Preview>{{ Name }}</Preview>
      <Body style={{ fontFamily: 'system-ui, sans-serif' }}>
        <Container>
          <Text>Hi {name},</Text>
        </Container>
      </Body>
    </Html>
  )
}
{{ Name }}.PreviewProps = { name: 'Ann' }

export const {{ Name }}Email = defineMail({
  name: '{{ kebab }}',
  props: z.object({ name: z.string() }),
  subject: '{{ Name }}',
  component: {{ Name }},
})
`,
  schedule: `import { defineSchedule } from '@caldera/schedule'
import { {{ Job }} } from '../jobs/{{ jobKebab }}.js'

export const {{ name }} = defineSchedule('{{ kebab }}', {
  cron: '0 2 * * *', // 02:00 UTC every day
  job: {{ Job }},
  // payload: { ... },
  // withoutOverlapping: true, onOneServer: true, environments: ['production'],
})
`,
  event: `import { defineEvent } from '@caldera/events'
import { z } from 'zod'

export const {{ Name }} = defineEvent({
  name: '{{ kebab }}',
  payload: z.object({ id: z.string() }),
})
`,
  channel: `import { defineChannel } from '@caldera/broadcast'

// Private: browsers join through /_caldera/broadcast/auth, and only when authorize() says so.
// Bind a parameter to load its row (\`bind: { post: Post }\` for \`posts.{post}\`), and check a policy:
// \`authorize: ({ gate, post }) => gate.can(Post, 'view', post)\`.
export const {{ Name }}Channel = defineChannel('{{ kebab }}.{id}', {
  authorize: ({ user, params }) => user.id === params.id,
})
`,
  listener: `import { listen } from '@caldera/events'
import { {{ Event }} } from '../events/{{ eventKebab }}.js'

export const {{ name }} = listen({{ Event }}, async (event, ctx) => {
  // Runs in the emitting request, in order. ctx.services has the app's services.
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
