import { CalderaLogo } from '@/components/caldera-logo'
import { footerNavItems } from '@/components/navigation'

/** The last row of the page panel: Caldera's brandmark (put yours here), and the footer links (resources/components/navigation.ts). */
export function AppFooter() {
  return (
    <footer className="flex items-center justify-between gap-4 px-4 py-3 text-muted-foreground text-xs md:px-6">
      <CalderaLogo className="h-4 w-auto" />
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
