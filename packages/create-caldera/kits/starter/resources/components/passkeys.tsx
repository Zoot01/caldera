import { router } from '@inertiajs/react'
import { KeyRound, Trash2 } from 'lucide-react'
import { type FormEvent, useEffect, useState } from 'react'
import { Heading } from '@/components/heading'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { authClient, supportsPasskeys } from '@/lib/auth-client'

export interface PasskeySummary {
  id: string
  name: string
  createdAt: string
}

/** Passkeys in Security settings: add one with this device's authenticator, remove old ones. */
export function Passkeys({ passkeys }: { passkeys: PasskeySummary[] }) {
  const [supported, setSupported] = useState(true)
  const [name, setName] = useState('')
  const [error, setError] = useState<string>()
  const [adding, setAdding] = useState(false)
  useEffect(() => setSupported(supportsPasskeys()), [])

  const add = async (event: FormEvent) => {
    event.preventDefault()
    setAdding(true)
    setError(undefined)
    // The browser asks the authenticator (Touch ID, Windows Hello, a phone or key) to make one.
    const result = await authClient().passkey.addPasskey(name.trim() ? { name: name.trim() } : {})
    setAdding(false)
    if (result?.error) return setError(result.error.message ?? 'The passkey wasn’t added.')
    setName('')
    router.reload({ only: ['passkeys'] })
  }

  return (
    <div className="space-y-6">
      <Heading size="small" title="Passkeys" description="Sign in with your fingerprint, face or screen lock instead of a password." />
      {passkeys.length > 0 && (
        <ul className="divide-y rounded-xl border">
          {passkeys.map((passkey) => (
            <li key={passkey.id} className="flex items-center gap-3 px-4 py-3">
              <KeyRound className="size-4 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-sm">{passkey.name}</p>
                <p className="text-muted-foreground text-xs">Added {new Date(passkey.createdAt).toLocaleDateString()}</p>
              </div>
              <Button variant="ghost" size="icon-sm" aria-label={`Remove ${passkey.name}`} onClick={() => router.delete(`/settings/passkeys/${passkey.id}`, { preserveScroll: true })}>
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {supported ? (
        <form onSubmit={add} className="flex flex-col gap-3 sm:flex-row">
          <Input placeholder="Name (e.g. MacBook)" aria-label="Passkey name" value={name} onChange={(e) => setName(e.target.value)} className="sm:max-w-60" />
          <Button type="submit" variant="outline" loading={adding}>
            Add a passkey
          </Button>
        </form>
      ) : (
        <p className="text-muted-foreground text-sm">This browser doesn't support passkeys.</p>
      )}
      {error && <p className="text-destructive-foreground text-sm">{error}</p>}
    </div>
  )
}
