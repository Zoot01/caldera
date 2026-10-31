import { createGetUrl } from 'fumadocs-core/source';

export const appName = 'Caldera';
export const docsRoute = '/docs';
export const docsContentRoute = '/llms.mdx/docs';

const getContentUrl = createGetUrl(docsContentRoute);

/** Each page as Markdown (for "Copy page" and AI tools): `/docs/installation.md` too. */
export function getPageMarkdownUrl(page: { slugs: string[]; locale?: string }) {
  const segments = [...page.slugs, 'content.md'];

  return { segments, url: getContentUrl(segments, page.locale) };
}
