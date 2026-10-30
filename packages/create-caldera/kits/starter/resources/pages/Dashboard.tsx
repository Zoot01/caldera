import { Head } from '@inertiajs/react'

const Placeholder = ({ className = '' }: { className?: string }) => (
  <div className={`relative overflow-hidden rounded-xl border border-dashed bg-muted/40 ${className}`}>
    <div className="absolute inset-0 bg-[repeating-linear-gradient(45deg,transparent,transparent_8px,var(--color-border)_8px,var(--color-border)_9px)]" />
  </div>
)

export default function Dashboard() {
  return (
    <>
      <Head title="Dashboard" />
      <div className="grid auto-rows-min gap-4 md:grid-cols-3">
        <Placeholder className="aspect-video" />
        <Placeholder className="aspect-video" />
        <Placeholder className="aspect-video" />
      </div>
      <Placeholder className="min-h-[60vh] flex-1 md:min-h-min" />
    </>
  )
}

Dashboard.layout = { breadcrumbs: [{ title: 'Dashboard', href: '/dashboard' }] }
