import { Head, Link, usePage } from '@inertiajs/react'
import { ChevronRight, Plus } from 'lucide-react'
import { openNewTeamDialog } from '@/components/new-team-dialog'
import { Section } from '@/components/section'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

const messages: Record<string, string> = { 'team-deleted': 'The team was deleted.', 'team-left': 'You left the team.' }

export default function Teams({ teamList }: { teamList: { id: string; name: string; personal: boolean }[] }) {
  const page = usePage()
  const current = page.props.teams?.current?.id
  const status = messages[String(page.flash.status ?? '')]
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
        {status && <p className="text-muted-foreground text-sm">{status}</p>}
        <ul className="divide-y rounded-lg border">
          {teamList.map((team) => (
            <li key={team.id}>
              <Link href={`/settings/teams/${team.id}`} className="flex items-center gap-3 px-4 py-3 text-sm hover:bg-accent">
                <span className="flex-1 truncate font-medium">{team.name}</span>
                {team.personal && <Badge variant="secondary">Personal</Badge>}
                {team.id === current && <Badge variant="outline">Current</Badge>}
                <ChevronRight className="size-4 text-muted-foreground" />
              </Link>
            </li>
          ))}
        </ul>
      </Section>
    </>
  )
}

Teams.layout = { breadcrumbs: [{ title: 'Teams', href: '/settings/teams' }] }
