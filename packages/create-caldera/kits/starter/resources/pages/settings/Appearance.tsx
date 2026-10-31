import { Head } from '@inertiajs/react'
import { AppearanceTabs } from '@/components/appearance-tabs'
import { Heading } from '@/components/heading'

export default function Appearance() {
  return (
    <>
      <Head title="Appearance settings" />
      <div className="space-y-6">
        <Heading size="small" title="Appearance" description="Light, dark, or whatever your system uses" />
        <AppearanceTabs labels />
      </div>
    </>
  )
}

Appearance.layout = { breadcrumbs: [{ title: 'Appearance settings', href: '/settings/appearance' }] }
