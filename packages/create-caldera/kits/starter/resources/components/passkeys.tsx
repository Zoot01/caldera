import { router } from '@inertiajs/react'
import { Fingerprint, KeyRound, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Section } from '@/components/section'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { authClient, supportsPasskeys } from '@/lib/auth-client'

export interface PasskeySummary {
  id: string
  name: string
  createdAt: string
}

/** A name for a passkey made here, from the browser and system: "Chrome on Mac", "Safari on iPhone". */
function deviceName(): string {
  const ua = navigator.userAgent
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser'
  const system = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : ''
  return system ? `${browser} on ${system}` : browser
}

/** Passkeys in Security settings: add one with this device's authenticator (named after it), remove old ones. */
export function Passkeys({ passkeys }: { passkeys: PasskeySummary[] }) {
  const [supported, setSupported] = useState(true)
  const [error, setError] = useState<string>()
  const [adding, setAdding] = useState(false)
  useEffect(() => setSupported(supportsPasskeys()), [])

  const add = async () => {
    setAdding(true)
    setError(undefined)
    // The browser asks the authenticator (Touch ID, Windows Hello, a phone or key) to make one.
    const result = await authClient().passkey.addPasskey({ name: deviceName() })
    setAdding(false)
    if (result?.error) return setError(result.error.message ?? 'The passkey wasn’t added.')
    router.reload({ only: ['passkeys'] })
  }

  return (
    <Section title="Passkeys" description="Sign in with your fingerprint, face or screen lock instead of a password.">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/60 text-muted-foreground">
            <Fingerprint className="size-4.5" />
          </span>
          <div className="min-w-0 space-y-1">
            <p className="flex items-center gap-2 font-medium text-sm">
              Passkeys
              <Badge variant={passkeys.length > 0 ? 'success' : 'outline'}>{passkeys.length > 0 ? passkeys.length : 'None yet'}</Badge>
            </p>
            <p className="text-muted-foreground text-sm">{supported ? 'Each device or password manager can have its own.' : 'This browser doesn’t support passkeys.'}</p>
          </div>
        </div>
        {supported && (
          <Button variant="outline" className="shrink-0" loading={adding} onClick={add}>
            <Plus />
            Add a passkey
          </Button>
        )}
      </div>
      {error && <p className="text-destructive-foreground text-sm">{error}</p>}
      {passkeys.length > 0 && (
        <ul className="divide-y rounded-lg border">
          {passkeys.map((passkey) => (
            <li key={passkey.id} className="flex min-h-12 items-center gap-3 py-2 ps-3 pe-2 text-sm">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full border text-muted-foreground">
                <KeyRound className="size-3" />
              </span>
              <span className="min-w-0 flex-1 truncate font-medium">{passkey.name}</span>
              <span className="text-muted-foreground">Added {new Date(passkey.createdAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}</span>
              <Button variant="ghost" size="icon-sm" aria-label={`Remove ${passkey.name}`} title="Remove" onClick={() => router.delete(`/settings/passkeys/${passkey.id}`, { preserveScroll: true })}>
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}
