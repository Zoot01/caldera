import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * A block of settings: its title and description on a gray band, and a white card below them with
 * the form or list. `tone="danger"` marks what can't be undone.
 */
export function Section({ title, description, tone, className, children }: { title: string; description?: ReactNode; tone?: 'danger'; className?: string; children: ReactNode }) {
  return (
    <section className={cn('rounded-xl border bg-muted/60 p-1', className)}>
      <header className="px-3 pt-2 pb-3">
        <h2 className={cn('font-medium text-sm', tone === 'danger' && 'text-destructive-foreground')}>{title}</h2>
        {description && <p className="mt-0.5 text-muted-foreground text-xs">{description}</p>}
      </header>
      <div className="space-y-6 rounded-lg border bg-card p-4 shadow-xs">{children}</div>
    </section>
  )
}
