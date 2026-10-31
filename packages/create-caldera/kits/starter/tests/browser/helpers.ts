import { randomUUID } from 'node:crypto'
import { expect, type BrowserContext, type Page } from '@playwright/test'

export const PASSWORD = 'correct-horse-battery'

/** Opens a page and waits until React has taken it over: clicks before that do nothing. */
export async function visit(page: Page, path: string) {
  await page.goto(path)
  await page.waitForLoadState('networkidle')
}

/** An address no other test uses: tests run in parallel against one database. */
export function uniqueEmail(name = 'user') {
  return `${name}-${randomUUID().slice(0, 8)}@example.test`
}

/** Registers through the form, which signs in and lands on the dashboard. */
export async function register(page: Page, { name = 'Ann Lee', email = uniqueEmail() }: { name?: string; email?: string } = {}) {
  await visit(page, '/register')
  await page.getByLabel('Name').fill(name)
  await page.getByLabel('Email address').fill(email)
  await page.getByPlaceholder('Password', { exact: true }).fill(PASSWORD)
  await page.getByPlaceholder('Confirm password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page).toHaveURL(/\/dashboard$/)
  await page.waitForLoadState('networkidle')
  return { name, email }
}

/** Logs out from the user menu. */
export async function logOut(page: Page, name: string) {
  await visit(page, '/dashboard')
  await page.getByRole('button', { name }).click()
  await page.getByRole('menuitem', { name: 'Log out' }).click()
  await expect(page).toHaveURL(/\/$/)
}

/** Chrome's virtual authenticator: a platform passkey (like Touch ID) that always verifies the user. */
export async function virtualAuthenticator(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  })
  return { credentials: async () => (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials }
}
