import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineJob } from '@caldera/queue'
import { z } from 'zod'

export const Greet = defineJob({
  name: 'fixture.greet',
  payload: z.object({ name: z.string() }),
  tries: 2,
  handle: ({ name }, ctx) => {
    if (name === 'flaky' && ctx.attempt === 1) throw new Error('first try fails')
    const dir = process.env.OUT_DIR!
    writeFileSync(join(dir, `${name}.txt`), `hello ${name} on attempt ${ctx.attempt}`)
  },
})
