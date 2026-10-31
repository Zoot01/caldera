import { expect, test } from '@playwright/test'
import { register } from './helpers'

test('⌘K (Ctrl+K) opens the command menu: type to find a page, Enter to go there', async ({ page }) => {
  await register(page)
  await page.keyboard.press('ControlOrMeta+K')
  const search = page.getByPlaceholder('Search pages and commands…')
  await expect(search).toBeFocused()
  await search.fill('security')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/settings\/security$/)
})

test('the search button opens it too, and it switches to dark mode', async ({ page }) => {
  await register(page)
  await page.getByRole('button', { name: 'Search' }).click()
  await page.getByRole('option', { name: 'Dark mode' }).click()
  await expect(page.locator('html')).toHaveClass(/\bdark\b/)
})
