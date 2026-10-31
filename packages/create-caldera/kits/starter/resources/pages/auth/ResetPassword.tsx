import { Head, useForm } from '@inertiajs/react'
import type { FormEvent } from 'react'
import { FormField } from '@/components/form-field'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export default function ResetPassword({ token }: { token: string }) {
  const form = useForm({ token, password: '', passwordConfirmation: '' })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    form.post('/reset-password', { onFinish: () => form.reset('password', 'passwordConfirmation') })
  }
  return (
    <>
      <Head title="Reset password" />
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

ResetPassword.layout = { title: 'Reset password', description: 'Choose a new password for your account' }
