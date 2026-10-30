import { channel } from '@caldera/broadcast'
import { defineModel } from '@caldera/db'
import { posts } from '../db/schema.js'

export const Post = defineModel(posts, {
  name: 'post',
  // By pattern: src/channels/posts.ts binds Post, so importing PostChannel here would be a cycle.
  broadcast: { on: (post) => channel('posts.{post}', { post: post.id }), with: (post) => ({ id: post.id, title: post.title }), events: ['updated'] },
})
