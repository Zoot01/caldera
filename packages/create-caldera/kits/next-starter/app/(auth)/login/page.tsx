import { load } from '@caldera/next'
import type { Metadata } from 'next'
import { flash } from '@/lib/caldera'
import { ClearFlash } from '@/components/flash-toasts'
import AuthLayout from '@/layouts/auth-layout'
import { http } from '@/src/http'
import { LoginForm } from './form'

export const metadata: Metadata = { title: 'Log in' }

export default async function Page({ searchParams }: { searchParams: Promise<{ redirect?: string }> }) {
  // The route runs its middleware (mw.guest(): signed-in people go home) and gives the page its data.
  const [props, { status }, { redirect }] = await Promise.all([load<{ canResetPassword: boolean; canRegister: boolean; passkeys: boolean }>(http, '/login'), flash(), searchParams])
  return (
    <AuthLayout title="Log in to your account" description="Enter your email and password below to log in">
      <LoginForm {...props} status={status} redirectTo={redirect} />
      <ClearFlash when={status} />
    </AuthLayout>
  )
}
