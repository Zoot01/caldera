'use client'

import { useForm } from '@caldera-js/next/client'
import { type FormEvent, useState } from 'react'
import { twoFactorChallenge } from '@/app/actions/auth'
import { FormField } from '@/components/form-field'
import { OneTimeCode } from '@/components/one-time-code'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/** After the password, for people with two-factor on: a code from their app, or a recovery code. */
export function TwoFactorChallengeForm({ redirectTo }: { redirectTo?: string }) {
  const [recovery, setRecovery] = useState(false)
  const form = useForm({ code: '', recoveryCode: '', remember: false })
  const submit = (event?: FormEvent) => {
    event?.preventDefault()
    // The recovery code or the app's code, whichever is showing.
    const send = ({ code, recoveryCode, remember }: typeof form.data) =>
      twoFactorChallenge(recovery ? { recoveryCode, remember, redirect: redirectTo } : { code, remember, redirect: redirectTo })
    form.submit(send, { onError: () => form.reset('code', 'recoveryCode') })
  }
  const toggle = () => {
    setRecovery(!recovery)
    form.reset()
    form.clearErrors()
  }
  return (
    <>
      <form onSubmit={submit} className="flex flex-col gap-6">
        {recovery ? (
          <FormField label="Recovery code" error={form.errors.recoveryCode}>
            <Input autoComplete="off" autoFocus placeholder="abcde-fghij" value={form.data.recoveryCode} onChange={(e) => form.setData('recoveryCode', e.target.value)} />
          </FormField>
        ) : (
          <div className="flex flex-col gap-2">
            <OneTimeCode fill value={form.data.code} onChange={(code) => form.setData('code', code)} onComplete={() => submit()} invalid={Boolean(form.errors.code)} autoFocus />
            {form.errors.code && <p className="text-destructive-foreground text-sm">{form.errors.code}</p>}
          </div>
        )}
        <Label className="flex items-center gap-3 font-normal text-muted-foreground">
          <Checkbox checked={form.data.remember} onCheckedChange={(checked) => form.setData('remember', checked === true)} />
          Don't ask again on this device for 30 days
        </Label>
        <Button type="submit" className="w-full" loading={form.processing}>
          Continue
        </Button>
      </form>
      <p className="text-center text-muted-foreground text-sm">
        {recovery ? 'Have your phone? ' : 'Lost your device? '}
        <button type="button" onClick={toggle} className="font-medium text-link underline-offset-4 hover:underline">
          {recovery ? 'Use a code from your app' : 'Use a recovery code'}
        </button>
      </p>
    </>
  )
}

