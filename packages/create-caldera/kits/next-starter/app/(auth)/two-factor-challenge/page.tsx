import { load } from '@caldera/next'
import type { Metadata } from 'next'
import AuthLayout from '@/layouts/auth-layout'
import { http } from '@/src/http'
import { TwoFactorChallengeForm } from './form'

export const metadata: Metadata = { title: 'Two-factor authentication' }

export default async function Page({ searchParams }: { searchParams: Promise<{ redirect?: string }> }) {
  // The route runs its middleware (mw.guest(): signed-in people go home) and gives the page its data.
  const [, { redirect }] = await Promise.all([load(http, '/two-factor-challenge'), searchParams])
  return (
    <AuthLayout title="Two-factor authentication" description="Enter the code from your authenticator app.">
      <TwoFactorChallengeForm redirectTo={redirect} />
    </AuthLayout>
  )
}
