'use client'

import type { Hono } from 'hono'
import { hc, type ClientRequestOptions } from 'hono/client'
import { useState, useTransition } from 'react'
import type { ActionResult } from './action.js'

export type { ActionResult }

// This browser's realtime connection id, from @caldera-js/broadcast/client's state when it's in use.
const socketId = (): string | undefined =>
  ((globalThis as { [key: symbol]: unknown })[Symbol.for('caldera.broadcast.client')] as { transport?: { socketId(): string | undefined } } | undefined)?.transport?.socketId()

/**
 * A typed client for the app's routes, for client components: `createClient<AppType>('/api')`,
 * where `AppType` is `typeof router.app` (export it from a server file as a type only).
 * Calls carry the browser's cookies, so signed-in requests and the app session work, and the
 * realtime connection's id (X-Socket-ID), so `emit(…, { toOthers: true })` skips this browser.
 */
export function createClient<T extends Hono<any, any, any>>(baseUrl = '/api', options: ClientRequestOptions = {}): ReturnType<typeof hc<T>> {
  const own = options.headers
  return hc<T>(baseUrl, {
    init: { credentials: 'same-origin' },
    ...options,
    headers: async () => {
      const base = typeof own === 'function' ? await own() : (own ?? {})
      const id = socketId()
      return id ? { ...base, 'X-Socket-ID': id } : base
    },
  })
}

type Errors<D> = Partial<Record<keyof D | (string & {}), string>>

export interface Form<D extends Record<string, unknown>> {
  data: D
  setData<K extends keyof D>(key: K, value: D[K]): void
  setData(values: Partial<D>): void
  /** Validation errors from the last submit, one message per field. */
  errors: Errors<D>
  setError(field: keyof D | (string & {}), message: string): void
  clearErrors(...fields: (keyof D)[]): void
  /** True while the action runs (and while Next navigates after a redirect). */
  processing: boolean
  /** Back to the initial values: all of them, or these fields. */
  reset(...fields: (keyof D)[]): void
  /** Calls a server action with the form's data; its `errors` land on the fields. */
  submit<T>(action: (data: D) => Promise<ActionResult<T> | void>, options?: SubmitCallbacks<T>): void
}

export interface SubmitCallbacks<T> {
  onSuccess?: (result: ActionResult<T>) => void
  onError?: (result: ActionResult<T>) => void
  /** After either, e.g. to clear a password field. */
  onFinish?: () => void
}

/**
 * Form state for a server action, like Inertia's `useForm`: `form.submit(login)` sends `form.data` to
 * the action (which calls a route with `submit` from @caldera-js/next), and the route's validation errors
 * land in `form.errors`. A redirect from the route is Next's navigation.
 */
export function useForm<D extends Record<string, unknown>>(initial: D): Form<D> {
  const [defaults] = useState(initial)
  const [data, setValues] = useState(initial)
  const [errors, setErrors] = useState<Errors<D>>({})
  const [processing, startTransition] = useTransition()
  return {
    data,
    setData: ((keyOrValues: keyof D | Partial<D>, value?: unknown) =>
      setValues((current) => (typeof keyOrValues === 'object' ? { ...current, ...keyOrValues } : { ...current, [keyOrValues]: value }))) as Form<D>['setData'],
    errors,
    setError: (field, message) => setErrors((current) => ({ ...current, [field]: message })),
    clearErrors: (...fields) =>
      setErrors((current) => (fields.length ? Object.fromEntries(Object.entries(current).filter(([field]) => !fields.includes(field as keyof D))) : {}) as Errors<D>),
    processing,
    reset: (...fields) =>
      setValues((current) => (fields.length ? { ...current, ...Object.fromEntries(fields.map((field) => [field, defaults[field]])) } : defaults)),
    submit(action, callbacks = {}) {
      startTransition(async () => {
        try {
          const result = await action(data)
          if (!result) return
          setErrors((result.errors ?? {}) as Errors<D>)
          if (result.ok) callbacks.onSuccess?.(result)
          else callbacks.onError?.(result)
        } finally {
          callbacks.onFinish?.()
        }
      })
    },
  }
}
