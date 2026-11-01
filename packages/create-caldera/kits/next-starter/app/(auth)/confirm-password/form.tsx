'use client'

import { useForm } from '@caldera/next/client'
import { KeyRound } from 'lucide-react'
import { type FormEvent, useEffect, useState } from 'react'
import { FormField } from '@/components/form-field'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { confirmPassword } from '@/app/actions/auth'
import { authClient, supportsPasskeys } from '@/lib/auth-client'

export function ConfirmPasswordForm({ passkeys, redirectTo }: { passkeys: boolean; redirectTo?: string }) {
  const form = useForm({ password: '', redirect: redirectTo })
  const [withPasskey, setWithPasskey] = useState(false)
  const [passkeyError, setPasskeyError] = useState<string>()
  useEffect(() => setWithPasskey(passkeys && supportsPasskeys()), [passkeys])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    form.submit(confirmPassword, { onFinish: () => form.reset('password') })
  }
  // Better Auth checks the passkey (only this person's are offered) and counts it as the password;
  // then on to the page that asked.
  const confirmWithPasskey = async () => {
    const result = await authClient().signIn.passkey()
    if (!result?.error) return window.location.assign(`/api/login/redirect${redirectTo ? `?redirect=${encodeURIComponent(redirectTo)}` : ''}`)
    setPasskeyError('That passkey didn’t work. Try again, or use your password.')
  }
  return (
    <>
      <form onSubmit={submit} className="flex flex-col gap-6">
        <FormField label="Password" error={form.errors.password}>
          <Input type="password" autoComplete="current-password" autoFocus required placeholder="Password" value={form.data.password} onChange={(e) => form.setData('password', e.target.value)} />
        </FormField>
        <Button type="submit" className="w-full" loading={form.processing}>
          Confirm password
        </Button>
      </form>
      {withPasskey && (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3 text-muted-foreground text-xs">
            <Separator className="flex-1" />
            or
            <Separator className="flex-1" />
          </div>
          <Button variant="outline" className="w-full" onClick={confirmWithPasskey}>
            <KeyRound />
            Use a passkey
          </Button>
          {passkeyError && <p className="text-center text-destructive-foreground text-sm">{passkeyError}</p>}
        </div>
      )}
    </>
  )
}

