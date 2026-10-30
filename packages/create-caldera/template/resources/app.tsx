import '@vitejs/plugin-react/preamble'
import { createInertiaApp } from '@inertiajs/react'
import './app.css'
import { title } from './title.js'

// Pages are found in ./pages by name: c.render('Home') loads pages/Home.tsx. Pages rendered on the
// server (resources/ssr.tsx) are hydrated here.
createInertiaApp({ title })
