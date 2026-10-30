import { defineModel } from '@caldera/db'
import { posts } from '../db/schema.js'

export default defineModel(posts, { name: 'post', routeKey: 'slug', appends: { url: (p) => `/posts/${p.slug}` } })
