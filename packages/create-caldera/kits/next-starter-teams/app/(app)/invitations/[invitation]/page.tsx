import { load } from '@caldera-js/next'
import type { Metadata } from 'next'
import { http } from '@/src/http'
import { Invitation } from './invitation'

export const metadata: Metadata = { title: 'Team invitation' }

/** Where the invitation email leads. Signed-out people sign in (or register) first, and come back here. */
export default async function InvitationPage({ params }: { params: Promise<{ invitation: string }> }) {
  const { invitation } = await params
  const props = await load<{ invitation: { id: string; team: string; inviter: string; role: string } | null }>(http, `/invitations/${encodeURIComponent(invitation)}`)
  return <Invitation {...props} />
}
