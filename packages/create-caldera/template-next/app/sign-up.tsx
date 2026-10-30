'use client'

import { useActionState } from 'react'
import { signUp, type SignUpState } from './actions'

/** Labels come translated from the page (a Server Component), so the form needs no catalogue. */
export function SignUp({ labels }: { labels: { name: string; email: string; add: string } }) {
  const [state, action, pending] = useActionState(signUp, {} as SignUpState)
  return (
    <form action={action}>
      <p>
        <input name="name" placeholder={labels.name} aria-label={labels.name} /> <input name="email" placeholder={labels.email} aria-label={labels.email} />{' '}
        <button disabled={pending}>{labels.add}</button>
      </p>
      {state.errors && (
        <ul className="error">
          {Object.entries(state.errors).map(([field, messages]) => (
            <li key={field}>{messages.join(' ')}</li>
          ))}
        </ul>
      )}
      {state.done && <p>{state.message}</p>}
    </form>
  )
}
