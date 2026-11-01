import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import Script from 'next/script'
import type { ReactNode } from 'react'
import { type Shared, SharedProvider } from '@/components/shared'
import { config, context } from '@/lib/caldera'
import { AppearanceWatcher } from './appearance'
import { Realtime } from './realtime'
import './app.css'

// Every page reads the visitor's session, so none is prerendered.
export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  const name = config().app.name
  return { title: { default: name, template: `%s - ${name}` }, icons: { icon: { url: '/favicon.svg', type: 'image/svg+xml' } } }
}

// Before the first paint with the `system` setting: dark if the operating system is.
const SYSTEM_APPEARANCE = `(function(){var d=window.matchMedia('(prefers-color-scheme: dark)').matches;var r=document.documentElement;if(d)r.classList.add('dark');r.style.colorScheme=d?'dark':'light'})()`

export default async function RootLayout({ children }: { children: ReactNode }) {
  const { i18n, broadcast } = await context()
  // Light, dark or system, from the `appearance` cookie (set by the appearance settings).
  const value = (await cookies()).get('appearance')?.value
  const appearance: Shared['appearance'] = value === 'light' || value === 'dark' ? value : 'system'
  return (
    <html
      lang={i18n.locale}
      className={appearance === 'dark' ? 'dark' : undefined}
      style={appearance === 'system' ? undefined : { colorScheme: appearance }}
      suppressHydrationWarning
    >
      <body>
        {appearance === 'system' && (
          <Script id="system-appearance" strategy="beforeInteractive">
            {SYSTEM_APPEARANCE}
          </Script>
        )}
        <SharedProvider value={{ appName: config().app.name, appearance }}>
          <AppearanceWatcher />
          {/* Realtime for client components: how the browser reaches the realtime server. */}
          <Realtime config={broadcast.client() ?? null} />
          {children}
        </SharedProvider>
      </body>
    </html>
  )
}
