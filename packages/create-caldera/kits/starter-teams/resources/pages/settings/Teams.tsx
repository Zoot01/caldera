import { Head, Link, usePage } from '@inertiajs/react'
import { ChevronRight, Plus, Users } from 'lucide-react'
import { useStatusToast } from '@/components/flash-toasts'
import { openNewTeamDialog } from '@/components/new-team-dialog'
import { Section } from '@/components/section'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { avatarColor } from '@/lib/avatar-color'
import { cn } from '@/lib/utils'

type TeamSummary = { id: string; name: string; personal: boolean; role: string; members: number }

const messages: Record<string, string> = { 'team-deleted': 'The team was deleted.', 'team-left': 'You left the team.' }
const roleNames: Record<string, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' }


export default function Teams({ teamList }: { teamList: TeamSummary[] }) {
  const current = usePage().props.teams?.current?.id
  useStatusToast(messages)
  return (
    <>
      <Head title="Teams" />
      <Section
        title="Teams"
        description="The teams you belong to. Switch between them with the team switcher."
        action={
          <Button size="sm" onClick={openNewTeamDialog}>
            <Plus />
            New team
          </Button>
        }
      >
        <ul className="divide-y rounded-lg border">
          {teamList.map((team) => (
            <li key={team.id}>
              <Link href={`/settings/teams/${team.id}`} className="flex items-center gap-3 py-3 ps-3 pe-3 text-sm transition-colors hover:bg-accent/60">
                <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-md border font-medium text-sm', avatarColor(team.name))}>{team.name.trim()[0]?.toUpperCase()}</span>
                <span className="min-w-0 flex-1 truncate font-medium">{team.name}</span>
                {/* What the team is: current, personal (just you, no invitations), or who's in it and your role. */}
                <span className="flex shrink-0 items-center gap-1.5">
                  {team.id === current && <Badge variant="info">Current</Badge>}
                  {team.personal ? (
                    <Badge variant="secondary" title="Just you: personal teams can’t invite anyone">
                      Personal
                    </Badge>
                  ) : (
                    <>
                      <Badge variant="secondary" title={`${team.members} ${team.members === 1 ? 'member' : 'members'}`}>
                        <Users />
                        {team.members}
                      </Badge>
                      <Badge variant="outline">{roleNames[team.role] ?? team.role}</Badge>
                    </>
                  )}
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              </Link>
            </li>
          ))}
        </ul>
      </Section>
    </>
  )
}

Teams.layout = { breadcrumbs: [{ title: 'Teams', href: '/settings/teams' }] }
