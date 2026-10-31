import { type KeyboardEvent, useRef } from 'react'
import { useAppearance, type Appearance } from '@/hooks/use-appearance'
import { cn } from '@/lib/utils'

const options = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
] as const

// Fixed colours, not the theme's: the light preview stays light while the app is dark.
const palettes = {
  light: { page: '#f4f4f5', panel: '#ffffff', line: '#e4e4e7', strong: '#a1a1aa', border: '#e4e4e7' },
  dark: { page: '#09090b', panel: '#18181b', line: '#3f3f46', strong: '#71717a', border: '#27272a' },
} as const

/** A tiny drawing of the app in one theme: the header, then a card with text and a button. */
function Preview({ theme }: { theme: keyof typeof palettes }) {
  const c = palettes[theme]
  return (
    <div className="absolute inset-0 flex flex-col gap-2 p-3" style={{ background: c.page }}>
      <div className="flex items-center gap-1.5">
        <div className="size-2.5 rounded-[3px]" style={{ background: c.strong }} />
        <div className="h-1.5 w-8 rounded-full" style={{ background: c.line }} />
        <div className="ms-auto size-2.5 rounded-full" style={{ background: c.line }} />
      </div>
      <div className="flex flex-1 flex-col gap-1.5 rounded-md border p-2.5" style={{ background: c.panel, borderColor: c.border }}>
        <div className="h-1.5 w-12 rounded-full" style={{ background: c.strong }} />
        <div className="h-1.5 w-full rounded-full" style={{ background: c.line }} />
        <div className="h-1.5 w-3/4 rounded-full" style={{ background: c.line }} />
        <div className="mt-auto h-3 w-9 rounded-[3px] bg-[#006cff]" />
      </div>
    </div>
  )
}

/** Light, dark or system, as cards with a preview of each (saved in a cookie, like AppearanceTabs). */
export function AppearancePicker() {
  const { appearance, setAppearance } = useAppearance()
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  // A radio group: arrow keys move between the options and choose.
  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
    if (!step) return
    event.preventDefault()
    const next = (index + step + options.length) % options.length
    setAppearance(options[next]!.value as Appearance)
    buttons.current[next]?.focus()
  }
  return (
    <div role="radiogroup" aria-label="Appearance" className="grid max-w-xl grid-cols-3 gap-4">
      {options.map(({ value, label }, index) => {
        const checked = appearance === value
        return (
          <button
            key={value}
            ref={(el) => {
              buttons.current[index] = el
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => setAppearance(value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className="group flex flex-col gap-2 text-start outline-none"
          >
            <span
              className={cn(
                'relative block aspect-[4/3] w-full overflow-hidden rounded-lg border transition-shadow',
                checked ? 'border-primary ring-2 ring-primary/30' : 'group-hover:border-ring/60',
                'group-focus-visible:ring-2 group-focus-visible:ring-ring',
              )}
            >
              {value === 'system' ? (
                <>
                  <Preview theme="light" />
                  {/* Dark below the diagonal. */}
                  <span className="absolute inset-0 [clip-path:polygon(100%_0,100%_100%,0_100%)]">
                    <Preview theme="dark" />
                  </span>
                </>
              ) : (
                <Preview theme={value} />
              )}
            </span>
            <span className="flex items-center gap-2 text-sm">
              <span className={cn('flex size-4 items-center justify-center rounded-full border', checked && 'border-primary bg-primary')}>
                {checked && <span className="size-1.5 rounded-full bg-primary-foreground" />}
              </span>
              {label}
            </span>
          </button>
        )
      })}
    </div>
  )
}
