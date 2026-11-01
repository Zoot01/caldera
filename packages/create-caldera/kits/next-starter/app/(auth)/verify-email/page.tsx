import { load } from '@caldera-js/next'
import type { Metadata } from 'next'
import { flash } from '@/lib/caldera'
import { ClearFlash } from '@/components/flash-toasts'
import AuthLayout from '@/layouts/auth-layout'
import { http } from '@/src/http'
import { VerifyEmailForm } from './form'

export const metadata: Metadata = { title: 'Email verification' }

export default async function Page() {
  // The route runs its middleware (mw.auth(): signed in) and gives the page its data.
  const [, { status }] = await Promise.all([load(http, '/verify-email'), flash()])
  return (
    <AuthLayout title="Verify your email" description="Click the link we emailed you to confirm your address.">
      <VerifyEmailForm status={status} />
      <ClearFlash when={status} />
    </AuthLayout>
  )
}
