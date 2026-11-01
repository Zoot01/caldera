'use server'

import { submit } from '@caldera-js/next'
import { http } from '@/src/http'

// The settings pages' server actions, posting to src/routes/settings.ts.

export const updateProfile = async (data: { name: string; email: string }) => submit(http, '/settings/profile', data, { method: 'PATCH' })
export const deleteAccount = async (data: { password: string }) => submit(http, '/settings/profile', data, { method: 'DELETE' })
export const updatePassword = async (data: { currentPassword: string; password: string; passwordConfirmation: string }) =>
  submit(http, '/settings/password', data, { method: 'PUT' })
export const enableTwoFactor = async (data: { password: string }) => submit(http, '/settings/two-factor', data)
export const confirmTwoFactor = async (data: { code: string }) => submit(http, '/settings/two-factor/confirm', data)
export const cancelTwoFactorSetup = async () => submit(http, '/settings/two-factor/setup', {}, { method: 'DELETE' })
export const disableTwoFactor = async (data: { password: string }) => submit(http, '/settings/two-factor', data, { method: 'DELETE' })
export const newRecoveryCodes = async (data: { password: string }) => submit(http, '/settings/two-factor/recovery-codes', data)
export const deletePasskey = async (id: string) => submit(http, `/settings/passkeys/${encodeURIComponent(id)}`, {}, { method: 'DELETE' })
