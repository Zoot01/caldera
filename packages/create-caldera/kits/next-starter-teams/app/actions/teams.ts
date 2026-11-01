'use server'

import { submit } from '@caldera/next'
import { http } from '@/src/http'

// The teams pages' server actions, posting to src/routes/teams.ts (which checks every permission).

const team = (id: string) => `/settings/teams/${encodeURIComponent(id)}`

export const switchTeam = async (teamId: string) => submit(http, '/teams/switch', { teamId })
export const createTeam = async (data: { name: string }) => submit(http, '/settings/teams', data)
export const renameTeam = async (teamId: string, data: { name: string }) => submit(http, team(teamId), data, { method: 'PATCH' })
export const deleteTeam = async (teamId: string) => submit(http, team(teamId), {}, { method: 'DELETE' })
export const leaveTeam = async (teamId: string) => submit(http, `${team(teamId)}/leave`)
export const invite = async (teamId: string, data: { email: string; role: 'admin' | 'member' }) => submit(http, `${team(teamId)}/invitations`, data)
export const cancelInvitation = async (teamId: string, invitationId: string) =>
  submit(http, `${team(teamId)}/invitations/${encodeURIComponent(invitationId)}`, {}, { method: 'DELETE' })
export const changeRole = async (teamId: string, memberId: string, role: 'admin' | 'member') =>
  submit(http, `${team(teamId)}/members/${encodeURIComponent(memberId)}`, { role }, { method: 'PATCH' })
export const makeOwner = async (teamId: string, memberId: string) => submit(http, `${team(teamId)}/members/${encodeURIComponent(memberId)}/transfer`)
export const removeMember = async (teamId: string, memberId: string) =>
  submit(http, `${team(teamId)}/members/${encodeURIComponent(memberId)}`, {}, { method: 'DELETE' })
export const acceptInvitation = async (invitationId: string) => submit(http, `/invitations/${encodeURIComponent(invitationId)}/accept`)
export const rejectInvitation = async (invitationId: string) => submit(http, `/invitations/${encodeURIComponent(invitationId)}/reject`)
