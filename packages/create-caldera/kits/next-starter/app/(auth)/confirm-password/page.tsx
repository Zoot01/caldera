import { load } from '@caldera-js/next'
import type { Metadata } from 'next'
import AuthLayout from '@/layouts/auth-layout'
import { http } from '@/src/http'
import { ConfirmPasswordForm } from './form'

export const metadata: Metadata = { title: 'Confirm password' }

export default async function Page({ searchParams }: { searchParams: Promise<{ redirect?: string }> }) {
  // The route runs its middleware (mw.auth(): signed in) and gives the page its data.
  const [{ passkeys }, { redirect }] = await Promise.all([load<{ passkeys: boolean }>(http, '/confirm-password'), searchParams])
  return (
    <AuthLayout title="Confirm your password" description="This is a secure area of the application. Please confirm your password before continuing.">
      <ConfirmPasswordForm passkeys={passkeys} redirectTo={redirect} />
    </AuthLayout>
  )
}
