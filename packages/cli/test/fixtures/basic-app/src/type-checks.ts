// Compile-time only: these lines type-check only once `.caldera/register.d.ts` exists.
import { app } from './app.js'

export const port: number = app.config.site.port
export const url: string = app.config.database.url
export { postUrl } from './server.js'

// Only types once `caldera generate` registers relations and models.
import Post from './models/post.js'

export async function nestedHidden() {
  const [post] = await Post.findMany({ with: { author: true } })
  const name: string = post!.author.name
  // @ts-expect-error passwordHash is hidden on User, so it's absent from nested results too
  void post!.author.passwordHash
  return name
}

// Only types once `caldera generate` registers the user model and policies.
import { createGate } from '@caldera-js/auth'

export async function gateChecks(post: Awaited<ReturnType<typeof Post.findOrFail>>) {
  const gate = createGate({ user: null })
  const name: string | undefined = gate.user?.name
  // @ts-expect-error passwordHash is hidden, so it's not on the auth user either
  void gate.user?.passwordHash
  // @ts-expect-error not an ability of the post policy
  void (() => gate.can(Post, 'destroy', post))
  return [name, await gate.can(Post, 'update', post)]
}
