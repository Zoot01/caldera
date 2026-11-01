import { translator } from '@caldera-js/i18n'

export const greet = (name: string) => translator().t('posts.greeting', { name })
