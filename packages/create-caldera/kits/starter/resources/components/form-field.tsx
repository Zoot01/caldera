import type { ReactNode } from 'react'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'

/** A labelled control with the server's validation error for it (`form.errors.email`). */
export function FormField({ label, error, description, aside, children }: { label: string; error?: string | undefined; description?: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <Field invalid={Boolean(error)}>
      <div className="flex w-full items-center justify-between">
        <FieldLabel>{label}</FieldLabel>
        {aside}
      </div>
      {children}
      {description && <FieldDescription>{description}</FieldDescription>}
      {error && <FieldError match>{error}</FieldError>}
    </Field>
  )
}
