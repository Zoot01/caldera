'use client'

import { useForm } from '@caldera-js/next/client'
import type { FormEvent } from 'react'
import { logout, resendVerification } from '@/app/actions/auth'
import { Button } from '@/components/ui/button'

export function VerifyEmailForm({ status }: { status?: string }) {
  const form = useForm({})
  const submit = (event: FormEvent) => {
    event.preventDefault()
    form.submit(resendVerification)
  }
  return (
    <>
      {status === 'verification-link-sent' && (
        <p className="text-center font-medium text-sm text-success-foreground">A new verification link has been sent to the email address you gave when registering.</p>
      )}
      <form onSubmit={submit} className="flex flex-col items-center gap-4 text-center">
        <Button type="submit" variant="secondary" loading={form.processing}>
          Resend verification email
        </Button>
        <Button type="button" variant="link" onClick={() => void logout()}>
          Log out
        </Button>
      </form>
    </>
  )
}

