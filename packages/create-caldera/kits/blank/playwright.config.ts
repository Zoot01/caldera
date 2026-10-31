import { defineConfig, devices } from '@playwright/test'

// Browser tests (tests/browser): `{{ run }} test:browser`. Playwright builds the app and serves the build
// on port 3100 (tests/browser/server.ts), on a database of its own that starts empty on every run.
const url = 'http://localhost:3100'

export default defineConfig({
  testDir: 'tests/browser',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: url, trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: '{{ run }} build && node --import tsx tests/browser/server.ts',
    url,
    timeout: 180_000,
    // Win over .env: this port, a realtime server of the tests' own (server.ts starts it), mail kept in
    // the outbox at /_caldera/mail/outbox for tests to read.
    env: { PORT: '3100', APP_URL: url, BROADCAST_CONNECTION: 'server', BROADCAST_PORT: '6101', MAIL_MAILER: 'log', QUEUE_CONNECTION: 'sync' },
  },
})
