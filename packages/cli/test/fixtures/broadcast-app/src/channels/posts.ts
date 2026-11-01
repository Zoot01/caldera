import { defineChannel } from '@caldera-js/broadcast'
import { z } from 'zod'
import { Post } from '../models/post.js'

export const PostChannel = defineChannel('posts.{post}', {
  bind: { post: Post },
  authorize: ({ user, post }) => post.authorId === user.id,
})

export const RoomChannel = defineChannel('rooms.{room}', {
  type: 'presence',
  authorize: () => true,
  member: ({ user }) => ({ id: user.id, name: (user as { name?: string }).name }),
  clientEvents: { typing: z.object({ at: z.number() }) },
})
