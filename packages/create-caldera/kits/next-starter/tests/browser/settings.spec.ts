import { expect, test } from '@playwright/test'
import { register, visit } from './helpers'

test('saves the profile: a toast once, and the new name everywhere', async ({ page }) => {
  await register(page, { name: 'Ann Lee' })
  await visit(page, '/settings/profile')
  await page.getByLabel('Name').fill('Ann Smith')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Profile saved.')).toBeVisible()
  // The header's account menu has the new name: the layout rendered again after the change.
  await expect(page.getByRole('button', { name: 'Account: Ann Smith' })).toBeVisible()
  // Shown once: not again on the next visit.
  await page.reload()
  await page.waitForLoadState('networkidle')
  await expect(page.getByLabel('Name')).toHaveValue('Ann Smith')
  await expect(page.getByText('Profile saved.')).toHaveCount(0)
})

test('shows validation errors from the route on the form', async ({ page }) => {
  await register(page)
  await visit(page, '/settings/security')
  await page.getByLabel('Current password').fill('not-my-password')
  await page.getByLabel('New password').fill('another-password')
  await page.getByLabel('Confirm password').fill('another-password')
  await page.getByRole('button', { name: 'Save password' }).click()
  await expect(page.getByText('That password is incorrect.')).toBeVisible()
})
