import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineJob } from '@caldera-js/queue'
import { z } from 'zod'

export const Stamp = defineJob({
  name: 'stamp',
  payload: z.object({ label: z.string() }),
  handle: ({ label }) => appendFileSync(join(process.env.OUT_DIR ?? '.', 'stamps.log'), `${label}\n`),
})
