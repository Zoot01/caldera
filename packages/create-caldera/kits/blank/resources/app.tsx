import '@vitejs/plugin-react/preamble'
import { configureBroadcast, withSocketId } from '@caldera-js/broadcast/client'
import { http } from '@inertiajs/core'
import { createInertiaApp, router } from '@inertiajs/react'
import '../.caldera/broadcast.client.gen.js'
import { initializeAppearance } from '@/hooks/use-appearance'
import './app.css'
import { layout } from './layout.js'
import { title } from './title.js'

// Realtime: useChannel()/usePresence() from @caldera-js/broadcast/react connect with the `broadcast`
// page prop, and every request carries this browser's socket id, so `toOthers` broadcasts skip it.
router.on('navigate', (event) => configureBroadcast(event.detail.page.props.broadcast))
http.onRequest(withSocketId)

// Links prefetch pages on hover and keep them for a while. After anything that changes data (a form
// post: switching teams, saving a profile) those copies are stale: forget them, or the next click
// shows the page as it was, with the old team or name, until a reload.
router.on('finish', (event) => {
  const { method, completed } = event.detail.visit
  if (method !== 'get' && completed) router.flushAll()
})

// Light, dark or system (the server already rendered the right one); `system` follows the OS live.
initializeAppearance()

// Pages are found in ./pages by name: c.render('Home') loads pages/Home.tsx. Pages rendered on the
// server (resources/ssr.tsx) are hydrated here.
createInertiaApp({ title, layout })
