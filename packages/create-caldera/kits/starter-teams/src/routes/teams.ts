import { withAuthCookies } from '@caldera/auth'
import { back, defineRequest, defineRoutes, ForbiddenError, NotFoundError, redirect, ValidationError } from '@caldera/http'
import type { Context } from 'hono'
import { z } from 'zod'
import { mw } from '../middleware.js'
import { isPersonal, slugFor } from '../teams.js'

// Teams (Better Auth organizations, src/teams.ts): switching, the settings pages, members and
// invitations. Better Auth checks every permission itself (src/roles.ts); a refusal becomes a 403.

const TeamName = defineRequest({ body: z.object({ name: z.string().trim().min(1, 'Enter a team name.').max(100, 'Use at most 100 characters.') }) })
const Invite = defineRequest({
  body: z.object({ email: z.email('Enter a valid email address.').transform((value) => value.trim().toLowerCase()), role: z.enum(['admin', 'member']) }),
})
const ChangeRole = defineRequest({ body: z.object({ role: z.enum(['owner', 'admin', 'member']) }) })
const Switch = defineRequest({ body: z.object({ teamId: z.string() }) })

const headers = (c: { req: { raw: Request } }) => c.req.raw.headers
const isId = (value: string | undefined) => z.uuid().safeParse(value).success
/** A route parameter that must be an id (anything else is a 404, before it reaches the database). */
const id = (c: Context, name: string) => {
  const value = c.req.param(name)
  if (!isId(value)) throw new NotFoundError()
  return value!
}
// Better Auth refuses with these when the team (or invitation) isn't the person's: answered as 404, so
// ids of other people's teams reveal nothing.
const NOT_YOURS = new Set(['YOU_ARE_NOT_A_MEMBER_OF_THIS_ORGANIZATION', 'USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION', 'YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION'])
/** Better Auth's refusals as the app's: 403 for a missing permission, 404 for a team you're not in. */
async function check(res: Response) {
  if (res.ok) return res
  const { code, message } = (await res.clone().json().catch(() => ({}))) as { code?: string; message?: string }
  if (res.status === 403 && !NOT_YOURS.has(code ?? '')) throw new ForbiddenError(message ?? 'You can’t do that in this team.')
  throw new NotFoundError()
}
/** Back to the person's personal team (after leaving or deleting the current one). */
async function switchToPersonal(c: Context) {
  const teams = (await c.var.auth.api.listOrganizations({ headers: headers(c) })) as { id: string; metadata?: unknown }[]
  const personal = teams.find(isPersonal) ?? teams[0]
  return c.var.auth.api.setActiveOrganization({ body: { organizationId: personal?.id ?? null }, headers: headers(c), asResponse: true })
}

/** After deleting or leaving a team: back to the personal team if that was the current one, else stay put. */
async function leftTeam(c: Context, teamId: string, response: Response) {
  if (c.var.authSession?.activeOrganizationId !== teamId) return response
  return withAuthCookies(c, await switchToPersonal(c), response)
}

