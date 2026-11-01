'use client'

import { useForm } from '@caldera/next/client'
import type { FormEvent } from 'react'
import { updatePassword } from '@/app/actions/settings'
import { useStatusToast } from '@/components/flash-toasts'
import { FormField } from '@/components/form-field'
import { type PasskeySummary, Passkeys } from '@/components/passkeys'
import { Section } from '@/components/section'
import { TwoFactor, type TwoFactorState } from '@/components/two-factor'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function SecurityForm({
  twoFactor,
  passkeys,
  status,
  recoveryCodes,
}: {
  twoFactor: TwoFactorState | null
  passkeys: PasskeySummary[] | null
  status?: string
  recoveryCodes?: string[]
}) {
  useStatusToast(status, { 'password-updated': 'Password updated.' })
  const form = useForm({ currentPassword: '', password: '', passwordConfirmation: '' })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    form.submit(updatePassword, {
      onSuccess: () => form.reset(),
      onError: ({ errors = {} }) => {
        if (errors.password || errors.passwordConfirmation) form.reset('password', 'passwordConfirmation')
        if (errors.currentPassword) form.reset('currentPassword')
      },
    })
  }
  return (
    <>
      <Section title="Update password" description="Use a long, random password to stay secure. Other devices are signed out when it changes.">
        <form onSubmit={submit} className="space-y-6">
          <FormField label="Current password" error={form.errors.currentPassword}>
            <Input type="password" autoComplete="current-password" value={form.data.currentPassword} onChange={(e) => form.setData('currentPassword', e.target.value)} />
          </FormField>
          <FormField label="New password" error={form.errors.password}>
            <Input type="password" autoComplete="new-password" value={form.data.password} onChange={(e) => form.setData('password', e.target.value)} />
          </FormField>
          <FormField label="Confirm password" error={form.errors.passwordConfirmation}>
            <Input type="password" autoComplete="new-password" value={form.data.passwordConfirmation} onChange={(e) => form.setData('passwordConfirmation', e.target.value)} />
          </FormField>
          <div className="flex items-center gap-4">
            <Button type="submit" loading={form.processing}>
              Save password
            </Button>
          </div>
        </form>
      </Section>
      {twoFactor && <TwoFactor state={twoFactor} recoveryCodes={recoveryCodes} />}
      {passkeys && <Passkeys passkeys={passkeys} />}
    </>
  )
}
