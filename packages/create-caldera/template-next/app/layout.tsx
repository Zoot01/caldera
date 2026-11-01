import type { ReactNode } from 'react'
import type { Broadcaster } from '@caldera-js/broadcast'
import { requestContext } from '@caldera-js/next'
import type { RequestI18n } from '@caldera-js/i18n'
import { app } from '../src/app'
import { Realtime } from './realtime'
import './globals.css'

export const metadata = { title: '{{ name }}' }

export default async function RootLayout({ children }: { children: ReactNode }) {
  // The visitor's locale, from the same detection the API uses (cookie, Accept-Language).
  const { i18n, broadcast } = await requestContext<{ i18n: RequestI18n; broadcast: Broadcaster }>(app)
  return (
    <html lang={i18n.locale}>
      <body>
        {/* Realtime for client components: how the browser reaches the realtime server. */}
        <Realtime config={broadcast.client() ?? null} />
        {children}
      </body>
    </html>
  )
}
