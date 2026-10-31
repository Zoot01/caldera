import type { Page } from '@playwright/test'

/** Opens a page and waits until React has taken it over: clicks before that do nothing. */
export async function visit(page: Page, path: string) {
  await page.goto(path)
  await page.waitForLoadState('networkidle')
}
