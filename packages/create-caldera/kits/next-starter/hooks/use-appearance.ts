'use client'

import { useShared } from '@/components/shared'
import { useSyncExternalStore } from 'react'

export type Appearance = 'light' | 'dark' | 'system'

// The choice lives in a cookie, so the server renders the right theme on the first paint
// (app/layout.tsx). `system` follows the operating system, live.
const COOKIE = 'appearance'
const listeners = new Set<() => void>()
const prefersDark = () => window.matchMedia('(prefers-color-scheme: dark)')

function current(): Appearance {
  const value = /(?:^|;\s*)appearance=([^;]*)/.exec(document.cookie)?.[1]
  return value === 'light' || value === 'dark' ? value : 'system'
}

function apply(appearance: Appearance) {
  const dark = appearance === 'dark' || (appearance === 'system' && prefersDark().matches)
  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  for (const listener of listeners) listener()
}

export function setAppearance(appearance: Appearance) {
  document.cookie = `${COOKIE}=${appearance}; path=/; max-age=31536000; samesite=lax`
  apply(appearance)
}

/** Called once by the root layout: keeps `system` in step when the operating system switches. */
export function initializeAppearance() {
  prefersDark().addEventListener('change', () => {
    if (current() === 'system') apply('system')
  })
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const resolvedNow = () => (document.documentElement.classList.contains('dark') ? 'dark' : 'light')

/** The choice (`appearance`), what's showing (`resolved`: light or dark), and how to change it. */
export function useAppearance() {
  // While hydrating, the server's answer (from the cookie), so the markup matches.
  const server = useShared().appearance
  const appearance = useSyncExternalStore(subscribe, current, () => server)
  const resolved = useSyncExternalStore(subscribe, resolvedNow, () => (server === 'dark' ? 'dark' : 'light'))
  return { appearance, resolved, setAppearance }
}
