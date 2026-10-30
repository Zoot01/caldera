export { defineInertia, htmlLang, location, serializePage } from './inertia.js'
export type {
  InertiaDefinition,
  InertiaOptions,
  InertiaRegister,
  PageName,
  PageObject,
  PageRegistry,
  RenderOptions,
  RenderProps,
  RootViewContext,
  SharedProps,
  SharedPropsOf,
} from './inertia.js'
export { always, defer, optional } from './props.js'
export type { Prop, PropInput, PropsInput } from './props.js'
export { renderOnServer, setSsrRender, viteSsr } from './ssr.js'
export type { SsrRenderer, SsrResult } from './ssr.js'
export { setViteManifest, viteAssets } from './vite.js'
export type { ManifestChunk, ViteAssets, ViteAssetsOptions, ViteManifest } from './vite.js'
