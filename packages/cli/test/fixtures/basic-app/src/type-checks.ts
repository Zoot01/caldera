// Compile-time only: these lines type-check only once `.caldera/register.d.ts` exists.
import { app } from './app.js'

export const port: number = app.config.site.port
export const url: string = app.config.database.url
