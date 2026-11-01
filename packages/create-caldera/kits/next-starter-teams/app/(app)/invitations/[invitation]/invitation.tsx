'use client'

import Link from 'next/link'
import { acceptInvitation, rejectInvitation } from '@/app/actions/teams'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'

/** Where the invitation email leads (after signing in): join the team, or decline. */
export function Invitation({ invitation }: { invitation: { id: string; team: string; inviter: string; role: string } | null }) {
  return (
    <>
      <div className="mx-auto w-full max-w-md py-12">
        {invitation ? (
          <Card>
            <CardHeader>
              <CardTitle>Join {invitation.team}?</CardTitle>
              <CardDescription>
                {invitation.inviter} invited you as {invitation.role === 'admin' ? 'an admin' : 'a member'}.
              </CardDescription>
            </CardHeader>
            <CardFooter className="gap-2">
              <Button onClick={() => void acceptInvitation(invitation.id)}>Join team</Button>
              <Button variant="ghost" onClick={() => void rejectInvitation(invitation.id)}>
                Decline
              </Button>
            </CardFooter>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>This invitation can’t be used</CardTitle>
              <CardDescription>It may have expired, been cancelled, or been sent to a different email address than the one you're signed in with.</CardDescription>
            </CardHeader>
            <CardFooter>
              <Button variant="outline" render={<Link href="/dashboard" />}>
                Go to your dashboard
              </Button>
            </CardFooter>
          </Card>
        )}
      </div>
    </>
  )
}
