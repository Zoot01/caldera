import { load } from '@caldera-js/next'
import type { Metadata } from 'next'
import { flash } from '@/lib/caldera'
import { http } from '@/src/http'
import { type Props, Team } from './team'

export const metadata: Metadata = { title: 'Team settings' }

export default async function TeamPage({ params }: { params: Promise<{ team: string }> }) {
  // Not a team of theirs (or not an id): the route answers 404, and so does the page.
  const { team } = await params
  const [props, { status }] = await Promise.all([load<Props>(http, `/settings/teams/${encodeURIComponent(team)}`), flash()])
  // A fresh form for each team (the rename field starts from its name).
  return <Team key={props.team.id} {...props} status={status} />
}
