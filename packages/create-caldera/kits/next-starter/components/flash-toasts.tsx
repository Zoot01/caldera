'use client'

import { type ReactNode, useEffect, useState } from 'react'
import { consumeFlash } from '@/app/actions/auth'
import { ToastProvider, toastManager } from '@/components/ui/toast'

export interface Flash {
  success?: string
  error?: string
  status?: string
}

/**
 * Shows `back(c).with('success', '…')` and `.with('error', '…')` as toasts. The layout reads what was
 * flashed while rendering; rendering can't change the session, so once shown it's cleared here.
 */
function Toasts({ flash }: { flash: Flash }) {
  useEffect(() => {
    if (typeof flash.success === 'string') toastManager.add({ title: flash.success, type: 'success' })
    if (typeof flash.error === 'string') toastManager.add({ title: flash.error, type: 'error' })
    if (Object.keys(flash).length > 0) void consumeFlash()
  }, [flash])
  return null
}

/** Where toasts appear (the app layouts wrap every page in it). */
export function FlashToasts({ flash, children }: { flash: Flash; children: ReactNode }) {
  return (
    <ToastProvider>
      <Toasts flash={flash} />
      {children}
    </ToastProvider>
  )
}

/**
 * For pages answered with a status code (`back(c).with('status', 'profile-updated')`): shows the
 * page's message for it as a toast. The page passes `status` from `flash()` (lib/caldera.ts).
 */
export function useStatusToast(status: string | undefined, messages: Record<string, string>) {
  useEffect(() => {
    const message = messages[String(status ?? '')]
    if (message) toastManager.add({ title: message, type: 'success' })
    // The messages are constants: a new status is what shows one.
  }, [status])
}

/** A value from the server kept for as long as the component lives (flashed values are cleared once shown). */
export function useKept<T>(value: T): T {
  const [kept, setKept] = useState(value)
  useEffect(() => {
    if (value !== undefined && value !== null) setKept(value)
  }, [value])
  return kept
}

/** For pages that show what was flashed themselves (a status line): clears it once shown. */
export function ClearFlash({ when }: { when: unknown }) {
  useEffect(() => {
    if (when !== undefined) void consumeFlash()
  }, [when])
  return null
}
