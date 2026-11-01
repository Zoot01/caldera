import { load } from '@caldera-js/next'
import type { Metadata } from 'next'
import AuthLayout from '@/layouts/auth-layout'
import { http } from '@/src/http'
import { RegisterForm } from './form'

export const metadata: Metadata = { title: 'Register' }

export default async function Page({ searchParams }: { searchParams: Promise<{ redirect?: string }> }) {
  // The route runs its middleware (mw.guest(): signed-in people go home) and gives the page its data.
  const [, { redirect }] = await Promise.all([load(http, '/register'), searchParams])
  return (
    <AuthLayout title="Create an account" description="Enter your details below to create your account">
      <RegisterForm redirectTo={redirect} />
    </AuthLayout>
  )
}
