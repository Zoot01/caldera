import { Head, Link, useForm, usePage } from '@inertiajs/react'
import { ChevronRight } from 'lucide-react'
import type { FormEvent } from 'react'
import { FormField } from '@/components/form-field'
import { Section } from '@/components/section'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

const messages: Record<string, string> = { 'team-deleted': 'The team was deleted.', 'team-left': 'You left the team.' }

export default function Teams({ teamList }: { teamList: { id: string; name: string; personal: boolean }[] }) {
  const page = usePage()
  const current = page.props.teams?.current?.id
  const status = messages[String(page.flash.status ?? '')]
  const form = useForm({ name: '' })
  const create = (event: FormEvent) => {
    event.preventDefault()
    form.post('/settings/teams')
  }
  return (
    <>
      <Head title="Teams" />
      <Section title="Teams" description="The teams you belong to. Switch between them with the team switcher.">
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
      <Section title="New team" description="You'll be its owner, and it becomes your current team.">
        <form onSubmit={create} className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <div className="flex-1">
            <FormField label="Team name" error={form.errors.name}>
              <Input required value={form.data.name} onChange={(e) => form.setData('name', e.target.value)} placeholder="Acme" />
            </FormField>
          </div>
          <Button type="submit" className="sm:mt-6" loading={form.processing}>
            Create team
          </Button>
        </form>
      </Section>
    </>
  )
}

Teams.layout = { breadcrumbs: [{ title: 'Teams', href: '/settings/teams' }] }
