import { Head, router, useForm, usePage } from '@inertiajs/react'
import type { FormEvent } from 'react'
import { Button } from '@/components/ui/button'

export default function VerifyEmail() {
  const status = usePage().flash.status as string | undefined
  const form = useForm({})
  const submit = (event: FormEvent) => {
    event.preventDefault()
    form.post('/email/verification-notification')
  }
  return (
    <>
      <Head title="Email verification" />
      {status === 'verification-link-sent' && (
        <p className="text-center font-medium text-sm text-success-foreground">A new verification link has been sent to the email address you gave when registering.</p>
      )}
      <form onSubmit={submit} className="flex flex-col items-center gap-4 text-center">
        <Button type="submit" variant="secondary" loading={form.processing}>
          Resend verification email
        </Button>
        <Button type="button" variant="link" onClick={() => router.post('/logout')}>
          Log out
        </Button>
      </form>
    </>
  )
}

VerifyEmail.layout = { title: 'Verify your email', description: 'Click the link we emailed you to confirm your address.' }
