import { expect, test, type Page } from '@playwright/test'
import { register, uniqueEmail, visit } from './helpers'

const switcher = (page: Page) => page.locator('[data-slot=sidebar-header]')

test('everyone starts in a personal team', async ({ page }) => {
  await register(page, { name: 'Ann Lee' })
  await expect(switcher(page)).toContainText("Ann's Team")
})

test('creates a team, invites someone by email, and they join it', async ({ browser, page }) => {
  await register(page, { name: 'Ann Lee' })
  await switcher(page).getByRole('button').first().click()
  await page.getByRole('menuitem', { name: 'New team' }).click()
  await page.getByLabel('Team name').fill('Acme')
  await page.getByRole('button', { name: 'Create team' }).click()
  await expect(page).toHaveURL(/\/settings\/teams\/[0-9a-f-]{36}$/)
  await expect(switcher(page)).toContainText('Acme')

  const bobEmail = uniqueEmail('bob')
  await page.waitForLoadState('networkidle')
  await page.getByLabel('Email address').fill(bobEmail)
  await page.getByRole('button', { name: 'Invite', exact: true }).click()
  await expect(page.getByText(bobEmail)).toBeVisible()

  // The invitation email, from the outbox the log mailer keeps.
  const outbox = (await (await page.request.get('/_caldera/mail/outbox', { headers: { accept: 'application/json' } })).json()) as {
    messages: { to: { email: string }[]; text: string }[]
  }
  const message = outbox.messages.find((m) => m.to.some((to) => to.email === bobEmail))
  const link = /https?:\/\/[^\s]+\/invitations\/[0-9a-f-]+/.exec(message?.text ?? '')?.[0]
  expect(link).toBeDefined()

  // Bob, in a browser of his own: registers, opens the link, joins, and lands in Acme.
  const bob = await (await browser.newContext()).newPage()
  await register(bob, { name: 'Bob Ray', email: bobEmail })
  await visit(bob, link!)
  await bob.getByRole('button', { name: 'Join team' }).click()
  await expect(bob).toHaveURL(/\/dashboard$/)
  await expect(switcher(bob)).toContainText('Acme')

  // Back to his own team from the switcher.
  await switcher(bob).getByRole('button').first().click()
  await bob.getByRole('menuitem', { name: /Bob's Team/ }).click()
  await expect(switcher(bob)).toContainText("Bob's Team")

  // Ann sees him in the team.
  await page.reload()
  await expect(page.getByRole('button', { name: 'Manage Bob Ray' })).toBeVisible()
  await bob.context().close()
})
