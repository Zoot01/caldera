import { setupApp, type TestClient } from '@caldera/testing'
import { expect, it } from 'vitest'
import { app } from '../../src/app'
import { http } from '../../src/http'
import { TeamInvitationEmail } from '../../src/mail/team-invitation'
import { createUser } from '../helpers'

const t = setupApp(app)

type Teams = { current: { id: string; name: string; personal: boolean } | null; all: { id: string; name: string; personal: boolean }[] }
type Team = { members: { id: string; email: string; role: string }[]; can: Record<string, boolean> }
const teamsOf = async (client: TestClient) => (await client.get('/api/teams/current')).json<Teams>()
/** A page's data, as its route gives it to the page (`load` in app/). */
const page = async <T = Record<string, unknown>>(client: TestClient, path: string) => (await client.get(`/api${path}`)).assertOk().json<T>()
async function createTeam(client: TestClient, name: string) {
  const res = await client.post('/api/settings/teams', { json: { name } })
  return res.headers.get('location')!.split('/').pop()!
}
/** Ann invites Bob to a new team, Acme, and Bob joins. */
async function acmeWithBob() {
  const mail = t.fake('mail')
  const ann = await t.client(http).actingAs(await createUser(t))
  const acme = await createTeam(ann, 'Acme')
  await ann.post(`/api/settings/teams/${acme}/invitations`, { json: { email: 'bob@example.test', role: 'member' } })
  const bob = await t.client(http).actingAs(await createUser(t, { name: 'Bob', email: 'bob@example.test' }))
  await bob.post(`/api${new URL(mail.sent(TeamInvitationEmail)[0]!.props.url).pathname}/accept`)
  const { members } = await page<Team>(ann, `/settings/teams/${acme}`)
  const [annId, bobId] = ['ann@example.test', 'bob@example.test'].map((email) => members.find((m) => m.email === email)!.id)
  return { ann, bob, acme, annId: annId!, bobId: bobId! }
}

it('gives everyone a personal team, which is their current one', async () => {
  const client = await t.client(http).actingAs(await createUser(t))
  expect(await teamsOf(client)).toMatchObject({ current: { name: "Ann's Team", personal: true }, all: [{ name: "Ann's Team" }] })
})

it('gives people who register a personal team, current in the session they start', async () => {
  const client = t.client(http)
  const password = 'correct-horse-battery'
  ;(await client.post('/api/register', { json: { name: 'Dee Park', email: 'dee@example.test', password, passwordConfirmation: password } })).assertRedirect('/dashboard')
  expect(await teamsOf(client)).toMatchObject({ current: { name: "Dee's Team", personal: true }, all: [{ name: "Dee's Team" }] })
})

it('creates teams, which become current, and switches between them', async () => {
  const client = await t.client(http).actingAs(await createUser(t))
  const personal = (await teamsOf(client)).current!.id
  const acme = await createTeam(client, 'Acme')
  expect((await teamsOf(client)).current).toMatchObject({ id: acme, name: 'Acme', personal: false })
  ;(await client.post('/api/teams/switch', { json: { teamId: personal } })).assertRedirect('/dashboard')
  expect((await teamsOf(client)).current!.id).toBe(personal)
  // Not a team of theirs.
  ;(await client.post('/api/teams/switch', { json: { teamId: crypto.randomUUID() } })).assertNotFound()
})

it('invites someone by email, who joins as a member', async () => {
  const mail = t.fake('mail')
  const ann = await t.client(http).actingAs(await createUser(t))
  const acme = await createTeam(ann, 'Acme')
  ;(await ann.post(`/api/settings/teams/${acme}/invitations`, { json: { email: 'bob@example.test', role: 'member' } })).assertRedirect()
  const link = new URL(mail.sent(TeamInvitationEmail)[0]!.props.url)
  // The email links to the page; the page loads the invitation from /api.
  expect(link.pathname).toMatch(/^\/invitations\/[0-9a-f-]{36}$/)

  const bob = await t.client(http).actingAs(await createUser(t, { name: 'Bob', email: 'bob@example.test' }))
  expect((await page(bob, link.pathname)).invitation).toMatchObject({ team: 'Acme', role: 'member', inviter: 'Ann' })
  ;(await bob.post(`/api${link.pathname}/accept`)).assertRedirect('/dashboard')
  expect((await teamsOf(bob)).current).toMatchObject({ id: acme, name: 'Acme' })
  expect((await page<Team>(ann, `/settings/teams/${acme}`)).members.map((m) => [m.email, m.role])).toEqual([
    ['ann@example.test', 'owner'],
    ['bob@example.test', 'member'],
  ])
})

