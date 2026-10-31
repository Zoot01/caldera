import { router, useForm, usePage } from '@inertiajs/react'
import { Check, Copy, ShieldCheck } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { Section } from '@/components/section'
import { OneTimeCode } from '@/components/one-time-code'
import { PasswordDialog } from '@/components/password-dialog'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

export interface TwoFactorState {
  enabled: boolean
  /** While turning it on: the QR code (SVG) for the authenticator app, and the key to type instead. */
  setup: { qr: string; key: string } | null
}

/** Two-factor authentication in Security settings: turn on (scan, confirm a code), recovery codes, turn off. */
export function TwoFactor({ state }: { state: TwoFactorState }) {
  const recoveryCodes = usePage().flash.recoveryCodes as string[] | undefined
  return (
    <Section title="Two-factor authentication" description="Ask for a code from an authenticator app (1Password, Google Authenticator, Authy…) when signing in with a password.">
      {state.enabled ? (
        <>
          <p className="flex items-center gap-2 font-medium text-sm text-success-foreground">
            <ShieldCheck className="size-4" /> Two-factor authentication is on.
          </p>
          {recoveryCodes && <RecoveryCodes codes={recoveryCodes} />}
          <div className="flex flex-wrap gap-3">
            <PasswordDialog
              trigger={<Button variant="outline" />}
              label="New recovery codes"
              title="New recovery codes"
              description="Your current recovery codes stop working. Enter your password to make new ones."
              method="post"
              url="/settings/two-factor/recovery-codes"
              submit="Make new codes"
            />
            <PasswordDialog
              trigger={<Button variant="destructive-outline" />}
              label="Turn off"
              title="Turn off two-factor authentication?"
              description="Signing in will only need your password. Enter it to confirm."
              method="delete"
              url="/settings/two-factor"
              submit="Turn off"
              destructive
            />
          </div>
        </>
      ) : state.setup ? (
        <Setup setup={state.setup} />
      ) : (
        <PasswordDialog
          trigger={<Button />}
          label="Turn on two-factor authentication"
          title="Turn on two-factor authentication"
          description="Enter your password to start. You'll scan a QR code with your authenticator app next."
          method="post"
          url="/settings/two-factor"
          submit="Continue"
        />
      )}
    </Section>
  )
}

function Setup({ setup }: { setup: NonNullable<TwoFactorState['setup']> }) {
  const form = useForm({ code: '' })
  const confirm = (event?: FormEvent) => {
    event?.preventDefault()
    form.post('/settings/two-factor/confirm', { preserveScroll: true, onError: () => form.reset() })
  }
  return (
    <div className="space-y-6 rounded-xl border p-6">
      <ol className="list-decimal space-y-1 ps-5 text-muted-foreground text-sm">
        <li>Scan this QR code with your authenticator app (or type in the key below).</li>
        <li>Enter the 6-digit code it shows.</li>
      </ol>
      <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
        {/* The QR code is made on the server from your own secret (uqr); white, so phones can read it in dark mode. */}
        <div className="size-40 shrink-0 rounded-lg bg-white p-2 [&_svg]:size-full" dangerouslySetInnerHTML={{ __html: setup.qr }} />
        <div className="min-w-0 space-y-1">
          <p className="text-muted-foreground text-xs">Setup key</p>
          <code className="block break-all rounded-md bg-muted px-2 py-1 font-mono text-sm">{setup.key}</code>
        </div>
      </div>
      <form onSubmit={confirm} className="space-y-3">
        <OneTimeCode value={form.data.code} onChange={(code) => form.setData('code', code)} onComplete={() => confirm()} invalid={Boolean(form.errors.code)} autoFocus />
        {form.errors.code && <p className="text-destructive-foreground text-sm">{form.errors.code}</p>}
        <div className="flex gap-3">
          <Button type="submit" loading={form.processing}>
            Confirm
          </Button>
          <Button type="button" variant="ghost" onClick={() => router.delete('/settings/two-factor/setup', { preserveScroll: true })}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  )
}

function RecoveryCodes({ codes }: { codes: string[] }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(codes.join('\n'))
    setCopied(true)
  }
  return (
    <Alert variant="warning">
      <AlertTitle>Save your recovery codes</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>Each one signs you in once if you lose your device. They won't be shown again.</p>
        <ul className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-sm text-foreground">
          {codes.map((code) => (
            <li key={code}>{code}</li>
          ))}
        </ul>
        <Button variant="outline" size="sm" className="w-fit" onClick={copy}>
          {copied ? <Check /> : <Copy />}
          {copied ? 'Copied' : 'Copy codes'}
        </Button>
      </AlertDescription>
    </Alert>
  )
}
