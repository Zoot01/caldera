import { usePage } from '@inertiajs/react'

export default function Index({ posts, stats }: { posts: { id: number; title: string }[]; stats?: { total: number } }) {
  // Shared props are typed on the client from src/inertia.ts.
  const { auth, appName } = usePage().props
  const name: string | undefined = auth.user?.name
  const title: string = appName
  return (
    <ul title={`${title} ${name ?? ''} ${stats?.total ?? '…'}`}>
      {posts.map((p) => (
        <li key={p.id}>{p.title}</li>
      ))}
    </ul>
  )
}
