import { load } from '@caldera/next'
import type { Metadata } from 'next'
import { requireUser } from '@/lib/caldera'
import { http } from '@/src/http'

export const metadata: Metadata = { title: 'Dashboard' }

// White cards on the page panel: replace them with your app's content.
const Placeholder = ({ className = '' }: { className?: string }) => (
  <div className={`relative overflow-hidden rounded-xl border bg-card shadow-xs ${className}`}>
    <div className="absolute inset-0 bg-[repeating-linear-gradient(45deg,transparent,transparent_8px,var(--color-border)_8px,var(--color-border)_9px)] opacity-60" />
  </div>
)

export default async function Dashboard() {
  // The route's middleware (mw.auth(), mw.verified()) decides who may see it; then the page's data.
  await load(http, '/dashboard')
  const user = await requireUser()
  return (
    <>
      <div className="space-y-1">
        <h1 className="font-medium text-xl tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground text-sm">Welcome back, {user.name.split(' ')[0]}.</p>
      </div>
      <div className="grid auto-rows-min gap-4 md:grid-cols-3">
        <Placeholder className="aspect-video" />
        <Placeholder className="aspect-video" />
        <Placeholder className="aspect-video" />
      </div>
      <Placeholder className="min-h-[50vh] flex-1 md:min-h-min" />
    </>
  )
}
