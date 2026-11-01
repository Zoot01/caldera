import { defineEvent } from '@caldera-js/events'
import { z } from 'zod'
import { PostChannel } from '../channels/posts.js'

export const PostUpdated = defineEvent({
  name: 'post.updated',
  payload: z.object({ postId: z.number(), title: z.string() }),
  broadcast: { on: (p) => PostChannel.with({ post: p.postId }), with: (p) => ({ title: p.title }) },
})
