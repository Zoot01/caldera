import { fileURLToPath } from 'node:url'
import caldera from '@caldera/inertia/vite'
import inertia from '@inertiajs/vite'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [caldera({ input: 'resources/app.tsx', ssr: 'resources/ssr.tsx' }), inertia({ ssr: 'resources/ssr.tsx' }), react(), tailwindcss()],
  // `@/components/ui/button` is resources/components/ui/button.tsx (as in tsconfig.json and components.json).
  resolve: { alias: { '@': fileURLToPath(new URL('./resources', import.meta.url)) } },
})
