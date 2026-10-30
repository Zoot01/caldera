import caldera from '@caldera/inertia/vite'
import inertia from '@inertiajs/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [caldera({ input: 'resources/app.tsx', ssr: 'resources/ssr.tsx' }), inertia({ ssr: 'resources/ssr.tsx' }), react()],
})
