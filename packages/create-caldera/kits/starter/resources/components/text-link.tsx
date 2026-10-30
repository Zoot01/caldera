import { Link } from '@inertiajs/react'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

export function TextLink({ className, ...props }: ComponentProps<typeof Link>) {
  return <Link className={cn('text-foreground underline decoration-foreground/30 underline-offset-4 transition-colors hover:decoration-foreground', className)} {...props} />
}
