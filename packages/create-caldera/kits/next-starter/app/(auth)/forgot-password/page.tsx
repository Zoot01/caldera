import { load } from '@caldera/next'
import type { Metadata } from 'next'
import { flash } from '@/lib/caldera'
import { ClearFlash } from '@/components/flash-toasts'
import AuthLayout from '@/layouts/auth-layout'
import { http } from '@/src/http'
import { ForgotPasswordForm } from './form'

export const metadata: Metadata = { title: 'Forgot password' }

export default async function Page() {
  // The route runs its middleware (mw.guest(): signed-in people go home) and gives the page its data.
  const [, { status }] = await Promise.all([load(http, '/forgot-password'), flash()])
  return (
    <AuthLayout title="Forgot password" description="Enter your email to receive a password reset link">
      <ForgotPasswordForm status={status} />
      <ClearFlash when={status} />
    </AuthLayout>
  )
}
