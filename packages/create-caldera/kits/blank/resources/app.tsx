import '@vitejs/plugin-react/preamble'
import { configureBroadcast, withSocketId, type BroadcastClientConfig } from '@caldera/broadcast/client'
import { http } from '@inertiajs/core'
import { createInertiaApp, router } from '@inertiajs/react'
import '../.caldera/broadcast.client.gen.js'
import './app.css'
import { title } from './title.js'

// Realtime: useChannel()/usePresence() from @caldera/broadcast/react connect with the `broadcast`
// page prop, and every request carries this browser's socket id, so `toOthers` broadcasts skip it.
// (Typed here: @inertiajs/core's types use extensionless imports, which NodeNext resolution doesn't follow.)
router.on('navigate', (event: CustomEvent<{ page: { props: { broadcast?: BroadcastClientConfig | null } } }>) => configureBroadcast(event.detail.page.props.broadcast))
http.onRequest(withSocketId)

// Pages are found in ./pages by name: c.render('Home') loads pages/Home.tsx. Pages rendered on the
// server (resources/ssr.tsx) are hydrated here.
createInertiaApp({ title })
