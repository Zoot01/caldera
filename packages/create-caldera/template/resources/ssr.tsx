import { createInertiaApp } from '@inertiajs/react'
import { renderToString } from 'react-dom/server'
// Also here so server-rendered pages arrive styled in development (Vite links it in the head).
import './app.css'
import { title } from './title.js'

type Page = Record<string, unknown>
type Render = (page: Page, render: typeof renderToString) => Promise<{ head: string[]; body: string }>

// The same app as app.tsx, rendered on the server for first loads (viteSsr() in src/inertia.ts):
// HTML arrives with the content in it, and the browser hydrates it. Pages are found in ./pages.
const render = createInertiaApp({ title }) as unknown as Promise<Render>

export default async (page: Page) => (await render)(page, renderToString)
