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
