import { load } from '@caldera-js/next'
import type { Metadata } from 'next'
import { DeleteUser } from '@/components/delete-user'
import { flash, requireUser } from '@/lib/caldera'
import { http } from '@/src/http'
import { ProfileForm } from './form'

export const metadata: Metadata = { title: 'Profile settings' }

export default async function Profile() {
  const { mustVerifyEmail } = await load<{ mustVerifyEmail: boolean }>(http, '/settings/profile')
  const [user, { status }] = await Promise.all([requireUser(), flash()])
  return (
    <>
      <ProfileForm user={{ name: user.name, email: user.email, emailVerified: user.emailVerified }} mustVerifyEmail={mustVerifyEmail} status={status} />
      <DeleteUser />
    </>
  )
}
