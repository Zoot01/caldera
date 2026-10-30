import { defineSchedule } from '@caldera/schedule'
import { Stamp } from '../jobs/stamp.js'

export const everyMinute = defineSchedule('stamp.every-minute', { cron: '* * * * *', job: Stamp, payload: { label: 'tick' } })
