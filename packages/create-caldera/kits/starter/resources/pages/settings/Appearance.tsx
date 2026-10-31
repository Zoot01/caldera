import { Head } from '@inertiajs/react'
import { AppearancePicker } from '@/components/appearance-picker'
import { Section } from '@/components/section'

export default function Appearance() {
  return (
    <>
      <Head title="Appearance settings" />
      <Section title="Appearance" description="Light, dark, or whatever your system uses">
        <AppearancePicker />
      </Section>
    </>
  )
}

Appearance.layout = { breadcrumbs: [{ title: 'Appearance settings', href: '/settings/appearance' }] }
