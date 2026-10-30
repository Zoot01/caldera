import { defineRelations } from 'drizzle-orm'
import { posts, users } from './schema.js'

export const relations = defineRelations({ users, posts }, (r) => ({
  users: { posts: r.many.posts() },
  posts: { author: r.one.users({ from: r.posts.authorId, to: r.users.id, optional: false }) },
}))
