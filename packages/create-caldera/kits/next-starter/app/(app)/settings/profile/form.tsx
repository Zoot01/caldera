'use client'

import { useForm } from '@caldera/next/client'
import type { FormEvent } from 'react'
import { resendVerification } from '@/app/actions/auth'
import { updateProfile } from '@/app/actions/settings'
import { useStatusToast } from '@/components/flash-toasts'
import { FormField } from '@/components/form-field'
import { Section } from '@/components/section'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

const saved: Record<string, string> = {
  'profile-updated': 'Profile saved.',
  'email-change-sent': 'Check your new address: the change takes effect once you click the link we sent there.',
  'verification-link-sent': 'A new verification link has been sent to your email address.',
}

export function ProfileForm({
  user,
  mustVerifyEmail,
  status,
}: {
  user: { name: string; email: string; emailVerified: boolean }
  mustVerifyEmail: boolean
  status?: string
}) {
  useStatusToast(status, saved)
  const form = useForm({ name: user.name, email: user.email })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    form.submit(updateProfile)
  }
  return (
    <Section title="Profile" description="Update your name and email address">
      <form onSubmit={submit} className="space-y-6">
        <FormField label="Name" error={form.errors.name}>
          <Input autoComplete="name" required value={form.data.name} onChange={(e) => form.setData('name', e.target.value)} />
        </FormField>
        <FormField label="Email address" error={form.errors.email}>
          <Input type="email" autoComplete="username" required value={form.data.email} onChange={(e) => form.setData('email', e.target.value)} />
        </FormField>
        {mustVerifyEmail && !user.emailVerified && (
          <p className="text-muted-foreground text-sm">
            Your email address is unverified.{' '}
            <Button variant="link" className="h-auto p-0" onClick={() => void resendVerification()}>
              Click here to resend the verification email.
            </Button>
          </p>
        )}
        <div className="flex items-center gap-4">
          <Button type="submit" loading={form.processing}>
            Save
          </Button>
        </div>
      </form>
    </Section>
  )
}
