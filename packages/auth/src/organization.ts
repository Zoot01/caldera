import type { Context } from 'hono'
import type { GateContext } from './policy.js'

/** The active organization, as policies see it through `g.org`. */
export interface OrgContext {
  /** The session's active organization, or null. */
  readonly id: string | null
  /** The member's role(s) in the active organization (comma-separated in Better Auth), or null. */
  role(): Promise<string | null>
  /** Whether any of the member's roles grants these permissions (Better Auth access control). */
  has(permissions: Record<string, string[]>): Promise<boolean>
}

// Importing this module is what adds `org` to the gate context's type.
declare module './policy.js' {
  interface GateExtensions {
    org: OrgContext
  }
}

/** Structural view of a Better Auth role from `createAccessControl(...).newRole(...)`. */
export interface RoleLike {
  authorize(request: Record<string, string[]>): { success: boolean }
}

interface OrgAuthVars {
  auth?: { api: { getActiveMember(options: { headers: Headers }): Promise<{ role: string; organizationId: string } | null> } }
  authSession?: { activeOrganizationId?: string | null } | null
}

/**
 * Adds `g.org` to policies: `create: (user, _none, g) => g.org.has({ post: ['create'] })`.
 * Pass the same `roles` you give Better Auth's organization plugin. The member row is loaded
 * at most once per request, and permissions are checked locally (no extra HTTP round trip).
 *
 * `authorizationProvider({ extend: organizationGate({ roles }) })`
 */
export function organizationGate(options: { roles: Record<string, RoleLike> }) {
  return (c: Context, base: Pick<GateContext, 'user'>): { org: OrgContext } => {
    const vars = c.var as OrgAuthVars
    let member: Promise<{ role: string } | null> | undefined
    const load = () => {
      if (!base.user || !vars.auth) return Promise.resolve(null)
      member ??= vars.auth.api.getActiveMember({ headers: c.req.raw.headers }).catch(() => null)
      return member
    }
    return {
      org: {
        get id() {
          return vars.authSession?.activeOrganizationId ?? null
        },
        async role() {
          return (await load())?.role ?? null
        },
        async has(permissions) {
          const found = await load()
          if (!found) return false
          return found.role
            .split(',')
            .map((r) => r.trim())
            .some((role) => options.roles[role]?.authorize(permissions).success === true)
        },
      },
    }
  }
}
