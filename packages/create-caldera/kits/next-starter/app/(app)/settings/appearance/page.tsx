import { load } from '@caldera/next'
import type { Metadata } from 'next'
import { AppearancePicker } from '@/components/appearance-picker'
import { Section } from '@/components/section'
import { http } from '@/src/http'

export const metadata: Metadata = { title: 'Appearance settings' }

export default async function Appearance() {
  await load(http, '/settings/appearance')
  return (
    <Section title="Appearance" description="Light, dark, or whatever your system uses">
      <AppearancePicker />
    </Section>
  )
}
