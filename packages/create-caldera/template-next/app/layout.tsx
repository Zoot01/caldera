import type { ReactNode } from 'react'
import { requestContext } from '@caldera/next'
import type { RequestI18n } from '@caldera/i18n'
import { app } from '../src/app'
import './globals.css'

export const metadata = { title: '{{ name }}' }

export default async function RootLayout({ children }: { children: ReactNode }) {
  // The visitor's locale, from the same detection the API uses (cookie, Accept-Language).
  const { i18n } = await requestContext<{ i18n: RequestI18n }>(app)
  return (
    <html lang={i18n.locale}>
      <body>{children}</body>
    </html>
  )
}
