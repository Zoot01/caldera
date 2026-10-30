import { defineModel } from '@caldera/db'
import { posts } from '../db/schema.js'

export const Post = defineModel(posts, { name: 'post' })
