import { expect, test } from '@playwright/test'
import { totp } from '../totp'
import { logOut, PASSWORD, register, virtualAuthenticator, visit } from './helpers'

test('adds a passkey, then signs in with it', async ({ context, page }) => {
  const authenticator = await virtualAuthenticator(context, page)
  const { name } = await register(page)
  await visit(page, '/settings/security')
  await page.getByLabel('Passkey name').fill('Test laptop')
  await page.getByRole('button', { name: 'Add a passkey' }).click()
  await expect(page.getByText('Test laptop')).toBeVisible()
  expect(await authenticator.credentials()).toHaveLength(1)

  await logOut(page, name)
  // The button, not the browser's autofill (which the virtual authenticator would answer at once).
  await page.addInitScript(() => {
    if (window.PublicKeyCredential) PublicKeyCredential.isConditionalMediationAvailable = async () => false
  })
  await visit(page, '/login')
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click()
  await expect(page).toHaveURL(/\/dashboard$/)
})

test('turns on two-factor authentication, then asks for a code at sign-in', async ({ page }) => {
  const { name, email } = await register(page)
  await visit(page, '/settings/security')
  await page.getByRole('button', { name: 'Turn on two-factor authentication' }).click()
  await page.getByRole('dialog').getByLabel('Password').fill(PASSWORD)
  await page.getByRole('dialog').getByRole('button', { name: 'Continue' }).click()
  // The setup key under the QR code, for authenticator apps that can't scan.
  const key = (await page.locator('code').filter({ hasText: /^[A-Z2-7]+=*$/ }).first().textContent())!.trim()
  await page.getByLabel('Authentication code').locator('input').first().click()
  await page.keyboard.type(totp(key))
  await expect(page.getByText('Save your recovery codes')).toBeVisible()

  await logOut(page, name)
  await visit(page, '/login')
  await page.getByLabel('Email address').fill(email)
  await page.getByPlaceholder('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Log in' }).click()
  await expect(page).toHaveURL(/\/two-factor-challenge$/)
  await page.waitForLoadState('networkidle')
  await page.getByLabel('Authentication code').locator('input').first().click()
  await page.keyboard.type('000000')
  await expect(page.getByText('That code is invalid.')).toBeVisible()
  // The next 30-second step: the setup's code can't be used twice.
  await page.getByLabel('Authentication code').locator('input').first().click()
  await page.keyboard.type(totp(key, Date.now() + 30_000))
  await expect(page).toHaveURL(/\/dashboard$/)
})
