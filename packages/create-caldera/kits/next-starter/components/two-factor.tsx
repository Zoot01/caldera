'use client'

import { useForm } from '@caldera-js/next/client'
import { Check, Copy, Download, ShieldCheck, Smartphone, TriangleAlert } from 'lucide-react'
import { type FormEvent, type ReactNode, useState } from 'react'
import { cancelTwoFactorSetup, confirmTwoFactor, disableTwoFactor, enableTwoFactor, newRecoveryCodes } from '@/app/actions/settings'
import { useKept } from '@/components/flash-toasts'
import { Section } from '@/components/section'
import { useShared } from '@/components/shared'
import { OneTimeCode } from '@/components/one-time-code'
import { PasswordDialog } from '@/components/password-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

export interface TwoFactorState {
  enabled: boolean
  /** While turning it on: the QR code (SVG) for the authenticator app, and the key to type instead. */
  setup: { qr: string; key: string } | null
}

/** Two-factor authentication in Security settings: turn on (scan, confirm a code), recovery codes, turn off. */
export function TwoFactor({ state, recoveryCodes: flashed }: { state: TwoFactorState; recoveryCodes?: string[] }) {
  // Flashed once, right after they're made: kept on screen until the page is left.
  const recoveryCodes = useKept(flashed)
  return (
    <Section title="Two-factor authentication" description="A code from an app on your phone, as well as your password, whenever you sign in with it.">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/60 text-muted-foreground">
            <Smartphone className="size-4.5" />
          </span>
          <div className="min-w-0 space-y-1">
            <p className="flex items-center gap-2 font-medium text-sm">
              Authenticator app
              {state.enabled ? (
                <Badge variant="success">
                  <ShieldCheck />
                  On
                </Badge>
              ) : (
                <Badge variant="outline">Off</Badge>
              )}
            </p>
            <p className="text-muted-foreground text-sm">Works with any app that makes six-digit codes.</p>
            {!state.setup && !state.enabled && (
              <ul className="flex flex-wrap gap-1.5 pt-1" aria-label="For example">
                {['1Password', 'Google Authenticator', 'Authy', 'Microsoft Authenticator'].map((app) => (
                  <li key={app} className="rounded-md border px-1.5 py-0.5 text-muted-foreground text-xs">
                    {app}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        {!state.enabled && !state.setup && (
          <PasswordDialog
            trigger={<Button variant="outline" aria-label="Turn on two-factor authentication" className="shrink-0" />}
            label="Set up"
            title="Turn on two-factor authentication"
            description="Enter your password to start. You'll scan a QR code with your authenticator app next."
            action={enableTwoFactor}
            submit="Continue"
          />
        )}
        {state.enabled && (
          <div className="flex shrink-0 flex-wrap gap-2">
            <PasswordDialog
              trigger={<Button variant="outline" />}
              label="New recovery codes"
              title="New recovery codes"
              description="Your current recovery codes stop working. Enter your password to make new ones."
              action={newRecoveryCodes}
              submit="Make new codes"
            />
            <PasswordDialog
              trigger={<Button variant="destructive-outline" />}
              label="Turn off"
              title="Turn off two-factor authentication?"
              description="Signing in will only need your password. Enter it to confirm."
              action={disableTwoFactor}
              submit="Turn off"
              destructive
            />
          </div>
        )}
      </div>
      {state.enabled && recoveryCodes && <RecoveryCodes codes={recoveryCodes} />}
      {!state.enabled && state.setup && <Setup setup={state.setup} />}
    </Section>
  )
}

function Setup({ setup }: { setup: NonNullable<TwoFactorState['setup']> }) {
  const form = useForm({ code: '' })
  const [copied, setCopied] = useState(false)
  const confirm = (event?: FormEvent) => {
    event?.preventDefault()
    form.submit(confirmTwoFactor, { onError: () => form.reset() })
  }
  const copy = async () => {
    await navigator.clipboard.writeText(setup.key)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <ol className="space-y-6 border-t pt-6">
      <Step number={1} title="Scan the QR code" description="Open your authenticator app and add an account with its camera.">
        <div className="flex flex-col items-start gap-5 sm:flex-row sm:items-center">
          {/* The QR code is made on the server from your own secret (uqr); white, so phones can read it in dark mode. */}
          <div className="size-36 shrink-0 rounded-lg border bg-white p-2 [&_svg]:size-full" dangerouslySetInnerHTML={{ __html: setup.qr }} />
          <div className="min-w-0 flex-1 space-y-2">
            <p className="text-muted-foreground text-sm">Can’t scan it? Enter this key instead.</p>
            <div className="flex items-start gap-2">
              {/* In groups of four, to type easily; the text is still the one key (and Copy copies that). */}
              <code className="flex min-w-0 max-w-sm flex-wrap gap-x-2 gap-y-0.5 rounded-md border bg-muted/60 px-2.5 py-1.5 font-mono text-xs tracking-wide">
                {setup.key.match(/.{1,4}/g)!.map((group, index) => (
                  <span key={index}>
                    {group}
                  </span>
                ))}
              </code>
              <Button type="button" variant="ghost" size="icon-sm" onClick={copy} aria-label="Copy the setup key" title="Copy">
                {copied ? <Check /> : <Copy />}
              </Button>
            </div>
          </div>
        </div>
      </Step>
      <Step number={2} title="Enter the code" description="Type the 6-digit code your app shows for this account.">
        <form onSubmit={confirm} className="space-y-4">
          <OneTimeCode value={form.data.code} onChange={(code) => form.setData('code', code)} onComplete={() => confirm()} invalid={Boolean(form.errors.code)} autoFocus />
          {form.errors.code && <p className="text-destructive-foreground text-sm">{form.errors.code}</p>}
          <div className="flex gap-2">
            <Button type="submit" loading={form.processing}>
              Confirm
            </Button>
            <Button type="button" variant="outline" onClick={() => void cancelTwoFactorSetup()}>
              Cancel
            </Button>
          </div>
        </form>
      </Step>
    </ol>
  )
}

/** One step of setting up: its number in a circle, a heading, and what to do. */
function Step({ number, title, description, children }: { number: number; title: string; description: string; children: ReactNode }) {
  return (
    <li className="flex gap-4">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full border font-medium text-muted-foreground text-xs">{number}</span>
      <div className="min-w-0 flex-1 space-y-3">
        <div className="space-y-0.5">
          <p className="font-medium text-sm">{title}</p>
          <p className="text-muted-foreground text-sm">{description}</p>
        </div>
        {children}
      </div>
    </li>
  )
}

function RecoveryCodes({ codes }: { codes: string[] }) {
  const { appName } = useShared()
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(codes.join('\n'))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  // A text file to keep somewhere safe: what the codes are for, then one per line.
  const download = () => {
    const text = `${appName} recovery codes\nEach one signs you in once if you lose your authenticator app.\n\n${codes.join('\n')}\n`
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
    const link = Object.assign(document.createElement('a'), { href: url, download: `${appName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-recovery-codes.txt` })
    link.click()
    URL.revokeObjectURL(url)
  }
  return (
    <div className="space-y-4 border-t pt-5">
      <div className="flex items-start gap-3">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
        <div className="space-y-0.5">
          <p className="font-medium text-sm">Save your recovery codes</p>
          <p className="text-muted-foreground text-sm">Each one signs you in once if you lose your device. They won’t be shown again.</p>
        </div>
      </div>
      <ul className="grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-lg border bg-muted/60 px-4 py-3 font-mono text-[13px] sm:grid-cols-2">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={download}>
          <Download />
          Download
        </Button>
        <Button variant="outline" size="sm" onClick={copy}>
          {copied ? <Check /> : <Copy />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  )
}
