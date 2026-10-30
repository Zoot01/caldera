import { Head, usePage } from '@inertiajs/react'

export default function Home({ message }: { message: string }) {
  const { appName } = usePage().props
  return (
    <main>
      <Head title="Welcome" />
      <h1>{appName}</h1>
      <p>
        {message} Edit <code>resources/pages/Home.tsx</code> and save: the page updates in place.
      </p>
      <p>
        Add a page with <code>caldera make:page Posts/Index</code>, then render it from a route with <code>c.render('Posts/Index', …)</code>.
      </p>
    </main>
  )
}
