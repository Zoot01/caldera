import { Head, useForm } from '@inertiajs/react'
import type { FormEvent } from 'react'
import { FormField } from '@/components/form-field'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export default function ConfirmPassword() {
  const form = useForm({ password: '' })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    form.post('/confirm-password', { onFinish: () => form.reset('password') })
  }
  return (
    <>
      <Head title="Confirm password" />
      <form onSubmit={submit} className="flex flex-col gap-6">
        <FormField label="Password" error={form.errors.password}>
          <Input type="password" autoComplete="current-password" autoFocus required placeholder="Password" value={form.data.password} onChange={(e) => form.setData('password', e.target.value)} />
        </FormField>
        <Button type="submit" className="w-full" loading={form.processing}>
          Confirm password
        </Button>
      </form>
    </>
  )
}

ConfirmPassword.layout = { title: 'Confirm your password', description: 'This is a secure area of the application. Please confirm your password before continuing.' }
