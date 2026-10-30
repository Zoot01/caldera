// Compile-time only: route names and params are typed through the generated router.
import { router } from '../.caldera/routes.gen.js'

export const postUrl: string = router.url('posts.show', { post: 1 })
// @ts-expect-error unknown route name
export const badUrl: string = router.url('posts.missing')
