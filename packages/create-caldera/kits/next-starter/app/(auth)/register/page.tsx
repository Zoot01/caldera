import { load } from '@caldera/next'
import type { Metadata } from 'next'
import AuthLayout from '@/layouts/auth-layout'
import { http } from '@/src/http'
import { RegisterForm } from './form'

export const metadata: Metadata = { title: 'Register' }

export default async function Page() {
  // The route runs its middleware (mw.guest(): signed-in people go home) and gives the page its data.
  await load(http, '/register')
  return (
    <AuthLayout title="Create an account" description="Enter your details below to create your account">
      <RegisterForm />
    </AuthLayout>
  )
}
