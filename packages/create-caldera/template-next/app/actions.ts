'use server'

import { zodErrorMap, type RequestI18n } from '@caldera/i18n'
import { requestContext, services } from '@caldera/next'
import { notify } from '@caldera/notifications'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { app } from '../src/app'
import { User } from '../src/models/user'
import { Welcome } from '../src/notifications/welcome'

const SignUp = z.object({ name: z.string().trim().min(2), email: z.email() })

export interface SignUpState {
  errors?: Record<string, string[]>
  done?: boolean
  message?: string
}

/** A server action using Caldera: validation messages in the visitor's language, a model, a queued notification. */
export async function signUp(_previous: SignUpState, form: FormData): Promise<SignUpState> {
  await services(app)
  const { i18n } = await requestContext<{ i18n: RequestI18n }>(app)
  const parsed = await SignUp.safeParseAsync(Object.fromEntries(form), { error: zodErrorMap(i18n) as never })
  if (!parsed.success) return { errors: z.flattenError(parsed.error).fieldErrors as Record<string, string[]> }
  if (await User.findFirst({ where: { email: parsed.data.email } })) return { errors: { email: [i18n.t('home.email_taken')] } }
  const user = await User.create(parsed.data)
  await notify(user, Welcome, { name: user.name, url: app.config.app.url })
  revalidatePath('/')
  return { done: true, message: i18n.t('home.added') }
}
