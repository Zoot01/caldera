import { load } from '@caldera-js/next'
import { cookies } from 'next/headers'
import type { ReactNode } from 'react'
import { type Teams, TeamsProvider } from '@/components/team-switcher'
import AppLayout from '@/layouts/app-layout'
import { context, flash } from '@/lib/caldera'
import { http } from '@/src/http'

/** The signed-in pages (dashboard, settings): the app layout, with the user, their teams and what was flashed. */
export default async function Layout({ children }: { children: ReactNode }) {
  const [{ user }, flashed, jar, teams] = await Promise.all([context(), flash(), cookies(), load<Teams | null>(http, '/teams/current')])
  const summary = user && { id: user.id, name: user.name, email: user.email, emailVerified: user.emailVerified, image: user.image ?? null }
  return (
    <TeamsProvider teams={teams}>
      <AppLayout user={summary} flash={flashed} sidebarOpen={jar.get('sidebar_state')?.value !== 'false'}>
        {children}
      </AppLayout>
    </TeamsProvider>
  )
}
