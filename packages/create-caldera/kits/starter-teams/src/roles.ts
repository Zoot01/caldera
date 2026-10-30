import { createAccessControl } from 'better-auth/plugins/access'
import { adminAc, defaultStatements, memberAc, ownerAc } from 'better-auth/plugins/organization/access'

/**
 * What a team member may do, by role. Better Auth's statements cover the team itself (organization,
 * member, invitation); add your own resources next to them and grant them per role:
 *
 *   const ac = createAccessControl({ ...defaultStatements, project: ['create', 'update', 'delete'] })
 *   member: ac.newRole({ ...memberAc.statements, project: ['create'] })
 *
 * Policies check them with `g.org.has({ project: ['create'] })` (src/app.ts wires `g.org`).
 */
export const ac = createAccessControl({ ...defaultStatements })

export const roles = {
  owner: ac.newRole({ ...ownerAc.statements }),
  admin: ac.newRole({ ...adminAc.statements }),
  member: ac.newRole({ ...memberAc.statements }),
}

export type Role = keyof typeof roles
export const ROLES = Object.keys(roles) as Role[]
