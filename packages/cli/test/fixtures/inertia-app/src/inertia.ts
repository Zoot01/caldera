import { defineInertia } from '@caldera/inertia'

export const inertia = defineInertia({
  share: () => ({ auth: { user: null as { name: string } | null }, appName: () => 'Demo' }),
})
