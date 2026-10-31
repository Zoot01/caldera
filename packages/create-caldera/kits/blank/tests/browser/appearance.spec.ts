import { expect, test } from '@playwright/test'
import { visit } from './helpers'

test('switches to dark mode, and the server remembers it on the next visit', async ({ page }) => {
  await visit(page, '/')
  const html = page.locator('html')
  await page.getByRole('button', { name: 'Dark' }).click()
  await expect(html).toHaveClass(/\bdark\b/)
  // Rendered dark by the server from the cookie: no flash of light on load.
  await page.reload()
  await expect(html).toHaveClass(/\bdark\b/)
  // The class is in the server's HTML, so wait for React before clicking (a click before it's ignored).
  await page.waitForLoadState('networkidle')
  await page.getByRole('button', { name: 'Light' }).click()
  await expect(html).not.toHaveClass(/\bdark\b/)
})

test('system follows the operating system', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await visit(page, '/')
  await page.getByRole('button', { name: 'System' }).click()
  await expect(page.locator('html')).toHaveClass(/\bdark\b/)
  await page.emulateMedia({ colorScheme: 'light' })
  await page.reload()
  await expect(page.locator('html')).not.toHaveClass(/\bdark\b/)
})

test('no errors in the console', async ({ page }) => {
  const errors: string[] = []
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()))
  page.on('pageerror', (error) => errors.push(String(error)))
  await visit(page, '/')
  expect(errors).toEqual([])
})
