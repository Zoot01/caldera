import { handle } from '@caldera-js/next'
import { http } from '../../../src/http'

// Every /api/* request goes to the Caldera app (src/http.ts): your routes in src/routes, auth, uploads.
export const { GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD } = handle(http)
