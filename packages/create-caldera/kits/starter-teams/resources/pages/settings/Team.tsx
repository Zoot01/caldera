import { Head, router, useForm } from '@inertiajs/react'
import { ChevronDown, Mail, MoreHorizontal, SendHorizontal, X } from 'lucide-react'
import { type FormEvent, type ReactNode, useState } from 'react'
import { FormField } from '@/components/form-field'
import { Section } from '@/components/section'
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
import { Menu, MenuItem, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from '@/components/ui/menu'
import { useStatusToast } from '@/components/flash-toasts'
import { avatarColor } from '@/lib/avatar-color'
import { cn } from '@/lib/utils'

interface Props {
  team: { id: string; name: string; personal: boolean }
  members: { id: string; name: string; email: string; role: string; you: boolean }[]
  invitations: { id: string; email: string; role: string; expiresAt: string }[]
  can: { update: boolean; invite: boolean; manageMembers: boolean; transfer: boolean; delete: boolean; leave: boolean }
}

const statuses: Record<string, string> = {
  'team-created': 'Team created: it’s your current team now.',
  'team-updated': 'Team saved.',
  'invitation-sent': 'Invitation sent.',
  'member-removed': 'Removed from the team.',
  'ownership-transferred': 'The team has a new owner. You’re an admin now.',
}
const roleNames: Record<string, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' }
// The roles given from the member menu; owner is handed over instead.
const assignable = ['admin', 'member'] as const

export default function Team({ team, members, invitations, can }: Props) {
  useStatusToast(statuses)
  const rename = useForm({ name: team.name })
  const invite = useForm({ email: '', role: 'member' as 'admin' | 'member' })
  const base = `/settings/teams/${team.id}`
  const [newOwner, setNewOwner] = useState<Props['members'][number]>()
  return (
    <>
      <Head title={team.name} />
      <div className="space-y-1">
        <h2 className="font-medium text-lg">{team.name}</h2>
        <p className="text-muted-foreground text-sm">{team.personal ? 'Your personal team. Others can’t be invited to it; make a new team to work together.' : 'Team settings and members'}</p>
      </div>
      {can.update && (
        <Section title="General" description="The team's name, as everyone in it sees it.">
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
        </Section>
      )}

      <Section title="Members" description="Manage the team's members, set roles, and invite new people.">
        <div className="space-y-6">
          {can.invite && (
            <form
              onSubmit={(event: FormEvent) => {
                event.preventDefault()
                invite.post(`${base}/invitations`, { preserveScroll: true, onSuccess: () => invite.reset() })
              }}
              className="space-y-2.5"
            >
              <label htmlFor="invite-email" className="block font-medium text-sm">
                Invite by email
              </label>
              {/* One field, like an input: the address, the role they'll have, and send. */}
              <div className="flex w-full items-stretch rounded-lg border border-input bg-background shadow-xs/5 ring-ring/24 transition-shadow has-focus-visible:border-ring has-focus-visible:ring-[3px] has-aria-invalid:border-destructive/36 dark:bg-input/32">
                <Input
                  unstyled
                  id="invite-email"
                  type="email"
                  required
                  aria-label="Email address"
                  aria-invalid={invite.errors.email ? true : undefined}
                  placeholder="colleague@example.com"
                  value={invite.data.email}
                  onChange={(e) => invite.setData('email', e.target.value)}
                  className="flex-1 text-sm"
                />
                <RolePicker role={invite.data.role} onChange={(role) => invite.setData('role', role)} label="Role for the invitation" segment />
                <Button type="submit" variant="ghost" loading={invite.processing} className="h-auto gap-2.5 self-stretch rounded-none rounded-e-[calc(var(--radius-lg)-1px)] sm:h-auto border-0 border-s border-s-input px-3.5">
                  Send invite
                  <SendHorizontal className="text-muted-foreground" />
                </Button>
              </div>
              {invite.errors.email && <p className="text-destructive-foreground text-sm">{invite.errors.email}</p>}
            </form>
          )}

          {invitations.length > 0 && (
            <div className="space-y-2.5">
              <h3 className="font-medium text-sm">Pending invitations</h3>
              <ul className="divide-y rounded-lg border">
                {invitations.map((invitation) => (
                  <Row
                    key={invitation.id}
                    lead={
                      <span className="flex size-6 items-center justify-center rounded-full border text-muted-foreground">
                        <Mail className="size-3" />
                      </span>
                    }
                    primary={invitation.email}
                    role={<Badge variant="outline">{roleNames[invitation.role] ?? invitation.role}</Badge>}
                    action={
                      <Button variant="ghost" size="icon-sm" aria-label={`Cancel the invitation to ${invitation.email}`} title="Cancel invitation" onClick={() => router.delete(`${base}/invitations/${invitation.id}`, { preserveScroll: true })}>
                        <X />
                      </Button>
                    }
                  />
                ))}
              </ul>
            </div>
          )}

          <div className="space-y-2.5">
            <h3 className="font-medium text-sm">Team members</h3>
            <ul className="divide-y rounded-lg border">
              {members.map((member) => (
                <Row
                  key={member.id}
                  lead={<span className={cn('flex size-6 items-center justify-center rounded-full border font-medium text-xs', avatarColor(member.name))}>{member.name.trim()[0]?.toUpperCase()}</span>}
                  primary={`${member.name}${member.you ? ' (You)' : ''}`}
                  secondary={member.email}
                  role={
                    can.manageMembers && !member.you && member.role !== 'owner' ? (
                      <RolePicker role={member.role as 'admin' | 'member'} onChange={(role) => router.patch(`${base}/members/${member.id}`, { role }, { preserveScroll: true })} label={`Role for ${member.name}`} />
                    ) : (
                      <Badge variant="outline">{roleNames[member.role] ?? member.role}</Badge>
                    )
                  }
                  action={
                    can.manageMembers && !member.you ? (
                      <Menu>
                        <MenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Manage ${member.name}`} />}>
                          <MoreHorizontal />
                        </MenuTrigger>
                        <MenuPopup align="end" className="w-44">
                          {can.transfer && member.role !== 'owner' && <MenuItem onClick={() => setNewOwner(member)}>Make owner</MenuItem>}
                          <MenuItem variant="destructive" disabled={member.role === 'owner'} onClick={() => router.delete(`${base}/members/${member.id}`, { preserveScroll: true })}>
                            Remove from team
                          </MenuItem>
                        </MenuPopup>
                      </Menu>
                    ) : null
                  }
                />
              ))}
            </ul>
          </div>
        </div>
        <AlertDialog open={newOwner !== undefined} onOpenChange={(open) => !open && setNewOwner(undefined)}>
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>Make {newOwner?.name} the owner?</AlertDialogTitle>
              <AlertDialogDescription>They’ll own {team.name}, and you’ll become an admin. Only they can hand it back.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
              <Button onClick={() => newOwner && router.post(`${base}/members/${newOwner.id}/transfer`, {}, { preserveScroll: true, onFinish: () => setNewOwner(undefined) })}>Make owner</Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      </Section>

      {(can.leave || can.delete) && (
        <Section title={can.delete ? 'Delete team' : 'Leave team'} description={can.delete ? 'Delete the team for everyone in it. This can’t be undone.' : 'You’ll lose access until someone invites you again.'} tone="danger">
          <AlertDialog>
            <AlertDialogTrigger render={<Button variant="destructive-outline" />}>{can.delete ? 'Delete team' : 'Leave team'}</AlertDialogTrigger>
            <AlertDialogPopup>
              <AlertDialogHeader>
                <AlertDialogTitle>{can.delete ? `Delete ${team.name}?` : `Leave ${team.name}?`}</AlertDialogTitle>
                <AlertDialogDescription>{can.delete ? 'Everyone loses access to it, and its invitations are cancelled.' : 'You can only come back with a new invitation.'}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
                <Button variant="destructive" onClick={() => (can.delete ? router.delete(base) : router.post(`${base}/leave`))}>
                  {can.delete ? 'Delete team' : 'Leave team'}
                </Button>
              </AlertDialogFooter>
            </AlertDialogPopup>
          </AlertDialog>
        </Section>
      )}
    </>
  )
}


/**
 * One person (or invitation) in a list: a 24px mark, the name and email, then a role column and an
 * action slot of fixed widths, so every row's columns line up.
 */
function Row({ lead, primary, secondary, role, action }: { lead: ReactNode; primary: string; secondary?: string; role: ReactNode; action: ReactNode }) {
  return (
    <li className="flex min-h-12 items-center gap-3 py-2 ps-3 pe-2 text-sm">
      <span className="shrink-0">{lead}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-x-4 sm:flex-row sm:items-baseline">
        <span className="truncate font-medium">{primary}</span>
        {secondary && <span className="truncate text-muted-foreground">{secondary}</span>}
      </div>
      <div className="flex w-24 shrink-0 justify-end">{role}</div>
      <div className="flex size-7 shrink-0 items-center justify-center">{action}</div>
    </li>
  )
}

/** Admin or member, as a small dropdown ("Admin ▾"). Owner is handed over from the member's menu instead. */
function RolePicker({ role, onChange, label, segment = false }: { role: 'admin' | 'member'; onChange: (role: 'admin' | 'member') => void; label: string; /** A full-height part of a field (the invite box), not a pill. */ segment?: boolean }) {
  return (
    <Menu>
      <MenuTrigger render={<Button type="button" variant="ghost" size="sm" className={cn('gap-1 text-muted-foreground hover:text-foreground data-popup-open:text-foreground', segment ? 'h-auto self-stretch rounded-none px-3 sm:h-auto' : 'self-center')} aria-label={label} />}>
        {roleNames[role]}
        <ChevronDown className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="end" className="w-36">
        <MenuRadioGroup value={role} onValueChange={(value) => onChange(value as 'admin' | 'member')}>
          {assignable.map((option) => (
            <MenuRadioItem key={option} value={option} closeOnClick>
              {roleNames[option]}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  )
}

Team.layout = { breadcrumbs: [{ title: 'Teams', href: '/settings/teams' }] }
