import { load } from '@caldera-js/next'
import type { Metadata } from 'next'
import type { PasskeySummary } from '@/components/passkeys'
import type { TwoFactorState } from '@/components/two-factor'
import { flash } from '@/lib/caldera'
import { http } from '@/src/http'
import { SecurityForm } from './form'

export const metadata: Metadata = { title: 'Security settings' }

export default async function Security() {
  // mw.passwordConfirmed() on the route: without the password typed recently, /confirm-password first.
  // twoFactor and passkeys are null when turned off in src/config/auth.ts.
  const [{ recoveryCodes, ...props }, { status }] = await Promise.all([
    load<{ twoFactor: TwoFactorState | null; passkeys: PasskeySummary[] | null; recoveryCodes: string[] | null }>(http, '/settings/security'),
    flash(),
  ])
  return <SecurityForm {...props} status={status} recoveryCodes={recoveryCodes ?? undefined} />
}
