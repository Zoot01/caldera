/** The document title for a page, shared by the browser entry (app.tsx) and server rendering (ssr.tsx). */
export const title = (title: string) => (title ? `${title} · {{ name }}` : '{{ name }}')
