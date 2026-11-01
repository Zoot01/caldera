'use client'

import { createClient } from '@caldera-js/next/client'
import { useEffect, useState } from 'react'
import type { AppType } from '../src/http'

// Typed from your routes: paths, inputs and JSON responses (types only; no server code is bundled).
const api = createClient<AppType>()

export function Hello({ label }: { label: string }) {
  const [message, setMessage] = useState<string>()
  useEffect(() => {
    void api.hello.$get().then(async (res) => setMessage((await res.json()).message))
  }, [])
  return (
    <p>
      {label} {message ?? '…'}
    </p>
  )
}
