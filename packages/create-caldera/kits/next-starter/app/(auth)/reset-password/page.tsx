import { load } from '@caldera/next'
import type { Metadata } from 'next'
import AuthLayout from '@/layouts/auth-layout'
import { http } from '@/src/http'
import { ResetPasswordForm } from './form'

export const metadata: Metadata = { title: 'Reset password' }

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  // The route runs its middleware (mw.guest(): signed-in people go home) and gives the page its data.
  const { token } = await load<{ token: string }>(http, `/reset-password?${new URLSearchParams(await searchParams)}`)
  return (
    <AuthLayout title="Reset password" description="Choose a new password for your account">
      <ResetPasswordForm token={token} />
    </AuthLayout>
  )
}
