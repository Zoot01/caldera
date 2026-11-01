import { configDefaults, defineConfig } from 'vitest/config'

// Next needs `jsx: "preserve"` in tsconfig.json; tests compile JSX (mail templates) themselves.
// tests/browser is Playwright's (`{{ run }} test:browser`).
export default defineConfig({ test: { exclude: [...configDefaults.exclude, 'tests/browser/**'] }, oxc: { jsx: { runtime: 'automatic' } } })
