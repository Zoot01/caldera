import { defineSeeder } from '@caldera-js/db/seeders'
import { sql } from 'drizzle-orm'

// Stands in for migrations: the fixture database is in memory.
export const schemaSeeder = defineSeeder({
  name: 'schema',
  run: ({ db }) => db.current().execute(sql`create table if not exists users (id uuid primary key default gen_random_uuid(), name text not null, email text not null unique)`),
})
