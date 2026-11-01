'use client'

import { useEffect } from 'react'
import { initializeAppearance } from '@/hooks/use-appearance'

/** Keeps `system` in step when the operating system switches between light and dark. */
export function AppearanceWatcher() {
  useEffect(() => initializeAppearance(), [])
  return null
}
