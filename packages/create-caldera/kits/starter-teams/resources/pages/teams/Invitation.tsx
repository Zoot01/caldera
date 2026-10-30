import { Head, Link, router } from '@inertiajs/react'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'

/** Where the invitation email leads (after signing in): join the team, or decline. */
export default function Invitation({ invitation }: { invitation: { id: string; team: string; inviter: string; role: string } | null }) {
  return (
    <>
      <Head title="Team invitation" />
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
              <Button onClick={() => router.post(`/invitations/${invitation.id}/accept`)}>Join team</Button>
              <Button variant="ghost" onClick={() => router.post(`/invitations/${invitation.id}/reject`)}>
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
