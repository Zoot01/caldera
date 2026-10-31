import { usePage } from '@inertiajs/react'
import { type ReactNode, useEffect } from 'react'
import { ToastProvider, toastManager } from '@/components/ui/toast'

/** Shows `back(c).with('success', '…')` and `.with('error', '…')` as toasts, once per response. */
function Toasts() {
  const { flash } = usePage()
  useEffect(() => {
    if (typeof flash.success === 'string') toastManager.add({ title: flash.success, type: 'success' })
    if (typeof flash.error === 'string') toastManager.add({ title: flash.error, type: 'error' })
  }, [flash])
  return null
}

/** Where toasts appear (the app layouts wrap every page in it). */
export function FlashToasts({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <Toasts />
      {children}
    </ToastProvider>
  )
}

/**
 * For pages answered with a status code (`back(c).with('status', 'profile-updated')`): shows the
 * page's message for it as a toast. `useStatusToast({ 'profile-updated': 'Profile saved.' })`.
 */
export function useStatusToast(messages: Record<string, string>) {
  const { flash } = usePage()
  useEffect(() => {
    const message = messages[String(flash.status ?? '')]
    if (message) toastManager.add({ title: message, type: 'success' })
    // The messages are constants: a new flash is what shows one.
  }, [flash])
}
