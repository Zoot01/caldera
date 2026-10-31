import { router } from '@inertiajs/react'
import { LogOut, Monitor, Moon, Search, Settings, Sun } from 'lucide-react'
import { type ComponentType, Fragment, useEffect, useState } from 'react'
import { footerNavItems, mainNavItems, settingsNavItems } from '@/components/navigation'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandCollection,
  CommandDialog,
  CommandDialogPopup,
  CommandDialogTrigger,
  CommandEmpty,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
  CommandSeparator,
} from '@/components/ui/command'
import { setAppearance } from '@/hooks/use-appearance'
import { cn } from '@/lib/utils'

export interface CommandEntry {
  /** Unique within its group. */
  value: string
  /** What's shown, and what typing matches. */
  label: string
  icon?: ComponentType<{ className?: string }>
  run: () => void
}

export interface CommandSection {
  value: string
  items: CommandEntry[]
}

const visit = (href: string) => () => router.visit(href)

/**
 * The command menu: a search button in the header that opens it, and ⌘K (Ctrl+K) anywhere. Jump to
 * a page, a setting, switch light and dark, log out. Add your own entries to `sections` below.
 */
export function CommandMenu({ className }: { className?: string }) {
  const [open, setOpen] = useState(false)
  const [mac, setMac] = useState(true)
  useEffect(() => {
    setMac(/Mac|iPhone|iPad/.test(navigator.userAgent))
    const toggle = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        setOpen((value) => !value)
      }
    }
    document.addEventListener('keydown', toggle)
    return () => document.removeEventListener('keydown', toggle)
  }, [])

  const sections: CommandSection[] = [
    { value: 'Pages', items: mainNavItems.map((item) => ({ value: item.href, label: item.title, icon: item.icon, run: visit(item.href) })) },
    { value: 'Settings', items: settingsNavItems.map((item) => ({ value: item.href, label: `${item.title} settings`, icon: Settings, run: visit(item.href) })) },
    {
      value: 'Appearance',
      items: [
        { value: 'light', label: 'Light mode', icon: Sun, run: () => setAppearance('light') },
        { value: 'dark', label: 'Dark mode', icon: Moon, run: () => setAppearance('dark') },
        { value: 'system', label: 'System appearance', icon: Monitor, run: () => setAppearance('system') },
      ],
    },
    {
      value: 'Help',
      items: [
        ...footerNavItems.map((item) => ({ value: item.href, label: item.title, icon: item.icon, run: () => window.open(item.href, '_blank', 'noopener') })),
        { value: 'logout', label: 'Log out', icon: LogOut, run: () => router.post('/logout') },
      ],
    },
  ]

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandDialogTrigger
        render={<Button variant="outline" className={cn('h-8 justify-start gap-2 px-2.5 font-normal text-muted-foreground sm:w-56', className)} aria-label="Search" />}
      >
        <Search />
        <span className="hidden sm:inline">Search</span>
        <kbd className="ms-auto hidden font-sans text-muted-foreground text-xs sm:inline">{mac ? '⌘K' : 'Ctrl K'}</kbd>
      </CommandDialogTrigger>
      <CommandDialogPopup>
        <Command items={sections}>
          <CommandInput placeholder="Search pages and commands…" />
          <CommandPanel>
            <CommandEmpty>Nothing matches.</CommandEmpty>
            <CommandList>
              {(section: CommandSection, index: number) => (
                <Fragment key={section.value}>
                  {index > 0 && <CommandSeparator />}
                  <CommandGroup items={section.items}>
                    <CommandGroupLabel>{section.value}</CommandGroupLabel>
                    <CommandCollection>
                      {(entry: CommandEntry) => (
                        <CommandItem
                          key={entry.value}
                          className="gap-2.5"
                          value={entry}
                          onClick={() => {
                            setOpen(false)
                            entry.run()
                          }}
                        >
                          {entry.icon && <entry.icon className="size-4 text-muted-foreground" />}
                          <span className="flex-1">{entry.label}</span>
                        </CommandItem>
                      )}
                    </CommandCollection>
                  </CommandGroup>
                </Fragment>
              )}
            </CommandList>
          </CommandPanel>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  )
}
