import { Head } from '@inertiajs/react'
import { AppearanceTabs } from '@/components/appearance-tabs'
import { Section } from '@/components/section'

export default function Appearance() {
  return (
    <>
      <Head title="Appearance settings" />
      <Section title="Appearance" description="Light, dark, or whatever your system uses">
        <AppearanceTabs labels />
      </Section>
    </>
  )
}

Appearance.layout = { breadcrumbs: [{ title: 'Appearance settings', href: '/settings/appearance' }] }
