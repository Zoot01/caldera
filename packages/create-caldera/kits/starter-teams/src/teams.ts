import { defaultDatabase } from '@caldera/db'
import { mail } from '@caldera/mail'
import { organization } from 'better-auth/plugins'
import { asc, eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { member, organization as teams, users } from './db/schema.js'
import { TeamInvitationEmail } from './mail/team-invitation.js'
import { ac, roles } from './roles.js'

// Teams are Better Auth organizations (https://better-auth.com/docs/plugins/organization). Everyone
// gets a personal team when they register; the team they're working in is their session's active
// organization (switched from the sidebar).

/** A URL-safe slug, unique enough for team names (Better Auth requires one). */
export const slugFor = (name: string) =>
  `${
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'team'
  }-${crypto.randomUUID().slice(0, 8)}`

/** Is this the person's personal team (made at registration; it can't be deleted or left)? */
export const isPersonal = (team: { metadata?: unknown }) => {
  try {
    const metadata = typeof team.metadata === 'string' ? JSON.parse(team.metadata) : team.metadata
    return Boolean((metadata as { personal?: boolean } | null)?.personal)
  } catch {
    return false
  }
}

/** The organization plugin, as src/auth.ts installs it. */
export function teamsPlugin(options: { appUrl: string }) {
  return organization({
    ac,
    roles,
    // Invitations last a week; inviting the same address again replaces the old one.
    invitationExpiresIn: 7 * 24 * 60 * 60,
    cancelPendingInvitationsOnReInvite: true,
    sendInvitationEmail: async ({ id, email, organization, inviter }) => {
      await mail.to(email).send(TeamInvitationEmail, { team: organization.name, inviter: inviter.user.name, url: `${options.appUrl}/invitations/${id}` })
    },
  })
}

/** The person's first team, creating their personal team if they have none yet. */
async function firstTeamOf(db: any, userId: string): Promise<string> {
  const [first] = await db.select({ id: member.organizationId }).from(member).where(eq(member.userId, userId)).orderBy(asc(member.createdAt)).limit(1)
  if (first) return first.id
  const [user] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1)
  const name = `${user?.name.split(' ')[0] || 'My'}'s Team`
  const [team] = await db.insert(teams).values({ name, slug: slugFor(name), metadata: JSON.stringify({ personal: true }), createdAt: new Date() }).returning()
  await db.insert(member).values({ organizationId: team.id, userId, role: 'owner', createdAt: new Date() })
  return team.id
}

/**
 * Better Auth database hooks: a personal team for every account, and each new session starts in the
 * person's first team. On sign-up Better Auth creates the session before the user's `after` hook
 * runs, so whichever comes first makes the team. `db` is the client src/auth.ts gets (it joins open
 * transactions); `any`, as its type differs by database (SQLite, Postgres), and these queries work on both.
 */
export function teamHooks(db: any) {
  return {
    user: {
      create: {
        after: async (user: { id: string }) => {
          await firstTeamOf(db, user.id)
        },
      },
    },
    session: {
      create: {
        before: async (session: { userId: string; activeOrganizationId?: string | null }) => ({
          data: { ...session, activeOrganizationId: session.activeOrganizationId ?? (await firstTeamOf(db, session.userId)) },
        }),
      },
    },
  }
}

/**
 * The signed-in person's teams and the current one, for every page (src/inertia.ts shares it). One
 * query, oldest membership first (the personal team leads); a partial reload that doesn't ask skips it.
 */
export async function teamsFor(c: Context) {
  const vars = c.var as { user?: { id: string } | null; authSession?: { activeOrganizationId?: string | null } | null }
  if (!vars.user) return null
  const all: { id: string; name: string; metadata: unknown }[] = await defaultDatabase()
    .current()
    .select({ id: teams.id, name: teams.name, metadata: teams.metadata })
    .from(member)
    .innerJoin(teams, eq(member.organizationId, teams.id))
    .where(eq(member.userId, vars.user.id))
    .orderBy(asc(member.createdAt))
  const summary = (team: (typeof all)[number]) => ({ id: team.id, name: team.name, personal: isPersonal(team) })
  const current = all.find((team) => team.id === vars.authSession?.activeOrganizationId)
  return { current: current ? summary(current) : null, all: all.map(summary) }
}
