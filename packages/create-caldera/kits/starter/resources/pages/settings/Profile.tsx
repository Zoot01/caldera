import { Head, router, useForm, usePage } from '@inertiajs/react'
import type { FormEvent } from 'react'
import { DeleteUser } from '@/components/delete-user'
import { FormField } from '@/components/form-field'
import { Section } from '@/components/section'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useStatusToast } from '@/components/flash-toasts'

const saved: Record<string, string> = {
  'profile-updated': 'Profile saved.',
  'email-change-sent': 'Check your new address: the change takes effect once you click the link we sent there.',
  'verification-link-sent': 'A new verification link has been sent to your email address.',
}

export default function Profile({ mustVerifyEmail }: { mustVerifyEmail: boolean }) {
  const page = usePage()
  const user = page.props.auth.user!
  useStatusToast(saved)
  const form = useForm({ name: user.name, email: user.email })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    form.patch('/settings/profile', { preserveScroll: true })
  }
  return (
    <>
      <Head title="Profile settings" />
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
              <Button variant="link" className="h-auto p-0" onClick={() => router.post('/email/verification-notification', {}, { preserveScroll: true })}>
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
      <DeleteUser />
    </>
  )
}

Profile.layout = { breadcrumbs: [{ title: 'Profile settings', href: '/settings/profile' }] }
