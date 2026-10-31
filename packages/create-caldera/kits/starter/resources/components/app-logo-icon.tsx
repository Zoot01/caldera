import type { SVGProps } from 'react'

/** The app's mark. Replace it with your own (it's used in the sidebar, header and auth pages). */
export function AppLogoIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true" {...props}>
      <path d="M6 24 16 6l10 18H6Z" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" />
      <path d="M11.5 24 16 16l4.5 8" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" />
    </svg>
  )
}
