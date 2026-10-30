import { setupApp, type TestClient } from '@caldera/testing'
import { expect, it } from 'vitest'
import { app } from '../../src/app.js'
import { http } from '../../src/http.js'
import { TeamInvitationEmail } from '../../src/mail/team-invitation.js'
import { createUser } from '../helpers.js'

const t = setupApp(app)

type Teams = { current: { id: string; name: string; personal: boolean } | null; all: { id: string; name: string }[] }
const teamsOf = async (client: TestClient) => (await client.visit('/dashboard')).page().props.teams as Teams
async function createTeam(client: TestClient, name: string) {
  const res = await client.post('/settings/teams', { json: { name } })
  return res.headers.get('location')!.split('/').pop()!
}

it('gives everyone a personal team, which is their current one', async () => {
  const client = await t.client(http).actingAs(await createUser(t))
  expect(await teamsOf(client)).toMatchObject({ current: { name: "Ann's Team", personal: true }, all: [{ name: "Ann's Team" }] })
})

it('gives people who register a personal team, current in the session they start', async () => {
  const client = t.client(http)
  const password = 'correct-horse-battery'
  ;(await client.post('/register', { json: { name: 'Dee Park', email: 'dee@example.test', password, passwordConfirmation: password } })).assertRedirect('/dashboard')
  expect(await teamsOf(client)).toMatchObject({ current: { name: "Dee's Team", personal: true }, all: [{ name: "Dee's Team" }] })
})

it('creates teams, which become current, and switches between them', async () => {
  const client = await t.client(http).actingAs(await createUser(t))
  const personal = (await teamsOf(client)).current!.id
  const acme = await createTeam(client, 'Acme')
  expect((await teamsOf(client)).current).toMatchObject({ id: acme, name: 'Acme', personal: false })
  ;(await client.post('/teams/switch', { json: { teamId: personal } })).assertRedirect('/dashboard')
  expect((await teamsOf(client)).current!.id).toBe(personal)
  // Not a team of theirs.
  ;(await client.post('/teams/switch', { json: { teamId: crypto.randomUUID() } })).assertNotFound()
})

it('invites someone by email, who joins as a member', async () => {
  const mail = t.fake('mail')
  const ann = await t.client(http).actingAs(await createUser(t))
  const acme = await createTeam(ann, 'Acme')
  ;(await ann.post(`/settings/teams/${acme}/invitations`, { json: { email: 'bob@example.test', role: 'member' } })).assertRedirect()
  const link = new URL(mail.sent(TeamInvitationEmail)[0]!.props.url)

  const bob = await t.client(http).actingAs(await createUser(t, { name: 'Bob', email: 'bob@example.test' }))
  ;(await bob.visit(link.pathname)).assertInertia('teams/Invitation', (props) => expect(props.invitation).toMatchObject({ team: 'Acme', role: 'member' }))
  ;(await bob.post(`${link.pathname}/accept`)).assertRedirect('/dashboard')
  expect((await teamsOf(bob)).current).toMatchObject({ id: acme, name: 'Acme' })
  ;(await ann.visit(`/settings/teams/${acme}`)).assertInertia('settings/Team', (props) =>
    expect((props.members as { email: string; role: string }[]).map((m) => [m.email, m.role])).toEqual([
      ['ann@example.test', 'owner'],
      ['bob@example.test', 'member'],
    ]),
  )
})

it('only shows an invitation to the address it was sent to', async () => {
  const mail = t.fake('mail')
  const ann = await t.client(http).actingAs(await createUser(t))
  const acme = await createTeam(ann, 'Acme')
  await ann.post(`/settings/teams/${acme}/invitations`, { json: { email: 'bob@example.test', role: 'member' } })
  const link = new URL(mail.sent(TeamInvitationEmail)[0]!.props.url)
  const cy = await t.client(http).actingAs(await createUser(t, { name: 'Cy', email: 'cy@example.test' }))
  ;(await cy.visit(link.pathname)).assertInertia('teams/Invitation', { invitation: null })
  ;(await cy.post(`${link.pathname}/accept`)).assertStatus(404)
})

it('lets members see the team but not manage it', async () => {
  const mail = t.fake('mail')
  const ann = await t.client(http).actingAs(await createUser(t))
  const acme = await createTeam(ann, 'Acme')
  await ann.post(`/settings/teams/${acme}/invitations`, { json: { email: 'bob@example.test', role: 'member' } })
  const bob = await t.client(http).actingAs(await createUser(t, { name: 'Bob', email: 'bob@example.test' }))
  await bob.post(`${new URL(mail.sent(TeamInvitationEmail)[0]!.props.url).pathname}/accept`)

  ;(await bob.visit(`/settings/teams/${acme}`)).assertInertia('settings/Team', { can: { update: false, invite: false, manageMembers: false, delete: false, leave: true } })
  ;(await bob.post(`/settings/teams/${acme}/invitations`, { json: { email: 'cy@example.test', role: 'member' } })).assertForbidden()
  ;(await bob.delete(`/settings/teams/${acme}`)).assertForbidden()
  // Leaving puts them back in their personal team.
  ;(await bob.post(`/settings/teams/${acme}/leave`)).assertRedirect('/settings/teams')
  expect((await teamsOf(bob)).current).toMatchObject({ personal: true })
  ;(await bob.visit(`/settings/teams/${acme}`)).assertNotFound()
})

it('lets owners change roles and remove members', async () => {
  const mail = t.fake('mail')
  const ann = await t.client(http).actingAs(await createUser(t))
  const acme = await createTeam(ann, 'Acme')
  await ann.post(`/settings/teams/${acme}/invitations`, { json: { email: 'bob@example.test', role: 'member' } })
  const bob = await t.client(http).actingAs(await createUser(t, { name: 'Bob', email: 'bob@example.test' }))
  await bob.post(`${new URL(mail.sent(TeamInvitationEmail)[0]!.props.url).pathname}/accept`)
  const members = (await ann.visit(`/settings/teams/${acme}`)).page().props.members as { id: string; email: string }[]
  const bobId = members.find((m) => m.email === 'bob@example.test')!.id

  ;(await ann.patch(`/settings/teams/${acme}/members/${bobId}`, { json: { role: 'admin' } })).assertRedirect()
  ;(await bob.visit(`/settings/teams/${acme}`)).assertInertia('settings/Team', (props) => expect(props.can).toMatchObject({ update: true, invite: true }))
  ;(await ann.delete(`/settings/teams/${acme}/members/${bobId}`)).assertRedirect()
  ;(await bob.visit(`/settings/teams/${acme}`)).assertNotFound()
})

it('deletes teams, but never a personal one', async () => {
  const client = await t.client(http).actingAs(await createUser(t))
  const personal = (await teamsOf(client)).current!.id
  ;(await client.delete(`/settings/teams/${personal}`)).assertForbidden()
  const acme = await createTeam(client, 'Acme')
  ;(await client.delete(`/settings/teams/${acme}`)).assertRedirect('/settings/teams')
  expect(await teamsOf(client)).toMatchObject({ current: { id: personal }, all: [{ id: personal }] })
  ;(await client.visit(`/settings/teams/${acme}`)).assertNotFound()
})

it('renames a team', async () => {
  const client = await t.client(http).actingAs(await createUser(t))
  const acme = await createTeam(client, 'Acme')
  ;(await client.patch(`/settings/teams/${acme}`, { json: { name: 'Acme Inc.' } })).assertRedirect()
  expect((await teamsOf(client)).current).toMatchObject({ name: 'Acme Inc.' })
})
