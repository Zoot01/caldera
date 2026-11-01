import { cookies } from 'next/headers'
import type { ReactNode } from 'react'
import AppLayout from '@/layouts/app-layout'
import { context, flash } from '@/lib/caldera'

/** The signed-in pages (dashboard, settings): the app layout, with the user and what was flashed. */
export default async function Layout({ children }: { children: ReactNode }) {
  const [{ user }, flashed, jar] = await Promise.all([context(), flash(), cookies()])
  const summary = user && { id: user.id, name: user.name, email: user.email, emailVerified: user.emailVerified, image: user.image ?? null }
  return (
    <AppLayout user={summary} flash={flashed} sidebarOpen={jar.get('sidebar_state')?.value !== 'false'}>
      {children}
    </AppLayout>
  )
}
