import { configDefaults, defineConfig } from 'vitest/config'

// tests/browser is Playwright's (`{{ run }} test:browser`).
export default defineConfig({ test: { exclude: [...configDefaults.exclude, 'tests/browser/**'] } })
