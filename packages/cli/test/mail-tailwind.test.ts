import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { generate, openProject } from '../src/index.js'

const here = import.meta.dirname
const tmp = join(here, '.tmp')
const PREFIX = 'mailtw-'
afterAll(() => {
  for (const entry of existsSync(tmp) ? readdirSync(tmp) : []) if (entry.startsWith(PREFIX)) rmSync(join(tmp, entry), { recursive: true, force: true })
})

const template = (classes: string) => `import { defineMail } from '@caldera/mail'
import { pixelBasedPreset, Tailwind } from '@caldera/mail/tailwind'
import { Body, Head, Html, Text } from '@react-email/components'
import { z } from 'zod'

function Promo({ name }: { name: string }) {
  return (
    <Html>
      <Tailwind config={{ presets: [pixelBasedPreset] }}>
        <Head />
        <Body className="${classes}">
          <Text className="text-2xl font-bold hover:underline">Hi {name}</Text>
        </Body>
      </Tailwind>
    </Html>
  )
}
Promo.PreviewProps = { name: 'Ann' }

export const PromoEmail = defineMail({ name: 'promo', props: z.object({ name: z.string() }), subject: 'Promo', component: Promo })
`

it('generate compiles the Tailwind mail templates use, and recompiles only when their classes change', async () => {
  const dir = join(tmp, `${PREFIX}${Math.random().toString(36).slice(2)}`)
  cpSync(join(here, 'fixtures/mcp-app'), dir, { recursive: true, filter: (src) => !src.includes('/.caldera') && !src.endsWith('.db') })
  writeFileSync(join(dir, 'src/mail/promo.tsx'), template('bg-white p-6'))
  await generate(openProject(dir))
  const first = readFileSync(join(dir, '.caldera/mails.gen.ts'), 'utf8')
  expect(first).toContain("import { setMailStyles } from '@caldera/mail/tailwind'")
  const hash = /tailwind:([0-9a-f]+)/.exec(first)![1]
  const styles = JSON.parse(/^setMailStyles\((.*)\)$/m.exec(first)![1]!) as Record<string, { strings: Record<string, { style: Record<string, string>; keep: string[] }>; css: string }>
  const [compiled] = Object.values(styles)
  expect(compiled!.strings['bg-white p-6']!.style).toEqual({ backgroundColor: 'rgb(255,255,255)', padding: '24px' })
  expect(compiled!.strings['text-2xl font-bold hover:underline']).toMatchObject({ keep: ['hover_underline'] })
  expect(compiled!.css).toContain('.hover_underline:hover')

  await generate(openProject(dir))
  expect(readFileSync(join(dir, '.caldera/mails.gen.ts'), 'utf8')).toBe(first)

  writeFileSync(join(dir, 'src/mail/promo.tsx'), template('bg-black p-6'))
  await generate(openProject(dir))
  const changed = readFileSync(join(dir, '.caldera/mails.gen.ts'), 'utf8')
  expect(/tailwind:([0-9a-f]+)/.exec(changed)![1]).not.toBe(hash)
  expect(changed).toContain('"bg-black p-6"')
}, 60_000)
