import { load } from '@caldera/next'
import type { Metadata } from 'next'
import { flash } from '@/lib/caldera'
import { http } from '@/src/http'
import { TeamList } from './team-list'

export const metadata: Metadata = { title: 'Teams' }

export default async function Teams() {
  const [{ teamList }, { status }] = await Promise.all([
    load<{ teamList: { id: string; name: string; personal: boolean; role: string; members: number }[] }>(http, '/settings/teams'),
    flash(),
  ])
  return <TeamList teamList={teamList} status={status} />
}
