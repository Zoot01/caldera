import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  // Tables live in schema.ts and src/db/tables (where `caldera make:model` and `queue:table` put them).
  schema: ['./src/db/schema.ts', './src/db/tables/*.ts'],
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
})
