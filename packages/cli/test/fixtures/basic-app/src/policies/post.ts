import { defineAbility, definePolicy } from '@caldera-js/auth'
import Post from '../models/post.js'

export const PostPolicy = definePolicy(Post, {
  view: { guest: true, check: () => true },
  update: (user, post) => post.authorId === user.id,
})

export const viewStats = defineAbility('viewStats', (user) => user.name.length > 0)
