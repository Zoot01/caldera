import { defineConfig } from '@caldera-js/core'

export const mail = defineConfig('mail', () => ({ default: 'memory' as const, mailers: { memory: { driver: 'memory' } }, from: 'App <app@example.test>' }))
