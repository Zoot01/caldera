import '@vitejs/plugin-react/preamble'
import { createInertiaApp } from '@inertiajs/react'
import './app.css'

// Pages are found in ./pages by name: c.render('Home') loads pages/Home.tsx.
createInertiaApp({
  title: (title: string) => (title ? `${title} · {{ name }}` : '{{ name }}'),
})
