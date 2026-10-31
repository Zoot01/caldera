import type { SVGProps } from 'react'

/** The app's mark: Caldera's, until you replace it with your own (the sidebar, header and auth pages use it). */
export function AppLogoIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 12 49.25 49.25" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M0.137857 36.5L0.0875148 24.25L0.0455627 12H24.5875H49.1295V36.5V61H36.8795H24.5V48.9094L36.8795 48.9346V36.5084V24.0822H24.5456H12.2117V30.2911V36.5H6.17056H0.137857Z" />
      <path d="M12.3796 42.625V48.75H18.4207H24.4618V42.625V36.5H18.4207H12.3796V42.625Z" />
      <path d="M0 55.125V61.25H6.0411H12.0822V55.125V49H6.0411H0V55.125Z" />
    </svg>
  )
}
