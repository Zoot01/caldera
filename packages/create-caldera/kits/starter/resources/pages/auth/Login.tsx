import { Head, useForm, usePage } from '@inertiajs/react'
import type { FormEvent } from 'react'
import { FormField } from '@/components/form-field'
import { TextLink } from '@/components/text-link'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export default function Login({ canResetPassword, canRegister }: { canResetPassword: boolean; canRegister: boolean }) {
  const status = usePage().flash.status as string | undefined
  const form = useForm({ email: '', password: '', remember: false })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    form.post('/login', { onFinish: () => form.reset('password') })
  }
  return (
    <>
      <Head title="Log in" />
      {status && <p className="text-center font-medium text-sm text-success-foreground">{status}</p>}
      <form onSubmit={submit} className="flex flex-col gap-6">
        <FormField label="Email address" error={form.errors.email}>
          <Input type="email" autoComplete="email" autoFocus required placeholder="email@example.com" value={form.data.email} onChange={(e) => form.setData('email', e.target.value)} />
        </FormField>
        <FormField
          label="Password"
          error={form.errors.password}
          aside={
            canResetPassword && (
              <TextLink href="/forgot-password" className="text-sm">
                Forgot password?
              </TextLink>
            )
          }
        >
          <Input type="password" autoComplete="current-password" required placeholder="Password" value={form.data.password} onChange={(e) => form.setData('password', e.target.value)} />
        </FormField>
        <Label className="flex items-center gap-3">
          <Checkbox checked={form.data.remember} onCheckedChange={(checked) => form.setData('remember', checked === true)} />
          Remember me
        </Label>
        <Button type="submit" className="w-full" loading={form.processing}>
          Log in
        </Button>
      </form>
      {canRegister && (
        <p className="text-center text-muted-foreground text-sm">
          Don't have an account? <TextLink href="/register">Sign up</TextLink>
        </p>
      )}
    </>
  )
}

Login.layout = { title: 'Log in to your account', description: 'Enter your email and password below to log in' }
