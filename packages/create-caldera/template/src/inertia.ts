import { defineInertia, viteAssets } from '@caldera/inertia'

/** Pages: shared props, asset tags and the HTML shell. `caldera generate` types `share` for every page. */
export const inertia = defineInertia({
  assets: viteAssets({ entry: 'resources/app.tsx' }),
  title: '{{ name }}',
  share: () => ({
    appName: '{{ name }}',
  }),
})
