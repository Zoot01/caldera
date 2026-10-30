import { Monitor, Moon, Sun } from 'lucide-react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useAppearance, type Appearance } from '@/hooks/use-appearance'

const options = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'system', label: 'System', Icon: Monitor },
] as const

/** Light, dark or system: saved in a cookie, so every page (and the server) knows. */
export function AppearanceTabs({ labels = false }: { labels?: boolean }) {
  const { appearance, setAppearance } = useAppearance()
  return (
    <ToggleGroup
      aria-label="Appearance"
      variant="outline"
      size="sm"
      value={[appearance]}
      // Pressing the selected one again would leave none selected: ignored.
      onValueChange={(values) => values[0] && setAppearance(values[0] as Appearance)}
    >
      {options.map(({ value, label, Icon }) => (
        <ToggleGroupItem key={value} value={value} aria-label={label} title={label}>
          <Icon />
          {labels && label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
