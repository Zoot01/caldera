'use server'

import { submit } from '@caldera/next'
import { http } from '@/src/http'

// Each form's server action: it posts to the app's route (src/routes/auth.ts), as the browser would.
// A route's redirect is Next's navigation; its validation errors come back for the form.

export const register = async (data: { name: string; email: string; password: string; passwordConfirmation: string }) => submit(http, '/register', data)
export const login = async (data: { email: string; password: string; remember: boolean; redirect?: string }) => submit(http, '/login', data)
export const twoFactorChallenge = async (data: { code?: string; recoveryCode?: string; remember: boolean; redirect?: string }) => submit(http, '/two-factor-challenge', data)
export const logout = async () => submit(http, '/logout')
export const forgotPassword = async (data: { email: string }) => submit(http, '/forgot-password', data)
export const resetPassword = async (data: { token: string; password: string; passwordConfirmation: string }) => submit(http, '/reset-password', data)
export const resendVerification = async () => submit(http, '/email/verification-notification')
export const confirmPassword = async (data: { password: string; redirect?: string }) => submit(http, '/confirm-password', data)

/** Clears what the last route flashed, once a page has shown it (components/flash-toasts.tsx). */
export const consumeFlash = async () => void (await submit(http, '/_caldera/flash'))
