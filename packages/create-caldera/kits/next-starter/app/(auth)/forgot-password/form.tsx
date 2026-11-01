'use client'

import { useForm } from '@caldera/next/client'
import type { FormEvent } from 'react'
import { forgotPassword } from '@/app/actions/auth'
import { FormField } from '@/components/form-field'
import { TextLink } from '@/components/text-link'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function ForgotPasswordForm({ status }: { status?: string }) {
  const form = useForm({ email: '' })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    form.submit(forgotPassword)
  }
  return (
    <>
      {status && <p className="text-center font-medium text-sm text-success-foreground">{status}</p>}
      <form onSubmit={submit} className="flex flex-col gap-6">
        <FormField label="Email address" error={form.errors.email}>
          <Input type="email" autoComplete="email" autoFocus required placeholder="email@example.com" value={form.data.email} onChange={(e) => form.setData('email', e.target.value)} />
        </FormField>
        <Button type="submit" className="w-full" loading={form.processing}>
          Email password reset link
        </Button>
      </form>
      <p className="text-center text-muted-foreground text-sm">
        Or, return to <TextLink href="/login">log in</TextLink>
      </p>
    </>
  )
}

