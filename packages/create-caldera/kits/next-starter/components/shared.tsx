'use client'

import { createContext, type ReactNode, use } from 'react'
import type { Appearance } from '@/hooks/use-appearance'

export interface Shared {
  appName: string
  /** The `appearance` cookie, so the server renders the right theme. */
  appearance: Appearance
}

const SharedContext = createContext<Shared>({ appName: '', appearance: 'system' })

/** What every client component may need, from the root layout (app/layout.tsx). */
export function SharedProvider({ value, children }: { value: Shared; children: ReactNode }) {
  return <SharedContext value={value}>{children}</SharedContext>
}

export const useShared = () => use(SharedContext)
