import { expect, test } from '@playwright/test'
import { logOut, PASSWORD, register, visit } from './helpers'

test('registers, lands on the dashboard, logs out and back in', async ({ page }) => {
  const { name, email } = await register(page)
  await expect(page).toHaveTitle(/^Dashboard/)
  await logOut(page, name)

  await visit(page, '/login')
  await page.getByLabel('Email address').fill(email)
  await page.getByPlaceholder('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Log in' }).click()
  await expect(page).toHaveURL(/\/dashboard$/)
})

test('a wrong password is refused with a message', async ({ page }) => {
  const { name, email } = await register(page)
  await logOut(page, name)
  await visit(page, '/login')
  await page.getByLabel('Email address').fill(email)
  await page.getByPlaceholder('Password').fill('not-the-password')
  await page.getByRole('button', { name: 'Log in' }).click()
  await expect(page.getByText('These credentials don’t match our records.')).toBeVisible()
  await expect(page).toHaveURL(/\/login$/)
})

test('signed out, the dashboard sends people to the login page', async ({ page }) => {
  await page.goto('/dashboard')
  await expect(page).toHaveURL(/\/login$/)
})
