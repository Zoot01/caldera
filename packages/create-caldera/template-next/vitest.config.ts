import { defineConfig } from 'vitest/config'

// Next needs `jsx: "preserve"` in tsconfig.json; tests compile JSX (mail templates) themselves.
export default defineConfig({ oxc: { jsx: { runtime: 'automatic' } } })
