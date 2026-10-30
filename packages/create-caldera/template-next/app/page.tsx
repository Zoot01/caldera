import type { RequestI18n } from '@caldera/i18n'
import { requestContext, services } from '@caldera/next'
import { app } from '../src/app'
import { User } from '../src/models/user'
import { Hello } from './hello'
import { SignUp } from './sign-up'

// Rendered per request: it reads the database and the visitor's locale.
export const dynamic = 'force-dynamic'

export default async function Home() {
  // Server Components use Caldera directly: models, services, this request's translator.
  await services(app)
  const { i18n } = await requestContext<{ i18n: RequestI18n }>(app)
  const users = await User.findMany()
  return (
    <main>
      <h1>{i18n.t('home.title')}</h1>
      <p>{i18n.t('home.running')}</p>
      <h2>{i18n.t('home.users', { count: users.length })}</h2>
      <ul>
        {users.map((user) => (
          <li key={user.id}>
            {user.name} ({user.email})
          </li>
        ))}
      </ul>
      <SignUp labels={{ name: i18n.t('home.name'), email: i18n.t('home.email'), add: i18n.t('home.add') }} />
      <Hello label={i18n.t('home.from_api')} />
    </main>
  )
}
