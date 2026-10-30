import { render } from '@react-email/render'
import { Body, Button, Container, Head, Html, Section, Text } from '@react-email/components'
import { pixelBasedPreset, Tailwind as ReactEmailTailwind } from '@react-email/tailwind'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { configKey, pixelBasedPreset as ownPreset, recordTailwindConfigs, setMailStyles, Tailwind } from '../src/tailwind.js'
import { classNamesIn, compileTailwind } from '../src/tailwind-build.js'

const config = { presets: [pixelBasedPreset], theme: { extend: { colors: { brand: '#ff5a1f' } } } }

// One template, written against either <Tailwind>.
const template = (Tw: (props: { children: ReactNode; config?: unknown }) => ReactNode, name: string) => (
  <Html>
    <Tw config={config}>
      <Head />
      <Body className="bg-gray-100 font-sans">
        <Container className="mx-auto my-10 max-w-xl rounded-lg bg-white p-6 shadow-md">
          <Text className="text-2xl font-bold text-brand">Welcome, {name}</Text>
          <Section className="ring-2 ring-blue-500 sm:p-8">
            <Text className="text-sm leading-6 text-gray-700">Your account is ready.</Text>
          </Section>
          <Button href="https://example.test" className="rounded bg-brand px-4 py-2 text-white hover:bg-black">
            Open
          </Button>
        </Container>
      </Body>
    </Tw>
  </Html>
)
// The same source text `caldera generate` scans.
const source = `
  <Body className="bg-gray-100 font-sans">
  <Container className="mx-auto my-10 max-w-xl rounded-lg bg-white p-6 shadow-md">
  <Text className="text-2xl font-bold text-brand">
  <Section className="ring-2 ring-blue-500 sm:p-8">
  <Text className={'text-sm leading-6 text-gray-700'}>
  <Button className={\`rounded bg-brand px-4 py-2 text-white hover:bg-black\`}>
  <p className={cn('text-xs', "italic")}>
`

afterEach(() => setMailStyles({}))

describe('precompiled Tailwind', () => {
  it('renders exactly what React Email’s <Tailwind> renders, without compiling at send time', async () => {
    const compiled = await compileTailwind(config, classNamesIn(source))
    setMailStyles({ [configKey(config)]: compiled })
    const expected = await render(template(ReactEmailTailwind as never, 'Ann'))
    const actual = await render(template(Tailwind, 'Ann'))
    expect(actual).toBe(expected)
    // States like hover: stay as classes, styled from the <head>, as React Email does.
    expect(actual).toContain('<style>.hover_bg-black:hover{background-color:rgb(0,0,0)!important}</style>')
    expect(actual).toContain('class="hover_bg-black"')
  })

  it('finds className strings the way Tailwind’s scanner would', () => {
    expect(classNamesIn(source)).toEqual([
      'bg-gray-100 font-sans',
      'mx-auto my-10 max-w-xl rounded-lg bg-white p-6 shadow-md',
      'text-2xl font-bold text-brand',
      'ring-2 ring-blue-500 sm:p-8',
      'text-sm leading-6 text-gray-700',
      'rounded bg-brand px-4 py-2 text-white hover:bg-black',
      'text-xs',
      'italic',
    ])
  })

  it('merges single classes for className strings built at runtime, and warns about unknown ones', async () => {
    setMailStyles({ [configKey(config)]: await compileTailwind(config, ['p-6', 'bg-white']) })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dynamic = ['p-6', 'bg-white', 'mystery-class'].join(' ')
    const html = await render(
      <Html>
        <Tailwind config={config}>
          <Head />
          <div className={dynamic}>x</div>
        </Tailwind>
      </Html>,
    )
    expect(html).toContain('style="padding:24px;background-color:rgb(255,255,255)"')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"mystery-class" wasn\'t compiled'))
    warn.mockRestore()
  })

  it('ships React Email’s pixelBasedPreset as plain data (no Tailwind compiler in the bundle)', () => {
    expect(ownPreset).toEqual(pixelBasedPreset)
  })

  it('records the configs mails use (what generate compiles for)', async () => {
    const recording = recordTailwindConfigs()
    await render(template(Tailwind, 'Ann'))
    recording.stop()
    expect(recording.configs.map(configKey)).toEqual([configKey(config)])
  })
})
