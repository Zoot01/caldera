'use client'

import { useForm } from '@caldera/next/client'
import { Fingerprint } from 'lucide-react'
import { type FormEvent, useEffect, useState } from 'react'
import { FormField } from '@/components/form-field'
import { TextLink } from '@/components/text-link'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { login } from '@/app/actions/auth'
import { authClient, supportsPasskeys } from '@/lib/auth-client'

export function LoginForm({ canResetPassword, canRegister, passkeys, status, redirectTo }: { canResetPassword: boolean; canRegister: boolean; passkeys: boolean; status?: string; redirectTo?: string }) {
  // `redirect`: the page that sent them here (?redirect=), where they go after signing in.
  const form = useForm({ email: '', password: '', remember: false, redirect: redirectTo })
  const [passkeyError, setPasskeyError] = useState<string>()
  const [withPasskeys, setWithPasskeys] = useState(false)

  // Passkeys: Better Auth's endpoints sign the person in, then on to where they were going.
  const signInWithPasskey = async (autoFill: boolean) => {
    const result = await authClient().signIn.passkey({ autoFill })
    if (!result?.error) return window.location.assign(`/api/login/redirect${redirectTo ? `?redirect=${encodeURIComponent(redirectTo)}` : ''}`)
    if (!autoFill) setPasskeyError('That passkey didn’t work. Try again, or use your password.')
  }
  useEffect(() => {
    if (!passkeys || !supportsPasskeys()) return
    setWithPasskeys(true)
    // Offers saved passkeys in the email field's autofill, where the browser supports it.
    void PublicKeyCredential.isConditionalMediationAvailable?.().then((available) => {
      if (available) void signInWithPasskey(true)
    })
  }, [passkeys])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    form.submit(login, { onFinish: () => form.reset('password') })
  }
  return (
    <>
      {status && <p className="text-center font-medium text-sm text-success-foreground">{status}</p>}
      <form onSubmit={submit} className="flex flex-col gap-6">
        <FormField label="Email address" error={form.errors.email}>
          <Input type="email" autoComplete="username webauthn" autoFocus required placeholder="email@example.com" value={form.data.email} onChange={(e) => form.setData('email', e.target.value)} />
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
      {withPasskeys && (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3 text-muted-foreground text-xs">
            <Separator className="flex-1" />
            or
            <Separator className="flex-1" />
          </div>
          <Button variant="secondary" className="w-full" onClick={() => signInWithPasskey(false)}>
            <Fingerprint className="text-muted-foreground" />
            Continue with a passkey
          </Button>
          {passkeyError && <p className="text-center text-destructive-foreground text-sm">{passkeyError}</p>}
        </div>
      )}
      {canRegister && (
        <p className="text-center text-muted-foreground text-sm">
          Don't have an account? <TextLink href="/register">Sign up</TextLink>
        </p>
      )}
    </>
  )
}