it('only shows an invitation to the address it was sent to', async () => {
  const mail = t.fake('mail')
  const ann = await t.client(http).actingAs(await createUser(t))
  const acme = await createTeam(ann, 'Acme')
  await ann.post(`/api/settings/teams/${acme}/invitations`, { json: { email: 'bob@example.test', role: 'member' } })
  const link = new URL(mail.sent(TeamInvitationEmail)[0]!.props.url)
  const cy = await t.client(http).actingAs(await createUser(t, { name: 'Cy', email: 'cy@example.test' }))
  expect(await page(cy, link.pathname)).toEqual({ invitation: null })
  ;(await cy.post(`/api${link.pathname}/accept`)).assertStatus(404)
  // Signed out, the page sends people to sign in first.
  ;(await t.client(http).get(`/api${link.pathname}`)).assertUnauthorized()
})

it('lets members see the team but not manage it', async () => {
  const { bob, acme } = await acmeWithBob()
  expect((await page<Team>(bob, `/settings/teams/${acme}`)).can).toEqual({ update: false, invite: false, manageMembers: false, transfer: false, delete: false, leave: true })
  ;(await bob.post(`/api/settings/teams/${acme}/invitations`, { json: { email: 'cy@example.test', role: 'member' } })).assertForbidden()
  ;(await bob.delete(`/api/settings/teams/${acme}`)).assertForbidden()
  // Leaving puts them back in their personal team.
  ;(await bob.post(`/api/settings/teams/${acme}/leave`)).assertRedirect('/settings/teams')
  expect((await teamsOf(bob)).current).toMatchObject({ personal: true })
  ;(await bob.get(`/api/settings/teams/${acme}`)).assertNotFound()
})

it('lets owners change roles and remove members', async () => {
  const { ann, bob, acme, bobId } = await acmeWithBob()
  ;(await ann.patch(`/api/settings/teams/${acme}/members/${bobId}`, { json: { role: 'admin' } })).assertRedirect()
  expect((await page<Team>(bob, `/settings/teams/${acme}`)).can).toMatchObject({ update: true, invite: true })
  ;(await ann.delete(`/api/settings/teams/${acme}/members/${bobId}`)).assertRedirect()
  ;(await bob.get(`/api/settings/teams/${acme}`)).assertNotFound()
})

it('hands a team to another member, and the old owner stays as an admin', async () => {
  const { ann, bob, acme, annId, bobId } = await acmeWithBob()
  // Only the owner can, and owner isn't a role to hand out.
  ;(await bob.post(`/api/settings/teams/${acme}/members/${annId}/transfer`)).assertForbidden()
  await (await ann.patch(`/api/settings/teams/${acme}/members/${bobId}`, { json: { role: 'owner' } })).assertValidationErrors(['role'])

  ;(await ann.post(`/api/settings/teams/${acme}/members/${bobId}/transfer`)).assertRedirect()
  const asAnn = await page<Team>(ann, `/settings/teams/${acme}`)
  expect(asAnn.members.map((m) => [m.email, m.role])).toEqual([
    ['ann@example.test', 'admin'],
    ['bob@example.test', 'owner'],
  ])
  expect(asAnn.can).toMatchObject({ transfer: false, delete: false, leave: true })
  expect((await page<Team>(bob, `/settings/teams/${acme}`)).can).toMatchObject({ transfer: true, delete: true, leave: false })
  // Never a personal team.
  const personal = (await teamsOf(bob)).all.find((team) => team.personal)!.id
  const own = (await page<Team>(bob, `/settings/teams/${personal}`)).members
  ;(await bob.post(`/api/settings/teams/${personal}/members/${own[0]!.id}/transfer`)).assertForbidden()
})

it('deletes teams, but never a personal one', async () => {
  const client = await t.client(http).actingAs(await createUser(t))
  const personal = (await teamsOf(client)).current!.id
  ;(await client.delete(`/api/settings/teams/${personal}`)).assertForbidden()
  const acme = await createTeam(client, 'Acme')
  ;(await client.delete(`/api/settings/teams/${acme}`)).assertRedirect('/settings/teams')
  expect(await teamsOf(client)).toMatchObject({ current: { id: personal }, all: [{ id: personal }] })
  ;(await client.get(`/api/settings/teams/${acme}`)).assertNotFound()
})

it('stays in the current team when deleting another one', async () => {
  const client = await t.client(http).actingAs(await createUser(t))
  const acme = await createTeam(client, 'Acme')
  const globex = await createTeam(client, 'Globex')
  ;(await client.post('/api/teams/switch', { json: { teamId: acme } })).assertRedirect()
  ;(await client.delete(`/api/settings/teams/${globex}`)).assertRedirect('/settings/teams')
  expect((await teamsOf(client)).current).toMatchObject({ id: acme })
})

it('renames a team', async () => {
  const client = await t.client(http).actingAs(await createUser(t))
  const acme = await createTeam(client, 'Acme')
  ;(await client.patch(`/api/settings/teams/${acme}`, { json: { name: 'Acme Inc.' } })).assertRedirect()
  expect((await teamsOf(client)).current).toMatchObject({ name: 'Acme Inc.' })
})
