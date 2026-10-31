import { Link, router, usePage } from '@inertiajs/react'
import { ArrowRightLeft, Check, ChevronsUpDown, Plus, Settings } from 'lucide-react'
import type { CommandSection } from '@/components/command-menu'
import { NewTeamDialog, openNewTeamDialog } from '@/components/new-team-dialog'
import { Button } from '@/components/ui/button'
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from '@/components/ui/menu'
import { SidebarMenuButton, useSidebar } from '@/components/ui/sidebar'
import { avatarColor } from '@/lib/avatar-color'
import { cn } from '@/lib/utils'

const initial = (name: string) => name.trim().charAt(0).toUpperCase() || '?'

type Teams = NonNullable<ReturnType<typeof usePage>['props']['teams']>
type Team = NonNullable<Teams['current']>

/** The menu's items: switch to another team, open this one's settings, or make a new one. */
function TeamMenuItems({ teams, current }: { teams: Teams; current: Team }) {
  return (
    <>
      <MenuGroup>
        <MenuGroupLabel>Teams</MenuGroupLabel>
        {teams.all.map((team) => (
          <MenuItem key={team.id} onClick={() => team.id !== current.id && router.post('/teams/switch', { teamId: team.id })}>
            <div className={cn('flex size-6 items-center justify-center rounded-sm border font-medium text-xs', avatarColor(team.name))}>{initial(team.name)}</div>
            <span className="flex-1 truncate">{team.name}</span>
            {team.id === current.id && <Check className="ms-auto" />}
          </MenuItem>
        ))}
      </MenuGroup>
      <MenuSeparator />
      <MenuItem render={<Link href={`/settings/teams/${current.id}`} />}>
        <Settings />
        Team settings
      </MenuItem>
      <MenuItem onClick={openNewTeamDialog}>
        <Plus />
        New team
      </MenuItem>
    </>
  )
}

/** The current team, at the top of the sidebar (resources/components/app-sidebar.tsx). */
export function TeamSwitcher() {
  const { teams } = usePage().props
  const { isMobile, state } = useSidebar()
  if (!teams?.current) return null
  const current = teams.current
  return (
    <>
      <Menu>
        <MenuTrigger render={<SidebarMenuButton size="lg" className="data-popup-open:bg-sidebar-accent" aria-label={`Team: ${current.name}`} />}>
          <div className={cn('flex aspect-square size-8 items-center justify-center rounded-md border font-medium text-sm', avatarColor(current.name))}>{initial(current.name)}</div>
          <div className="grid flex-1 text-start text-sm leading-tight">
            <span className="truncate font-semibold">{current.name}</span>
            <span className="truncate text-muted-foreground text-xs">{current.personal ? 'Personal team' : 'Team'}</span>
          </div>
          <ChevronsUpDown className="ms-auto size-4" />
        </MenuTrigger>
        <MenuPopup className="w-60" align="start" side={isMobile ? 'bottom' : state === 'collapsed' ? 'right' : 'bottom'}>
          <TeamMenuItems teams={teams} current={current} />
        </MenuPopup>
      </Menu>
      <NewTeamDialog />
    </>
  )
}

/** The current team, next to the logo in the header layout (resources/components/app-header.tsx). */
export function HeaderTeamSwitcher() {
  const { teams } = usePage().props
  if (!teams?.current) return null
  const current = teams.current
  return (
    <>
      <Menu>
        <MenuTrigger render={<Button variant="ghost" className="h-10 gap-2.5 px-2" aria-label={`Team: ${current.name}`} />}>
          <div className={cn('flex size-7 items-center justify-center rounded-md border font-medium text-sm', avatarColor(current.name))}>{initial(current.name)}</div>
          <span className="max-w-40 truncate font-medium text-sm">{current.name}</span>
          <ChevronsUpDown className="ms-1 size-4 text-muted-foreground" />
        </MenuTrigger>
        <MenuPopup className="w-60" align="start">
          <TeamMenuItems teams={teams} current={current} />
        </MenuPopup>
      </Menu>
      <NewTeamDialog />
    </>
  )
}

/** The command menu's Teams section (resources/components/command-menu.tsx): switch, or make a new one. */
export function useTeamCommands(): CommandSection {
  const { teams } = usePage().props
  return {
    value: 'Teams',
    items: [
      ...(teams?.all ?? [])
        .filter((team) => team.id !== teams?.current?.id)
        .map((team) => ({ value: team.id, label: `Switch to ${team.name}`, icon: ArrowRightLeft, run: () => router.post('/teams/switch', { teamId: team.id }) })),
      { value: 'new', label: 'New team…', icon: Plus, run: openNewTeamDialog },
    ],
  }
}
