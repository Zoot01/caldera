import { Link, router, usePage } from '@inertiajs/react'
import { Check, ChevronsUpDown, Plus, Settings } from 'lucide-react'
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from '@/components/ui/menu'
import { SidebarMenuButton, useSidebar } from '@/components/ui/sidebar'

const initial = (name: string) => name.trim().charAt(0).toUpperCase() || '?'

/** The current team, at the top of the sidebar: switch to another, open its settings, or make a new one. */
export function TeamSwitcher() {
  const { teams } = usePage().props
  const { isMobile, state } = useSidebar()
  if (!teams?.current) return null
  const current = teams.current
  return (
    <Menu>
      <MenuTrigger render={<SidebarMenuButton size="lg" className="data-popup-open:bg-sidebar-accent" />}>
        <div className="flex aspect-square size-8 items-center justify-center rounded-md bg-primary font-semibold text-primary-foreground text-sm">{initial(current.name)}</div>
        <div className="grid flex-1 text-start text-sm leading-tight">
          <span className="truncate font-semibold">{current.name}</span>
          <span className="truncate text-muted-foreground text-xs">{current.personal ? 'Personal team' : 'Team'}</span>
        </div>
        <ChevronsUpDown className="ms-auto size-4" />
      </MenuTrigger>
      <MenuPopup className="w-60" align="start" side={isMobile ? 'bottom' : state === 'collapsed' ? 'right' : 'bottom'}>
        <MenuGroup>
          <MenuGroupLabel>Teams</MenuGroupLabel>
          {teams.all.map((team) => (
            <MenuItem key={team.id} onClick={() => team.id !== current.id && router.post('/teams/switch', { teamId: team.id })}>
              <div className="flex size-6 items-center justify-center rounded-sm border text-xs">{initial(team.name)}</div>
              <span className="truncate">{team.name}</span>
              {team.id === current.id && <Check className="ms-auto" />}
            </MenuItem>
          ))}
        </MenuGroup>
        <MenuSeparator />
        <MenuItem render={<Link href={`/settings/teams/${current.id}`} />}>
          <Settings />
          Team settings
        </MenuItem>
        <MenuItem render={<Link href="/settings/teams" />}>
          <Plus />
          New team
        </MenuItem>
      </MenuPopup>
    </Menu>
  )
}
