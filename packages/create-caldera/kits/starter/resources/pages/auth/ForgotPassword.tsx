import { Head, useForm, usePage } from '@inertiajs/react'
import type { FormEvent } from 'react'
import { FormField } from '@/components/form-field'
import { TextLink } from '@/components/text-link'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export default function ForgotPassword() {
  const status = usePage().flash.status as string | undefined
  const form = useForm({ email: '' })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    form.post('/forgot-password')
  }
  return (
    <>
      <Head title="Forgot password" />
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

ForgotPassword.layout = { title: 'Forgot password', description: 'Enter your email to receive a password reset link' }
