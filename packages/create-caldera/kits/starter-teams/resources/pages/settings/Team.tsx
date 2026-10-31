import { Head, router, useForm, usePage } from '@inertiajs/react'
import { MoreHorizontal } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { FormField } from '@/components/form-field'
import { Heading } from '@/components/heading'
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from '@/components/ui/menu'

interface Props {
  team: { id: string; name: string; personal: boolean }
  members: { id: string; name: string; email: string; role: string; you: boolean }[]
  invitations: { id: string; email: string; role: string; expiresAt: string }[]
  can: { update: boolean; invite: boolean; manageMembers: boolean; transfer: boolean; delete: boolean; leave: boolean }
}

const statuses: Record<string, string> = {
  'team-created': 'Team created: it’s your current team now.',
  'team-updated': 'Saved.',
  'invitation-sent': 'Invitation sent.',
  'member-removed': 'Removed from the team.',
  'ownership-transferred': 'The team has a new owner. You’re an admin now.',
}
const roleNames: Record<string, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' }
// The roles given from the member menu; owner is handed over instead.
const assignable = ['admin', 'member'] as const

export default function Team({ team, members, invitations, can }: Props) {
  const status = statuses[String(usePage().flash.status ?? '')]
  const rename = useForm({ name: team.name })
  const invite = useForm({ email: '', role: 'member' as 'admin' | 'member' })
  const base = `/settings/teams/${team.id}`
  const [newOwner, setNewOwner] = useState<Props['members'][number]>()
  return (
    <>
      <Head title={team.name} />
      <div className="space-y-6">
        <Heading size="small" title={team.name} description={team.personal ? 'Your personal team. Others can’t be invited to it; make a new team to work together.' : 'Team settings and members'} />
        {status && <p className="text-muted-foreground text-sm">{status}</p>}
        {can.update && (
          <form
            onSubmit={(event: FormEvent) => {
              event.preventDefault()
              rename.patch(base, { preserveScroll: true })
            }}
            className="flex flex-col gap-3 sm:flex-row sm:items-start"
          >
            <div className="flex-1">
              <FormField label="Team name" error={rename.errors.name}>
                <Input required value={rename.data.name} onChange={(e) => rename.setData('name', e.target.value)} />
              </FormField>
            </div>
            <Button type="submit" variant="outline" className="sm:mt-6" loading={rename.processing}>
              Save
            </Button>
          </form>
        )}
      </div>

      <div className="space-y-4">
        <Heading size="small" title="Members" />
        <ul className="divide-y rounded-xl border">
          {members.map((member) => (
            <li key={member.id} className="flex items-center gap-3 px-4 py-3 text-sm">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">
                  {member.name} {member.you && <span className="font-normal text-muted-foreground">(you)</span>}
                </p>
                <p className="truncate text-muted-foreground text-xs">{member.email}</p>
              </div>
              <Badge variant="secondary">{roleNames[member.role] ?? member.role}</Badge>
              {can.manageMembers && !member.you && (
                <Menu>
                  <MenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Manage ${member.name}`} />}>
                    <MoreHorizontal />
                  </MenuTrigger>
                  <MenuPopup align="end" className="w-44">
                    <MenuGroup>
                      <MenuGroupLabel>Role</MenuGroupLabel>
                      {assignable.map((role) => (
                        <MenuItem key={role} disabled={role === member.role || member.role === 'owner'} onClick={() => router.patch(`${base}/members/${member.id}`, { role }, { preserveScroll: true })}>
                          {roleNames[role]}
                        </MenuItem>
                      ))}
                    </MenuGroup>
                    <MenuSeparator />
                    {can.transfer && member.role !== 'owner' && <MenuItem onClick={() => setNewOwner(member)}>Make owner</MenuItem>}
                    <MenuItem variant="destructive" onClick={() => router.delete(`${base}/members/${member.id}`, { preserveScroll: true })}>
                      Remove from team
                    </MenuItem>
                  </MenuPopup>
                </Menu>
              )}
            </li>
          ))}
        </ul>
        <AlertDialog open={newOwner !== undefined} onOpenChange={(open) => !open && setNewOwner(undefined)}>
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>Make {newOwner?.name} the owner?</AlertDialogTitle>
              <AlertDialogDescription>They’ll own {team.name}, and you’ll become an admin. Only they can hand it back.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
              <Button onClick={() => newOwner && router.post(`${base}/members/${newOwner.id}/transfer`, {}, { preserveScroll: true, onFinish: () => setNewOwner(undefined) })}>Make owner</Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      </div>

      {can.invite && (
        <div className="space-y-4">
          <Heading size="small" title="Invite someone" description="They'll get an email with a link to join." />
          <form
            onSubmit={(event: FormEvent) => {
              event.preventDefault()
              invite.post(`${base}/invitations`, { preserveScroll: true, onSuccess: () => invite.reset() })
            }}
            className="flex flex-col gap-3 sm:flex-row sm:items-start"
          >
            <div className="flex-1">
              <FormField label="Email address" error={invite.errors.email}>
                <Input type="email" required placeholder="colleague@example.com" value={invite.data.email} onChange={(e) => invite.setData('email', e.target.value)} />
              </FormField>
            </div>
            <div className="flex gap-2 sm:mt-6">
              <Button type="button" variant="outline" onClick={() => invite.setData('role', invite.data.role === 'member' ? 'admin' : 'member')} title="Change the role">
                As {roleNames[invite.data.role]}
              </Button>
              <Button type="submit" loading={invite.processing}>
                Invite
              </Button>
            </div>
          </form>
          {invitations.length > 0 && (
            <ul className="divide-y rounded-xl border">
              {invitations.map((invitation) => (
                <li key={invitation.id} className="flex items-center gap-3 px-4 py-3 text-sm">
                  <span className="flex-1 truncate">{invitation.email}</span>
                  <Badge variant="outline">{roleNames[invitation.role] ?? invitation.role}, pending</Badge>
                  <Button variant="ghost" size="sm" onClick={() => router.delete(`${base}/invitations/${invitation.id}`, { preserveScroll: true })}>
                    Cancel
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {(can.leave || can.delete) && (
        <div className="space-y-4">
          <Heading size="small" title={can.delete ? 'Delete team' : 'Leave team'} description={can.delete ? 'Delete the team for everyone in it. This can’t be undone.' : 'You’ll lose access until someone invites you again.'} />
          <AlertDialog>
            <AlertDialogTrigger render={<Button variant="destructive" />}>{can.delete ? 'Delete team' : 'Leave team'}</AlertDialogTrigger>
            <AlertDialogPopup>
              <AlertDialogHeader>
                <AlertDialogTitle>{can.delete ? `Delete ${team.name}?` : `Leave ${team.name}?`}</AlertDialogTitle>
                <AlertDialogDescription>{can.delete ? 'Everyone loses access to it, and its invitations are cancelled.' : 'You can only come back with a new invitation.'}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
                <Button variant="destructive" onClick={() => (can.delete ? router.delete(base) : router.post(`${base}/leave`))}>
                  {can.delete ? 'Delete team' : 'Leave team'}
                </Button>
              </AlertDialogFooter>
            </AlertDialogPopup>
          </AlertDialog>
        </div>
      )}
    </>
  )
}

Team.layout = { breadcrumbs: [{ title: 'Teams', href: '/settings/teams' }] }
