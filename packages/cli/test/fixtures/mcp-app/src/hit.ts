// Run under the dev preload: requests /posts/boom so the error hook records it.
import { http } from './http.js'

process.loadEnvFile('.env')

const res = await http.request('http://localhost:4100/posts/boom')
console.log(res.status)
