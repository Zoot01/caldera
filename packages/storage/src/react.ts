import { useCallback, useRef, useState } from 'react'
import type { SignedUpload } from './driver.js'
import type { PendingUpload } from './uploads.js'

export interface UploadState {
  status: 'idle' | 'uploading' | 'done' | 'error'
  /** 0 to 1 while the file goes up; null otherwise. */
  progress: number | null
  error: string | null
  file: PendingUpload | null
}

class UploadError extends Error {}

/**
 * Uploads straight to the bucket through `uploadRoutes()`: asks for a presigned URL, PUTs the file
 * with progress, then completes (the server checks the real bytes). Resolves with the checked file,
 * signed: send it with a form, validate it with `zupload(name)` and store it with `claimUpload(file)`.
 * Error messages are the server's (they say which rule failed).
 */
export function useUpload(upload: string, options: { endpoint?: string } = {}) {
  const endpoint = options.endpoint ?? '/_caldera/uploads'
  const [state, setState] = useState<UploadState>({ status: 'idle', progress: null, error: null, file: null })
  const current = useRef<XMLHttpRequest | null>(null)

  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' })
    const json = (await response.json().catch(() => ({}))) as T & { error?: { message?: string } }
    if (!response.ok) throw new UploadError(json.error?.message ?? `Upload failed (HTTP ${response.status}).`)
    return json
  }

  const put = (signed: SignedUpload, file: File) =>
    new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      current.current = xhr
      xhr.open(signed.method, signed.url)
      for (const [name, value] of Object.entries(signed.headers)) xhr.setRequestHeader(name, value)
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) setState((s) => ({ ...s, progress: event.loaded / event.total }))
      }
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new UploadError(`The storage service refused the file (HTTP ${xhr.status}).`)))
      xhr.onerror = () => reject(new UploadError('The upload was interrupted. Check your connection and try again.'))
      xhr.onabort = () => reject(new UploadError('The upload was cancelled.'))
      xhr.send(file)
    })

  const start = useCallback(
    async (file: File): Promise<PendingUpload> => {
      setState({ status: 'uploading', progress: 0, error: null, file: null })
      try {
        const { upload: signed, token } = await post<{ upload: SignedUpload; token: string }>(endpoint, { upload, name: file.name, size: file.size, type: file.type || 'application/octet-stream' })
        await put(signed, file)
        const { file: stored } = await post<{ file: PendingUpload }>(`${endpoint}/complete`, { token })
        setState({ status: 'done', progress: 1, error: null, file: stored })
        return stored
      } catch (error) {
        const message = error instanceof UploadError ? error.message : 'The upload failed.'
        setState({ status: 'error', progress: null, error: message, file: null })
        throw error
      } finally {
        current.current = null
      }
    },
    [endpoint, upload],
  )

  return {
    ...state,
    upload: start,
    cancel: () => current.current?.abort(),
    reset: () => setState({ status: 'idle', progress: null, error: null, file: null }),
  }
}
