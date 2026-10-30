/**
 * The layout a page is wrapped in, by page name (used by app.tsx and ssr.tsx). None here: pages
 * render on their own. A page can still set its own with `Page.layout = MyLayout`.
 */
export const layout = (_name: string) => null
