'use client'

import { useForm } from '@caldera/next/client'
import type { FormEvent } from 'react'
import { register } from '@/app/actions/auth'
import { FormField } from '@/components/form-field'
import { TextLink } from '@/components/text-link'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function RegisterForm() {
  const form = useForm({ name: '', email: '', password: '', passwordConfirmation: '' })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    form.submit(register, { onFinish: () => form.reset('password', 'passwordConfirmation') })
  }
  return (
    <>
      <form onSubmit={submit} className="flex flex-col gap-6">
        <FormField label="Name" error={form.errors.name}>
          <Input autoComplete="name" autoFocus required placeholder="Full name" value={form.data.name} onChange={(e) => form.setData('name', e.target.value)} />
        </FormField>
        <FormField label="Email address" error={form.errors.email}>
          <Input type="email" autoComplete="email" required placeholder="email@example.com" value={form.data.email} onChange={(e) => form.setData('email', e.target.value)} />
        </FormField>
        <FormField label="Password" error={form.errors.password}>
          <Input type="password" autoComplete="new-password" required placeholder="Password" value={form.data.password} onChange={(e) => form.setData('password', e.target.value)} />
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
          Create account
        </Button>
      </form>
      <p className="text-center text-muted-foreground text-sm">
        Already have an account? <TextLink href="/login">Log in</TextLink>
      </p>
    </>
  )
}

