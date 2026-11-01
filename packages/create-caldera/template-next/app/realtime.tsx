'use client'

import { configureBroadcast, type BroadcastClientConfig } from '@caldera-js/broadcast/client'
import { useEffect } from 'react'
// Channel types for the browser (no server code): from src/channels, by `caldera generate`.
import '../.caldera/broadcast.client.gen'

/**
 * Connects useChannel()/usePresence() (@caldera-js/broadcast/react) to the realtime server: the root
 * layout passes the connection's client config (no secrets; null when broadcasts are only logged).
 */
export function Realtime({ config }: { config: BroadcastClientConfig | null }) {
  useEffect(() => configureBroadcast(config), [config])
  return null
}
