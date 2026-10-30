import { Head, useForm, usePage } from '@inertiajs/react'
import type { FormEvent } from 'react'
import { FormField } from '@/components/form-field'
import { Heading } from '@/components/heading'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export default function Security() {
  const status = usePage().flash.status
  const form = useForm({ currentPassword: '', password: '', passwordConfirmation: '' })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    form.put('/settings/password', {
      preserveScroll: true,
      onSuccess: () => form.reset(),
      onError: (errors) => {
        if (errors.password || errors.passwordConfirmation) form.reset('password', 'passwordConfirmation')
        if (errors.currentPassword) form.reset('currentPassword')
      },
    })
  }
  return (
    <>
      <Head title="Security settings" />
      <div className="space-y-6">
        <Heading size="small" title="Update password" description="Use a long, random password to stay secure. Other devices are signed out when it changes." />
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
            {status === 'password-updated' && <p className="text-muted-foreground text-sm">Saved.</p>}
          </div>
        </form>
      </div>
    </>
  )
}

Security.layout = { breadcrumbs: [{ title: 'Security settings', href: '/settings/security' }] }
