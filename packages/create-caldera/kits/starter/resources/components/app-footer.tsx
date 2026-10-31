import { usePage } from '@inertiajs/react'
import { footerNavItems } from '@/components/navigation'

/** The last row of the page panel: the app's name, and the footer links (resources/components/navigation.ts). */
export function AppFooter() {
  const { appName } = usePage().props
  return (
    <footer className="flex items-center justify-between gap-4 px-4 py-3 text-muted-foreground text-xs md:px-6">
      <span>{appName}</span>
      <nav className="flex gap-4" aria-label="Footer">
        {footerNavItems.map((item) => (
          <a key={item.href} href={item.href} target="_blank" rel="noopener" className="hover:text-foreground">
            {item.title}
          </a>
        ))}
      </nav>
    </footer>
  )
}
