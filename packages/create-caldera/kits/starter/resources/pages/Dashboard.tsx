import { Head, usePage } from '@inertiajs/react'

// White cards on the page panel: replace them with your app's content.
const Placeholder = ({ className = '' }: { className?: string }) => (
  <div className={`relative overflow-hidden rounded-xl border bg-card shadow-xs ${className}`}>
    <div className="absolute inset-0 bg-[repeating-linear-gradient(45deg,transparent,transparent_8px,var(--color-border)_8px,var(--color-border)_9px)] opacity-60" />
  </div>
)

export default function Dashboard() {
  const user = usePage().props.auth.user!
  return (
    <>
      <Head title="Dashboard" />
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

Dashboard.layout = { breadcrumbs: [{ title: 'Dashboard', href: '/dashboard' }] }
