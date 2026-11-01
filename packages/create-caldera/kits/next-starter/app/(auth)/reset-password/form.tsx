'use client'

import { useForm } from '@caldera-js/next/client'
import type { FormEvent } from 'react'
import { resetPassword } from '@/app/actions/auth'
import { FormField } from '@/components/form-field'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function ResetPasswordForm({ token }: { token: string }) {
  const form = useForm({ token, password: '', passwordConfirmation: '' })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    form.submit(resetPassword, { onFinish: () => form.reset('password', 'passwordConfirmation') })
  }
  return (
    <>
      <form onSubmit={submit} className="flex flex-col gap-6">
        <FormField label="New password" error={form.errors.password}>
          <Input type="password" autoComplete="new-password" autoFocus required placeholder="Password" value={form.data.password} onChange={(e) => form.setData('password', e.target.value)} />
        </FormField>
        <FormField label="Confirm password" error={form.errors.passwordConfirmation}>
          <Input
            type="password"
            autoComplete="new-password"
            required
            placeholder="Confirm password"
            value={form.data.passwordConfirmation}
            onChange={(e) => form.setData('passwordConfirmation', e.target.value)}
          />
        </FormField>
        <Button type="submit" className="w-full" loading={form.processing}>
          Reset password
        </Button>
      </form>
    </>
  )
}

