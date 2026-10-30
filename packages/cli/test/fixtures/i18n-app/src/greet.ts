import { translator } from '@caldera/i18n'

export const greet = (name: string) => translator().t('posts.greeting', { name })