export const teamRoutes = defineRoutes('teams', { middleware: [mw.auth(), mw.verified()] })
  // The team switcher in the sidebar.
  .post('switch', '/teams/switch', { request: Switch }, async (c) => {
    const { teamId } = c.req.valid('json')
    if (!isId(teamId)) throw new NotFoundError()
    const res = await check(await c.var.auth.api.setActiveOrganization({ body: { organizationId: teamId }, headers: headers(c), asResponse: true }))
    return withAuthCookies(c, res, redirect(c, c.var.config.auth.home))
  })

  .get('index', '/settings/teams', async (c) => {
    const teams = (await c.var.auth.api.listOrganizations({ headers: headers(c) })) as { id: string; name: string; metadata?: unknown; createdAt: Date }[]
    return c.render('settings/Teams', { teamList: teams.map((team) => ({ id: team.id, name: team.name, personal: isPersonal(team) })) })
  })
  .post('store', '/settings/teams', { request: TeamName }, async (c) => {
    const { name } = c.req.valid('json')
    // The new team becomes the current one.
    const team = (await c.var.auth.api.createOrganization({ body: { name, slug: slugFor(name) }, headers: headers(c) })) as { id: string }
    return redirect(c, `/settings/teams/${team.id}`).with('status', 'team-created')
  })
  .get('show', '/settings/teams/:team', async (c) => {
    const res = await check(await c.var.auth.api.getFullOrganization({ query: { organizationId: id(c, 'team') }, headers: headers(c), asResponse: true }))
    const team = (await res.json()) as {
      id: string
      name: string
      metadata?: unknown
      members: { id: string; role: string; userId: string; user: { name: string; email: string } }[]
      invitations: { id: string; email: string; role: string; status: string; expiresAt: string }[]
    } | null
    if (!team) throw new NotFoundError()
    const me = team.members.find((m) => m.userId === c.var.user!.id)
    const role = me?.role ?? 'member'
    const manages = role === 'owner' || role === 'admin'
    return c.render('settings/Team', {
      team: { id: team.id, name: team.name, personal: isPersonal(team) },
      members: team.members.map((m) => ({ id: m.id, name: m.user.name, email: m.user.email, role: m.role, you: m.userId === c.var.user!.id })),
      invitations: manages ? team.invitations.filter((i) => i.status === 'pending').map((i) => ({ id: i.id, email: i.email, role: i.role, expiresAt: new Date(i.expiresAt).toISOString() })) : [],
      can: { update: manages, invite: manages && !isPersonal(team), manageMembers: manages, delete: role === 'owner' && !isPersonal(team), leave: !isPersonal(team) && role !== 'owner' },
    })
  })
  .patch('update', '/settings/teams/:team', { request: TeamName }, async (c) => {
    await check(await c.var.auth.api.updateOrganization({ body: { organizationId: id(c, 'team'), data: { name: c.req.valid('json').name } }, headers: headers(c), asResponse: true }))
    return back(c).with('status', 'team-updated')
  })
  .delete('destroy', '/settings/teams/:team', async (c) => {
    const teamId = id(c, 'team')
    const team = (await c.var.auth.api.getFullOrganization({ query: { organizationId: teamId }, headers: headers(c) }).catch(() => null)) as { metadata?: unknown } | null
    if (!team) throw new NotFoundError()
    if (isPersonal(team)) throw new ForbiddenError('Your personal team can’t be deleted.')
    await check(await c.var.auth.api.deleteOrganization({ body: { organizationId: teamId }, headers: headers(c), asResponse: true }))
    return leftTeam(c, teamId, redirect(c, '/settings/teams').with('status', 'team-deleted'))
  })
  .post('leave', '/settings/teams/:team/leave', async (c) => {
    const teamId = id(c, 'team')
    await check(await c.var.auth.api.leaveOrganization({ body: { organizationId: teamId }, headers: headers(c), asResponse: true }))
    return leftTeam(c, teamId, redirect(c, '/settings/teams').with('status', 'team-left'))
  })

  .post('invitations.store', '/settings/teams/:team/invitations', { request: Invite }, async (c) => {
    const { email, role } = c.req.valid('json')
    const res = await c.var.auth.api.createInvitation({ body: { email, role, organizationId: id(c, 'team') }, headers: headers(c), asResponse: true })
    if (res.status === 400) throw new ValidationError({ email: [((await res.json()) as { message?: string }).message ?? 'That person can’t be invited.'] })
    await check(res)
    return back(c).with('status', 'invitation-sent')
  })
  .delete('invitations.destroy', '/settings/teams/:team/invitations/:invitation', async (c) => {
    await check(await c.var.auth.api.cancelInvitation({ body: { invitationId: id(c, 'invitation') }, headers: headers(c), asResponse: true }))
    return back(c)
  })
  .patch('members.update', '/settings/teams/:team/members/:member', { request: ChangeRole }, async (c) => {
    const res = await c.var.auth.api.updateMemberRole({ body: { organizationId: id(c, 'team'), memberId: id(c, 'member'), role: c.req.valid('json').role }, headers: headers(c), asResponse: true })
    if (res.status === 400) throw new ValidationError({ role: [((await res.json()) as { message?: string }).message ?? 'That role can’t be given.'] })
    await check(res)
    return back(c)
  })
  .delete('members.destroy', '/settings/teams/:team/members/:member', async (c) => {
    await check(await c.var.auth.api.removeMember({ body: { organizationId: id(c, 'team'), memberIdOrEmail: id(c, 'member') }, headers: headers(c), asResponse: true }))
    return back(c).with('status', 'member-removed')
  })

  // From the invitation email (signed-out people sign in or register first, and come back here).
  .get('invitations.show', '/invitations/:invitation', async (c) => {
    const res = await c.var.auth.api.getInvitation({ query: { id: id(c, 'invitation') }, headers: headers(c), asResponse: true })
    if (!res.ok) return c.render('teams/Invitation', { invitation: null })
    const invitation = (await res.json()) as { id: string; organizationName: string; inviterEmail: string; role: string }
    return c.render('teams/Invitation', { invitation: { id: invitation.id, team: invitation.organizationName, inviter: invitation.inviterEmail, role: invitation.role } })
  })
  .post('invitations.accept', '/invitations/:invitation/accept', async (c) => {
    const res = await check(await c.var.auth.api.acceptInvitation({ body: { invitationId: id(c, 'invitation') }, headers: headers(c), asResponse: true }))
    const { member } = (await res.clone().json()) as { member: { organizationId: string } }
    // Straight into the team they joined.
    const active = await c.var.auth.api.setActiveOrganization({ body: { organizationId: member.organizationId }, headers: headers(c), asResponse: true })
    return withAuthCookies(c, active, redirect(c, c.var.config.auth.home).with('status', 'invitation-accepted'))
  })
  .post('invitations.reject', '/invitations/:invitation/reject', async (c) => {
    await check(await c.var.auth.api.rejectInvitation({ body: { invitationId: id(c, 'invitation') }, headers: headers(c), asResponse: true }))
    return redirect(c, c.var.config.auth.home)
  })
